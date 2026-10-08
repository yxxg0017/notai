import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { classifyPageText, clampPage, pageStateKey, pageFromFragment } from './helpers';

/** 当前 PDF 选区（text 为空串表示已清空） */
export interface PdfSelection {
  uri: string;
  page: number;
  text: string;
}

/** 浮动工具栏动作（note = 扫描页「手动添加笔记」；Task 6 接线；search = 「AI 搜索」划词联动，Task 7 接线） */
export type ToolbarAction = 'translate' | 'explain' | 'copy' | 'note' | 'search';

/** 笔记/单词本动作（viewer「加笔记/加单词本」按钮 → note-action 消息） */
export type NoteAction = 'note' | 'wordbook';

/** viewer -> extension 消息 */
interface ViewerInMessage {
  type:
    | 'ready'
    | 'pdf:loaded'
    | 'pdf-selection'
    | 'toolbar-action'
    | 'note-action'
    | 'page-change'
    | 'page-text'
    | 'pdf:error'
    | 'viewer-diag';
  pages?: number;
  page?: number;
  text?: string;
  action?: ToolbarAction | NoteAction;
  /** note-action 随带的本次结果原文（「加笔记/加单词本」上下文，0.3 修复） */
  content?: string;
  message?: string;
}

/** 面板标识（诊断用）：同一 WebviewPanel 对象复用或跨文档重用时保持同一编号 */
const panelIds = new WeakMap<vscode.WebviewPanel, number>();
let panelSeq = 0;
const panelIdOf = (panel: vscode.WebviewPanel): number => {
  let id = panelIds.get(panel);
  if (id === undefined) {
    id = ++panelSeq;
    panelIds.set(panel, id);
  }
  return id;
};

/** extension -> viewer 消息（pdf:open 由本类在收到 ready 后发出） */
interface PdfOpenMessage {
  type: 'pdf:open';
  uri: string;
  fileName: string;
  initialPage: number;
  /** Webview 可 fetch 的 PDF 资源地址（asWebviewUri） */
  src: string;
}

/**
 * extension -> viewer 消息：划词结果（broadcastToPdf 发送）。
 * `markdown` 为 renderSimpleMarkdown 已渲染的安全 HTML 片段，viewer 直接 innerHTML。
 * `content` 为原始 LLM 输出（「加笔记/加单词本」上下文）。
 * `error` 存在时 viewer 在 popover 内显示「重试」按钮（重新走 toolbar-action 回传）。
 */
export interface PdfResultMessage {
  type: 'result';
  kind: 'translate' | 'explain';
  /** 源选区文本（viewer 重试时回传） */
  text: string;
  markdown: string;
  /** 原始 LLM 输出（未渲染；「加笔记/加单词本」随注，0.3 修复） */
  content?: string;
  page: number;
  source: { uri: string; page: number };
  error?: boolean;
}

/**
 * PDF 阅读器 Custom Text Editor。
 *
 * 扩展侧只负责：读取/回写阅读位置（workspaceState）、把 PDF 资源地址与初始页
 * 下发给 viewer、把 viewer 的选区/动作消息转发到事件总线（onPdfSelection），
 * 供后续任务（Task 5 划词动作、Task 6 手动笔记）消费。页面绘制与文本层选择
 * 全部由 media/pdf/ 下的 PDF.js viewer 完成。
 */
