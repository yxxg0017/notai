import * as vscode from 'vscode';
import { SecretStore, loadConfig } from './config';
import { DeepSeekProvider } from './core/llm/deepseek';
import { PdfEditorProvider } from './pdf/pdfEditor';
import type { ToolbarAction } from './pdf/pdfEditor';
import { SelectionActions } from './selection/actions';
import type { ShowResultPayload } from './selection/actions';
import { requireSelection } from './selection/prompts';
import { renderSimpleMarkdown } from './util/markdown';

/** 占位命令：后续任务逐个填充实现（与 package.json contributes.commands 保持一致） */
const PLACEHOLDER_COMMANDS: readonly string[] = [
  'aiStudy.addNoteFromSelection',
  'aiStudy.addToWordBook',
];

export function activate(context: vscode.ExtensionContext): void {
  const { subscriptions } = context;

  for (const id of PLACEHOLDER_COMMANDS) {
    subscriptions.push(vscode.commands.registerCommand(id, () => { /* 后续任务填充 */ }));
  }

  const config = loadConfig();

  // PDF 阅读器：Custom Text Editor（选区/阅读位置在 pdfEditor 内实现）
  const pdfProvider = new PdfEditorProvider(context);
  subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, pdfProvider, {
      webviewOptions: { retainContextWhenHidden: true },
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

  /** 编辑器结果面板（单例复用；标题随动作切换） */
  let resultPanel: vscode.WebviewPanel | undefined;
  /** 当前 PDF 动作的渲染上下文（仅由 PDF 工具栏处理器设置，编辑器命令不设置） */
  let pdfTarget: { uri: string; page: number } | undefined;

  const actions = new SelectionActions({
    provider,
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
  });
  // 注：onShowResult 中编辑器/PDF 的路由由 pdfTarget 决定（见 report 中消息流说明），
  // 避免「编辑器命令 + 陈旧 PDF 选区」时误投到 popover。

  /** PDF 浮动工具栏动作入口：设置渲染上下文后执行对应动作 */
  const runPdfAction = async (
    action: Exclude<ToolbarAction, 'note'>,
    selection: { uri: string; page: number; text: string },
  ): Promise<void> => {
    if (action === 'copy') {
      await actions.copy(selection.text);
      void vscode.window.showInformationMessage('已复制');
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
      await vscode.commands.executeCommand('vscode.openWith', target, PdfEditorProvider.viewType);
    })
  );

  subscriptions.push(
    vscode.commands.registerCommand('aiStudy.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        password: true,
        prompt: '输入 DeepSeek API Key',
      });
      if (!apiKey) {
        return;
      }
      await new SecretStore(context.secrets).setApiKey(apiKey);
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