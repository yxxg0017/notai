import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { classifyPageText, clampPage, pageStateKey } from './helpers';

/** 当前 PDF 选区（text 为空串表示已清空） */
export interface PdfSelection {
  uri: string;
  page: number;
  text: string;
}

/** 浮动工具栏动作（note = 扫描页「手动添加笔记」；Task 6 接线） */
export type ToolbarAction = 'translate' | 'explain' | 'copy' | 'note';

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
    | 'pdf:error';
  pages?: number;
  page?: number;
  text?: string;
  action?: ToolbarAction | NoteAction;
  message?: string;
}

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
 * `error` 存在时 viewer 在 popover 内显示「重试」按钮（重新走 toolbar-action 回传）。
 */
export interface PdfResultMessage {
  type: 'result';
  kind: 'translate' | 'explain';
  /** 源选区文本（viewer 重试时回传） */
  text: string;
  markdown: string;
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
  /** toolbar-action 动作处理器（由 extension.ts 注入，Task 5 接线；note 亦在此路由） */
  private actionHandler: ((action: ToolbarAction, selection: PdfSelection) => void) | undefined;
  /** note-action 处理器（viewer「加笔记/加单词本」→ SelectionActions，Task 6 接线） */
  private noteActionHandler: ((action: NoteAction, selection: PdfSelection) => void) | undefined;
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

  /** 注入浮动工具栏动作处理器（translate/explain/copy/note；Task 5 接线，note 于 Task 6 路由） */
  public setActionHandler(handler: (action: ToolbarAction, selection: PdfSelection) => void): void {
    this.actionHandler = handler;
  }

  /** 注入「加笔记/加单词本」处理器（viewer note-action 消息 → SelectionActions，Task 6 接线） */
  public setNoteActionHandler(
    handler: (action: NoteAction, selection: PdfSelection) => void,
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

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const uri = document.uri;

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
    });

    // ---- 1. 阅读位置：读上次页码作为 initialPage（1..∞ 夹取，具体页数由 viewer 二次夹取）----
    const savedPage = this.context.workspaceState.get<number>(pageStateKey(uri.toString()));
    const initialPage = clampPage(savedPage ?? 1, Number.MAX_SAFE_INTEGER);

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
      this.handleViewerMessage(document, message),
    );
    panel.onDidDispose(() => messageDisposable.dispose());

    // ---- 4. 阅读位置：面板关闭时回写 workspaceState（页码变化时已即时回写）----
    panel.onDidDispose(() => {
      const lastPage = this.lastPageByUri.get(uri.toString()) ?? initialPage;
      void this.context.workspaceState.update(pageStateKey(uri.toString()), lastPage);
      this.output.appendLine(`[pdf] closed ${uri.fsPath} @ page ${lastPage}`);
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
      void panel.webview.postMessage(message);
    };
    const readyDisposable = panel.webview.onDidReceiveMessage((message: ViewerInMessage) => {
      if (message.type !== 'ready') {
        return;
      }
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

  private handleViewerMessage(
    document: vscode.TextDocument,
    message: ViewerInMessage,
  ): void {
    const uri = document.uri.toString();
    switch (message.type) {
      case 'ready':
        // 由 resolveCustomTextEditor 中注册的 ready 监听负责触发 sendOpen；此处 no-op
        break;
      case 'pdf:loaded': {
        this.output.appendLine(`[pdf] loaded ${document.uri.fsPath}: ${message.pages ?? 0} pages`);
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
        // Task 5 接线：翻译/解释/复制交给注入的处理器执行；Task 6 接线：note（扫描页手动笔记）
        const action = message.action;
        if (
          this.actionHandler &&
          (action === 'translate' || action === 'explain' || action === 'copy' || action === 'note') &&
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
          this.noteActionHandler(action, selection);
        }
        break;
      }
      case 'page-change': {
        const page = Math.max(1, message.page ?? 1);
        this.lastPageByUri.set(uri, page);
        void this.context.workspaceState.update(pageStateKey(uri), page);
        break;
      }
      case 'pdf:error': {
        this.output.appendLine(`[pdf] viewer error: ${message.message ?? 'unknown'}`);
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