export class PdfEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'aiStudy.pdfEditor';

  private readonly onDidChangeSelection = new vscode.EventEmitter<PdfSelection>();
  /** 选区变化/工具栏动作（含 text === '' 的清空事件）；Task 5 消费 */
  public readonly onPdfSelection = this.onDidChangeSelection.event;

  private currentSelection: PdfSelection | undefined;
  /** 每个文档最后看到的页码（关闭面板时回写；键为 uri.toString()） */
  private readonly lastPageByUri = new Map<string, number>();
  /** 已打开的 viewer 面板（键为 uri.toString()；一个文件可开多个面板） */
  private readonly panelsByUri = new Map<string, Set<vscode.WebviewPanel>>();
  /** getCurrentPageText 的挂起请求：key 为 `uri::page`（page 缺省为当前页，见下） */
  private readonly pendingPageText = new Map<string, (text: string | undefined) => void>();
  /** 最近收到互动的文档（getCurrentPageText 无选区时的回退目标；键为 uri.toString()） */
  private lastActiveUri: string | undefined;
  /** toolbar-action 动作处理器（由 extension.ts 注入，Task 5 接线；note 亦在此路由） */
  private actionHandler: ((action: ToolbarAction, selection: PdfSelection) => void) | undefined;
  /** note-action 处理器（viewer「加笔记/加单词本」→ SelectionActions，Task 6 接线） */
  private noteActionHandler:
    | ((action: NoteAction, selection: PdfSelection, content?: string) => void)
    | undefined;
  private readonly output: vscode.OutputChannel;

  public constructor(
    /** 注入 ExtensionContext：阅读位置存于 workspaceState（键见 ./helpers#pageStateKey） */
    private readonly context: vscode.ExtensionContext,
  ) {
    this.output = vscode.window.createOutputChannel('AI 学习助手');
  }

  /** 供外部查询当前选区（Task 5 使用）；无选区时返回 undefined */
  public getCurrentSelection(): PdfSelection | undefined {
    return this.currentSelection;
  }

  /**
   * 读取当前（或指定）PDF 页文本：向目标文档的 viewer 发 `request-page-text`，
   * 3 秒超时兜底返回 undefined（viewer 未加载/加载中/无文本页）。
   * 目标文档 = 当前选区归属文档；无选区时回退最近互动的文档。
   */
  public getCurrentPageText(page?: number): Promise<string | undefined> {
    const uri = this.currentSelection?.uri ?? this.lastActiveUri;
    if (!uri) {
      return Promise.resolve(undefined);
    }
    const panels = this.panelsByUri.get(uri);
    if (!panels || panels.size === 0) {
      return Promise.resolve(undefined);
    }
    const panel = panels.values().next().value as vscode.WebviewPanel;
    return new Promise((resolve) => {
      const key = `${uri}::${page ?? 0}`;
      this.pendingPageText.set(key, resolve);
      void panel.webview.postMessage({ type: 'request-page-text', page });
      // 超时兜底：viewer 未就绪/异常时不悬挂调用方（controller 已 catch 降级为空文本）
      setTimeout(() => {
        const pending = this.pendingPageText.get(key);
        if (pending) {
          this.pendingPageText.delete(key);
          pending(undefined);
        }
      }, 3000);
    });
  }

  /** 注入浮动工具栏动作处理器（translate/explain/copy/note；Task 5 接线，note 于 Task 6 路由） */
  public setActionHandler(handler: (action: ToolbarAction, selection: PdfSelection) => void): void {
    this.actionHandler = handler;
  }

  /** 注入「加笔记/加单词本」处理器（viewer note-action 消息 → SelectionActions，Task 6 接线） */
  public setNoteActionHandler(
    handler: (action: NoteAction, selection: PdfSelection, content?: string) => void,
  ): void {
    this.noteActionHandler = handler;
  }

  /** 向指定文档的所有 viewer 面板广播消息（划词结果回传） */
  public broadcastToPdf(uri: string, msg: PdfResultMessage): void {
    const panels = this.panelsByUri.get(uri);
    if (!panels) {
      return;
    }
    for (const panel of panels) {
      void panel.webview.postMessage(msg);
    }
  }

  /** 诊断追踪：输出通道 + globalStorage/nota-trace.log（排查「打不开/串文档」用） */
  private trace(msg: string): void {
    this.output.appendLine(`[trace] ${msg}`);
    try {
      const file = path.join(this.context.globalStorageUri.fsPath, 'nota-trace.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      /* 追踪日志失败不影响主流程 */
    }
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const uri = document.uri;
    const panelId = panelIdOf(panel);
    this.trace(`resolve panel#${panelId} doc=${uri.fsPath} frag=${uri.fragment || '-'}`);
    // 位置记忆键统一去掉 fragment：回链 `vscode://file/...#page=N` 与正常打开必须命中同一键
    const uriKey = uri.with({ fragment: '' }).toString();

    // 记录面板（broadcastToPdf 用）
    let panels = this.panelsByUri.get(uri.toString());
    if (!panels) {
      panels = new Set<vscode.WebviewPanel>();
      this.panelsByUri.set(uri.toString(), panels);
    }
    panels.add(panel);
    panel.onDidDispose(() => {
      panels.delete(panel);
      if (panels.size === 0) {
        this.panelsByUri.delete(uri.toString());
      }
      // 全部 PDF 面板关闭后清空当前选区，避免「编辑器命令 + 陈旧 PDF 选区」误用
      if (!this.anyPanelOpen()) {
        this.currentSelection = undefined;
      }
    });

    // ---- 1. 阅读位置：回链 #page=N 优先（clamp 后）；否则读上次页码（键已去 fragment）----
    const savedPage = this.context.workspaceState.get<number>(pageStateKey(uriKey));
    const fragmentPage = pageFromFragment(uri.fragment);
    const initialPage = clampPage(
      fragmentPage !== undefined ? fragmentPage : (savedPage ?? 1),
      Number.MAX_SAFE_INTEGER,
    );

    // ---- 2. webview 资源根：viewer 静态资源 + PDF 所在目录（fetch 文件本身需要）----
    const localResourceRoots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf'),
    ];
    if (uri.scheme === 'file') {
      localResourceRoots.push(vscode.Uri.file(path.dirname(uri.fsPath)));
    }
    panel.webview.options = { enableScripts: true, localResourceRoots };

    // ---- 3. viewer -> extension 消息 ----
    const messageDisposable = panel.webview.onDidReceiveMessage((message: ViewerInMessage) =>
      this.handleViewerMessage(document, panelId, message),
    );
    panel.onDidDispose(() => messageDisposable.dispose());

    // ---- 4. 阅读位置：面板关闭时回写 workspaceState（页码变化时已即时回写；键去 fragment）----
    panel.onDidDispose(() => {
      const lastPage = this.lastPageByUri.get(uriKey) ?? initialPage;
      void this.context.workspaceState.update(pageStateKey(uriKey), lastPage);
      this.output.appendLine(`[pdf] closed ${uri.fsPath} @ page ${lastPage}`);
      this.trace(`disposed panel#${panelId} doc=${uri.fsPath}`);
    });

    // ---- 5. 先注册 ready 监听，再设置 HTML，避免 viewer 初始化很快时丢失消息 ----
    let opened = false;
    const sendOpen = (): void => {
      if (opened) {
        return;
      }
      opened = true;
      const message: PdfOpenMessage = {
        type: 'pdf:open',
        uri: uri.toString(),
        fileName: path.basename(uri.fsPath),
        initialPage,
        src: panel.webview.asWebviewUri(uri).toString(),
      };
      this.trace(`sendOpen panel#${panelId} src=...${message.src.slice(-64)} iPage=${initialPage}`);
      void panel.webview.postMessage(message);
    };
    const readyDisposable = panel.webview.onDidReceiveMessage((message: ViewerInMessage) => {
      if (message.type !== 'ready') {
        return;
      }
      this.trace(`ready panel#${panelId}`);
      readyDisposable.dispose();
      sendOpen();
    });
    panel.onDidDispose(() => readyDisposable.dispose());

    panel.webview.html = this.getHtml(panel.webview);

    // 兜底：某些场景监听器建立后 ready 已发出，定时补发一次（opened 守卫保证只发一次）
    const fallback = setTimeout(sendOpen, 1500);
    panel.onDidDispose(() => clearTimeout(fallback));
  }

  public dispose(): void {
    this.onDidChangeSelection.dispose();
    this.output.dispose();
  }

  /** 是否仍有任一已打开的 PDF 面板（全部关闭时用于清空 currentSelection） */
  private anyPanelOpen(): boolean {
    for (const panels of this.panelsByUri.values()) {
      if (panels.size > 0) {
        return true;
      }
    }
    return false;
  }

  private handleViewerMessage(
    document: vscode.TextDocument,
    panelId: number,
    message: ViewerInMessage,
  ): void {
    const uri = document.uri.toString();
    // 任何互动都视为「最近活跃文档」（getCurrentPageText 无选区时的回退目标）
    this.lastActiveUri = uri;
    switch (message.type) {
      case 'ready':
        // 由 resolveCustomTextEditor 中注册的 ready 监听负责触发 sendOpen；此处 no-op
        break;
      case 'pdf:loaded': {
        this.output.appendLine(`[pdf] loaded ${document.uri.fsPath}: ${message.pages ?? 0} pages`);
        this.trace(`loaded panel#${panelId} pages=${message.pages ?? 0}`);
        break;
      }
      case 'pdf-selection': {
        const selection: PdfSelection = {
          uri,
          page: message.page ?? 1,
          text: message.text ?? '',
        };
        this.currentSelection =
          classifyPageText(selection.text) === 'scanned' ? undefined : selection;
        this.onDidChangeSelection.fire(selection);
        break;
      }
      case 'toolbar-action': {
        // 选区（可含空文本；note 由扫描页「手动添加笔记」发出）
        const selection: PdfSelection = {
          uri,
          page: message.page ?? 1,
          text: message.text ?? '',
        };
        if (classifyPageText(selection.text) === 'hasText') {
          this.currentSelection = selection;
        }
        this.onDidChangeSelection.fire(selection);
        this.output.appendLine(
          `[pdf] toolbar-action ${message.action ?? '?'} @p${selection.page} (${selection.text.length} chars)`,
        );
        // Task 5 接线：翻译/解释/复制交给注入的处理器执行；Task 6 接线：note（扫描页手动笔记）；
        // Task 7 接线：search（「AI 搜索」划词联动 → controller.ensureResearchSession）
        const action = message.action;
        if (
          this.actionHandler &&
          (action === 'translate' ||
            action === 'explain' ||
            action === 'copy' ||
            action === 'note' ||
            action === 'search') &&
          (selection.text.trim() !== '' || action === 'note')
        ) {
          this.actionHandler(action, selection);
        }
        break;
      }
      case 'note-action': {
        // viewer「加笔记/加单词本」按钮（popover / 浮动工具栏）→ SelectionActions
        const selection: PdfSelection = {
          uri,
          page: message.page ?? 1,
          text: message.text ?? '',
        };
        this.output.appendLine(
          `[pdf] note-action ${message.action ?? '?'} @p${selection.page} (${selection.text.length} chars)`,
        );
        const action = message.action;
        if (this.noteActionHandler && (action === 'note' || action === 'wordbook')) {
          this.noteActionHandler(action, selection, message.content);
        }
        break;
      }
      case 'page-change': {
        const page = Math.max(1, message.page ?? 1);
        // 与读取处一致：键去掉 fragment（回链 #page=N 打开后翻页仍写回同一键）
        const key = document.uri.with({ fragment: '' }).toString();
        this.lastPageByUri.set(key, page);
        void this.context.workspaceState.update(pageStateKey(key), page);
        break;
      }
      case 'page-text': {
        // 响应 getCurrentPageText 的 request-page-text：回填挂起请求（key 与请求侧一致）
        const key = `${uri}::${message.page ?? 0}`;
        const pending = this.pendingPageText.get(key);
        if (pending) {
          this.pendingPageText.delete(key);
          pending(message.text ?? undefined);
        }
        break;
      }
      case 'pdf:error': {
        this.output.appendLine(`[pdf] viewer error: ${message.message ?? 'unknown'}`);
        this.trace(`error ${message.message ?? 'unknown'}`);
        break;
      }
      case 'viewer-diag': {
        this.trace(`viewer: ${message.message ?? ''}`);
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'viewer.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'viewer.js'));
    // 只允许加载本地资源（media/pdf + PDF 所在目录）；无远程脚本/连接。
    // wasm-unsafe-eval：pdf.js 的 JPEG2000/JBIG2 解码器使用 WebAssembly。
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} blob: data:`,
      `connect-src ${webview.cspSource} blob: data:`,
      `worker-src ${webview.cspSource} blob:`,
      `base-uri 'none'`,
      `form-action 'none'`,
    ].join('; ');
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'viewer.html').fsPath;
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const inject = (template: string, token: string, value: string): string =>
      template.split(token).join(value);
    return inject(inject(inject(raw, '{{CSP}}', csp), '{{VIEWER_CSS}}', cssUri.toString()), '{{VIEWER_JS}}', jsUri.toString());
  }
}
