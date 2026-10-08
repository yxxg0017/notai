/**
 * Harness session 视图（`aiStudy.sessionList`）与视图总装配入口。
 *
 * 职责：
 * - createSessionView：注册 webview view，装配与 chat 视图同一份
 *   `out/ui/media/chat.html`（`__NOTA_VIEW__='session'`），转发 UiIn 到
 *   controller.handleUiIn；视图重新可见时重推 init 刷新会话列表
 *   （重命名/删除/新建可能发生在 chat 视图侧，session 视图需与 store 对齐）。
 * - createHarnessViews：装配入口——注册 session + chat 两个 view，
 *   共享同一个 HarnessSink（controller 的 postToChat 落点）。
 */
import * as vscode from 'vscode';
import type { ChatController } from './chatController';
import type { UiIn } from './protocol';
import { chatHtml, createChatView, harnessLocalRoots, HarnessSink } from './chatView';

/**
 * 注册 `aiStudy.sessionList` webview view（`retainContextWhenHidden: true`）。
 * 会话创建/删除在 session 视图内完成；sink 多播的 init 负责即时刷新列表，
 * 视图每次可见时再兜底刷新一次（隐藏期间 store 也可能变化）。
 */
export function createSessionView(
  context: vscode.ExtensionContext,
  controller: ChatController,
  sink: HarnessSink,
): vscode.Disposable {
  return vscode.window.registerWebviewViewProvider(
    'aiStudy.sessionList',
    {
      resolveWebviewView(webviewView: vscode.WebviewView): void {
        sink.setSessionView(webviewView);
        const view = webviewView;
        view.webview.options = {
          enableScripts: true,
          localResourceRoots: harnessLocalRoots(context),
        };
        view.webview.html = chatHtml(context, view.webview, 'session');
        view.onDidDispose(() => sink.setSessionView(undefined));
        view.webview.onDidReceiveMessage((msg: unknown) => {
          void controller.handleUiIn(msg as UiIn).catch((err) => {
            console.error('[nota] session handleUiIn 失败:', err);
          });
        });
        // init 由扩展侧在视图加载完成后主动推送（前端 ready 消息保留不强求，Task 6 评审）
        void controller
          .buildInitPayload()
          .then((m) => view.webview.postMessage(m))
          .catch(() => {
            /* init 失败不影响视图挂载 */
          });
        // 重新可见时刷新会话列表（隐藏期间 store 可能变化：chat 视图重命名/新对话等）
        view.onDidChangeVisibility(() => {
          if (view.visible) {
            void controller
              .buildInitPayload()
              .then((m) => view.webview.postMessage(m))
              .catch(() => {
                /* 刷新失败静默 */
              });
          }
        });
      },
    },
    { webviewOptions: { retainContextWhenHidden: true } },
  );
}

/**
 * Harness 总装配：注册 session + chat 两个 webview view，共享 sink。
 * controller 构造时需把 `postToChat` 接到同一 sink（见 extension.ts）。
 */
export function createHarnessViews(
  context: vscode.ExtensionContext,
  controller: ChatController,
  sink: HarnessSink,
): void {
  context.subscriptions.push(createSessionView(context, controller, sink));
  context.subscriptions.push(createChatView(context, controller, sink));
}
