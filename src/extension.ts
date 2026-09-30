import * as vscode from 'vscode';
import { SecretStore } from './config';
import { PdfEditorProvider } from './pdf/pdfEditor';

/** 占位命令：后续任务逐个填充实现（与 package.json contributes.commands 保持一致） */
const PLACEHOLDER_COMMANDS: readonly string[] = [
  'aiStudy.translateSelection',
  'aiStudy.explainSelection',
  'aiStudy.copySelection',
  'aiStudy.addNoteFromSelection',
  'aiStudy.addToWordBook',
];

export function activate(context: vscode.ExtensionContext): void {
  const { subscriptions } = context;

  for (const id of PLACEHOLDER_COMMANDS) {
    subscriptions.push(vscode.commands.registerCommand(id, () => { /* 后续任务填充 */ }));
  }

  // PDF 阅读器：Custom Text Editor（选区/阅读位置在 pdfEditor 内实现）
  const pdfProvider = new PdfEditorProvider(context);
  subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, pdfProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    pdfProvider
  );

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

export function deactivate(): void {
  // 无资源需要释放
}
