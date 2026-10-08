import * as vscode from 'vscode';
import * as path from 'node:path';
import { SecretStore, loadConfig } from './config';
import { DeepSeekProvider } from './core/llm/deepseek';
import { chatWithRetry } from './core/llm/retry';
import type { LLMProvider } from './core/llm/types';
import { ConversationStore } from './core/agent/store';
import { PdfEditorProvider } from './pdf/pdfEditor';
import type { ToolbarAction, NoteAction, PdfSelection } from './pdf/pdfEditor';
import { SelectionActions } from './selection/actions';
import type { ShowResultPayload } from './selection/actions';
import { requireSelection } from './selection/prompts';
import { renderSimpleMarkdown } from './util/markdown';
import { NoteService } from './notes/noteService';
import type { SourceInfo } from './notes/noteService';
import { WordBook } from './notes/wordbook';
import { ChatController } from './ui/chatController';
import { createHarnessViews } from './ui/sessionView';
import { HarnessSink } from './ui/chatView';

export function activate(context: vscode.ExtensionContext): void {
  const { subscriptions } = context;

  const config = loadConfig();

  // PDF 阅读器：Custom Text Editor（选区/阅读位置在 pdfEditor 内实现）。
  // 不设 retainContextWhenHidden：默认行为下重载窗口不会触发 VS Code 对
  // 自定义编辑器 webview 的 tryRevive（其 createModelReference 会把二进制
  // PDF 当文本读取而弹 "Unable to open ... binary" 错误框）
  const pdfProvider = new PdfEditorProvider(context);
  subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, pdfProvider, {
      webviewOptions: {},
    }),
    pdfProvider
  );

  // ---- 划词动作：LLM 客户端 + 结果展示（编辑器结果面板 / PDF popover） ----
  const secrets = new SecretStore(context.secrets);
  const provider = new DeepSeekProvider(
    () => secrets.getApiKey(),
    config.baseUrl,
    config.model,
  );
  /**
   * 装饰器式包装：所有 LLM 调用（ChatController 的 runTurn 与 SelectionActions 的
   * 划词翻译/解释）统一走 429 指数退避重试；provider 内部（loop.ts/actions.ts）不改。
   */
  const retryProvider: LLMProvider = {
    ...provider,
    chat: (req) => chatWithRetry(provider, req),
  };
  /** 笔记服务（划词动作与 Harness 控制器共用同一实例，notesRoot 同源） */
  const notes = new NoteService(config.notesRoot);

  // ---- Harness：会话存储 + ChatController + 侧边栏两个 webview view（Task 7 装配） ----
  const store = new ConversationStore(
    path.join(context.globalStorageUri.fsPath, 'conversations'),
  );
  /** UiOut 消息桥：chat 视图未 resolve 时缓冲，resolve 后按序 flush（见 src/ui/chatView.ts） */
  const harnessSink = new HarnessSink();
  const controller = new ChatController({
    store,
    provider: retryProvider,
    config,
    notes,
    // webSearchKey 接 SecretStore（Task 9 接线；无 Key 时 controller 侧降级为仅本地检索）
    getSecrets: async () => ({
      apiKey: await secrets.getApiKey(),
      webSearchKey: await secrets.getWebSearchKey(),
    }),
    postToChat: (msg) => harnessSink.post(msg),
    focusChat: () => {
      void vscode.commands.executeCommand('aiStudy.chatPanel.focus');
    },
    readPdfSelection: () => pdfProvider.getCurrentSelection(),
    readPdfPageText: (page) => pdfProvider.getCurrentPageText(page),
    workspace: {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      untrusted: !vscode.workspace.isTrusted,
      enabled: config.enableWorkspaceWrite,
    },
  });
  // 注册 aiStudy.sessionList / aiStudy.chatPanel 两个 webview view
  createHarnessViews(context, controller, harnessSink);

  /** 编辑器结果面板（单例复用；标题随动作切换） */
  let resultPanel: vscode.WebviewPanel | undefined;
  /** 当前 PDF 动作的渲染上下文（仅由 PDF 工具栏处理器设置，编辑器命令不设置） */
  let pdfTarget: { uri: string; page: number } | undefined;

  const actions = new SelectionActions({
    provider: retryProvider,
    config,
    getPdfSelection: () => pdfProvider.getCurrentSelection(),
    onShowResult: (payload: ShowResultPayload) => {
      if (pdfTarget) {
        // PDF 场景：结果回传 viewer popover
        const { uri, page } = pdfTarget;
        void pdfProvider.broadcastToPdf(uri, {
          type: 'result',
          kind: payload.kind,
          text: payload.text,
          markdown: payload.markdown,
          page,
          source: { uri, page },
          ...(payload.error !== undefined ? { error: true } : {}),
        });
        return;
      }
      // 编辑器场景：结果面板
      showEditorResultPanel(payload);
    },
    noteService: notes,
    wordBook: new WordBook(config.notesRoot),
  });
  // 注：onShowResult 中编辑器/PDF 的路由由 pdfTarget 决定（见 report 中消息流说明），
  // 避免「编辑器命令 + 陈旧 PDF 选区」时误投到 popover。

  /** 由 PDF 选区构造笔记来源信息（page 始终携带；text 非空时作为 quote） */
  const pdfSourceFor = (selection: PdfSelection): SourceInfo => {
    const fsPath = vscode.Uri.parse(selection.uri).fsPath;
    return {
      displayName: path.basename(fsPath),
      sourcePath: fsPath,
      sourceType: 'pdf',
      page: selection.page,
      ...(selection.text ? { quote: selection.text } : {}),
    };
  };

  /** 「加笔记/加单词本」入口（viewer note-action / 扫描页手动笔记 / 编辑器命令共用） */
  const runNoteAction = async (
    action: NoteAction,
    selection: PdfSelection,
  ): Promise<void> => {
    const source = pdfSourceFor(selection);
    try {
      if (action === 'note') {
        await actions.addNote(selection.text, source);
      } else {
        await actions.addToWordBook(selection.text, source);
      }
    } catch (err) {
      // 与 translate/explain 分支及编辑器路径一致：notesRoot 不可写等 FS 错误兜底为错误卡
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `添加${action === 'note' ? '笔记' : '单词本'}失败: ${message}`,
      );
    }
  };
  pdfProvider.setNoteActionHandler((action, selection) => {
    void runNoteAction(action, selection);
  });

  /** PDF 浮动工具栏动作入口：设置渲染上下文后执行对应动作 */
  const runPdfAction = async (
    action: ToolbarAction,
    selection: { uri: string; page: number; text: string },
  ): Promise<void> => {
    if (action === 'copy') {
      await actions.copy(selection.text);
      void vscode.window.showInformationMessage('已复制');
      return;
    }
    if (action === 'note') {
      // 扫描页「手动添加笔记」（text 为空，仅携带页码）
      await runNoteAction('note', selection);
      return;
    }
    if (action === 'search') {
      // 「AI 搜索」划词联动：复用最近 research 会话或新建，发送并聚焦 chat 视图（Task 7）
      try {
        await controller.ensureResearchSession(selection.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`AI 搜索失败: ${message}`);
      }
      return;
    }
    if (action === 'explain' && config.explainTarget === 'conversation') {
      // explainTarget=conversation：「解释」改走 Harness 对话（复用/新建 chat 会话并发送）
      try {
        await controller.explainToConversation(selection.text, pdfSourceFor(selection));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`解释失败: ${message}`);
      }
      return;
    }
    pdfTarget = { uri: selection.uri, page: selection.page };
    try {
      await actions[action](selection.text);
    } catch {
      // 动作内部已以错误卡/提示兜底；此处仅防未捕获异常
    } finally {
      pdfTarget = undefined;
    }
  };
  pdfProvider.setActionHandler((action, selection) => {
    void runPdfAction(action, selection);
  });

  // ---- 编辑器划词命令：编辑器选区优先，其次 PDF 当前选区 ----
  const registerSelectionCommand = (
    id: 'aiStudy.translateSelection' | 'aiStudy.explainSelection' | 'aiStudy.copySelection',
  ): void => {
    subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          const editor = vscode.window.activeTextEditor;
          const editorText =
            editor && !editor.selection.isEmpty
              ? editor.document.getText(editor.selection)
              : undefined;
          const text = requireSelection(editorText ?? pdfProvider.getCurrentSelection()?.text);
          if (id === 'aiStudy.copySelection') {
            await actions.copy(text);
            void vscode.window.showInformationMessage('已复制');
            return;
          }
          if (id === 'aiStudy.explainSelection' && config.explainTarget === 'conversation') {
            // Task 7：explainTarget=conversation ——「解释」改走 Harness 对话（复用/新建 chat 会话）
            const { text: srcText, source } = resolveSelectionSource();
            await controller.explainToConversation(srcText, source);
            return;
          }
          await (id === 'aiStudy.translateSelection'
            ? actions.translate(text)
            : actions.explain(text));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === '请先选中文本') {
            void vscode.window.showWarningMessage('请先选中文本');
          } else {
            void vscode.window.showErrorMessage(message);
          }
        }
      }),
    );
  };
  registerSelectionCommand('aiStudy.translateSelection');
  registerSelectionCommand('aiStudy.explainSelection');
  registerSelectionCommand('aiStudy.copySelection');

  /** 取当前选区文本与来源信息（编辑器非空选区优先；否则 PDF 当前选区）；无选区抛「请先选中文本」 */
  const resolveSelectionSource = (): { text: string; source: SourceInfo } => {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      const text = editor.document.getText(editor.selection);
      const fsPath = editor.document.uri.fsPath;
      return {
        text,
        source: {
          displayName: path.basename(fsPath),
          sourcePath: fsPath,
          sourceType: 'editor',
        },
      };
    }
    const sel = pdfProvider.getCurrentSelection();
    if (sel) {
      return { text: sel.text, source: pdfSourceFor(sel) };
    }
    throw new Error('请先选中文本');
  };

  // ---- 加笔记 / 加单词本命令（编辑器右键与命令面板；PDF 场景走 note-action 消息） ----
  const registerNoteCommand = (
    id: 'aiStudy.addNoteFromSelection' | 'aiStudy.addToWordBook',
  ): void => {
    subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          const { text, source } = resolveSelectionSource();
          if (id === 'aiStudy.addNoteFromSelection') {
            await actions.addNote(text, source);
          } else {
            await actions.addToWordBook(text, source);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === '请先选中文本') {
            void vscode.window.showWarningMessage('请先选中文本');
          } else {
            void vscode.window.showErrorMessage(message);
          }
        }
      }),
    );
  };
  registerNoteCommand('aiStudy.addNoteFromSelection');
  registerNoteCommand('aiStudy.addToWordBook');

  // ---- 「打开单词本」：确保文件存在并打开（侧边栏会话视图卡片 / 命令面板，0.3） ----
  subscriptions.push(
    vscode.commands.registerCommand('aiStudy.openWordBook', async () => {
      try {
        const p = await new WordBook(config.notesRoot).ensure();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`打开单词本失败: ${message}`);
      }
    }),
  );

  // ---- 「AI 搜索」命令：编辑器选中文本（共享 PDF 工具栏的 search 动作；Task 7） ----
  subscriptions.push(
    vscode.commands.registerCommand('aiStudy.newResearchSession', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        const editorText =
          editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : undefined;
        // 与选区命令一致：编辑器选区优先，其次 PDF 当前选区
        const text = requireSelection(editorText ?? pdfProvider.getCurrentSelection()?.text);
        await controller.ensureResearchSession(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === '请先选中文本') {
          void vscode.window.showWarningMessage('请先选中文本');
        } else {
          void vscode.window.showErrorMessage(message);
        }
      }
    }),
  );

  /** 编辑器结果面板：流式/错误卡均渲染 renderSimpleMarkdown 输出；错误时提供原生「重试」 */
  function showEditorResultPanel(payload: ShowResultPayload): void {
    const title = payload.kind === 'translate' ? 'AI 学习: 翻译结果' : 'AI 学习: 解释结果';
    if (!resultPanel) {
      resultPanel = vscode.window.createWebviewPanel(
        'aiStudy.result',
        title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        { enableScripts: false },
      );
      resultPanel.onDidDispose(() => {
        resultPanel = undefined;
      });
    } else {
      resultPanel.title = title;
    }
    resultPanel.webview.html = resultHtml(payload.markdown);
    if (payload.error !== undefined) {
      // 面板禁用脚本，错误卡的可点击「重试」以原生按钮承载
      void vscode.window
        .showWarningMessage(payload.error, '重试')
        .then((pick) => {
          if (pick === '重试') {
            payload.retry();
          }
        });
    }
  }

  subscriptions.push(
    vscode.commands.registerCommand('aiStudy.openPdf', async (uri?: vscode.Uri) => {
      let target = uri;
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'PDF 文档': ['pdf'] },
        });
        if (!picked || picked.length === 0) {
          return;
        }
        target = picked[0];
      }
      // preview: false —— 每个 PDF 独立非预览标签页；避免 VS Code 预览式复用自定义编辑器面板
      // 时面板未重新 resolve（旧文档内容残留 / 新文档无内容），见 PDF 追踪日志
      await vscode.commands.executeCommand('vscode.openWith', target, PdfEditorProvider.viewType, {
        preview: false,
      });
    })
  );

  subscriptions.push(
    vscode.commands.registerCommand('aiStudy.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        password: true,
        prompt: '输入 DeepSeek API Key',
      });
      if (!apiKey || !apiKey.trim()) {
        // 空白输入视为取消（提示语不变）
        return;
      }
      await new SecretStore(context.secrets).setApiKey(apiKey.trim());
      void vscode.window.showInformationMessage('API Key 已保存');
    })
  );
}

/** 结果面板 HTML：无脚本；内容为 renderSimpleMarkdown 输出（已转义） */
function resultHtml(markdown: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; line-height: 1.6;
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         padding: 12px 16px; word-wrap: break-word; }
  p { margin: 0 0 8px; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
         background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
         padding: 1px 4px; border-radius: 3px; }
  a { color: var(--vscode-textLink-foreground); }
  strong { font-weight: 600; }
</style>
</head>
<body>${markdown}</body>
</html>`;
}

export function deactivate(): void {
  // 无资源需要释放
}