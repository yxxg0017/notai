import * as vscode from 'vscode';
import { SecretStore } from './config';

/** 占位命令：后续任务逐个填充实现（与 package.json contributes.commands 保持一致） */
const PLACEHOLDER_COMMANDS: readonly string[] = [
  'aiStudy.openPdf',
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
