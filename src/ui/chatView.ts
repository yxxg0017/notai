/**
 * Harness chat 视图（`aiStudy.chatPanel`）与消息桥 Sink。
 *
 * 职责：
 * - HarnessSink：controller 的 postToChat 落点。chat 视图未 resolve 时缓冲
 *   UiOut（防「划词联动建会话」先于视图创建导致流式增量丢失），resolve 后按序 flush。
 * - createChatView：注册 webview view，装配 `src/ui/media/chat.html`（CSS/JS 换
 *   asWebviewUri 资源路径、注入 CSP 与 `__NOTA_VIEW__='chat'` 视图标识），
 *   转发 UiIn 到 controller.handleUiIn，加载完成后主动推送 init（Task 6 评审）。
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { ChatController } from './chatController';
import type { UiIn, UiOut } from './protocol';

/** 视图标识（与 src/ui/media/chat.js 的 boot 读取约定一致） */
export type HarnessView = 'session' | 'chat';

/** 静态资源根目录（相对扩展根；与 package.json 装配的 view 共用 chat.html） */
export const HARNESS_MEDIA_DIR = ['src', 'ui', 'media'];

/**
 * UiOut 消息桥：controller 的 postToChat 落点。
 * - `init`（会话列表全量刷新）**多播**到 session + chat 两个视图：修复评审发现项
 *   「session 视图内 ＋新对话 → focusChat 只切换 chat 视图可见性、不触发 session 视图
 *   onDidChangeVisibility，新会话在列表中不出现」；
 * - 其余消息（conversation/delta/finalize/toolLifecycle/error/confirmRequest/…）仅投
 *   chat 视图；chat 视图未 resolve 时缓冲（防「划词联动建会话」先于视图创建导致流式
 *   增量丢失），resolve 后按序 flush。单线程保证：flush 只会发生在 setChatView 时刻。
 */
export class HarnessSink {
  private sessionView: vscode.WebviewView | undefined;
  private chatView: vscode.WebviewView | undefined;
  private buffer: UiOut[] = [];
  /** 未 resolve 期间缓冲上限，防极端场景无限增长（init 全量刷新兜底） */
  private static readonly BUFFER_MAX = 200;

  /** session 视图 resolve/dispose 时由 createSessionView 回调（init 多播目标） */
  setSessionView(view: vscode.WebviewView | undefined): void {
    this.sessionView = view;
  }

  /** chat 视图 resolve/dispose 时由 createChatView 回调；set 时先 flush 缓冲 */
  setChatView(view: vscode.WebviewView | undefined): void {
    this.chatView = view;
    if (!view) {
      return;
    }
    const queued = this.buffer;
    this.buffer = [];
    for (const msg of queued) {
      void view.webview.postMessage(msg);
    }
  }

  /**
   * 推送 UiOut：init 广播到 session + chat 两个视图（session 未 resolve 时跳过——
   * 其 resolve/可见时已自行拉取 init）；其余消息仅发 chat 视图，未 resolve 时缓冲。
   */
  post(msg: UiOut): void {
    if (msg.type === 'init' && this.sessionView) {
      void this.sessionView.webview.postMessage(msg);
    }
    if (this.chatView) {
      void this.chatView.webview.postMessage(msg);
      return;
    }
    if (this.buffer.length >= HarnessSink.BUFFER_MAX) {
      this.buffer.shift(); // 丢弃最旧，保最新
    }
    this.buffer.push(msg);
  }
}

/** 随机 nonce（CSP 放行注入的 `window.__NOTA_VIEW__` 内联脚本） */
function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * 读取 `src/ui/media/chat.html` 并做 webview 装配：
 * - CSS/JS 换成 webview.asWebviewUri 资源路径
 * - 注入 CSP（参照 pdfEditor.ts getHtml 模式：仅放行本地资源）
 * - 注入 `<script nonce>window.__NOTA_VIEW__='<view>'</script>`（chat.js boot 读取视图标识）
 */
export function chatHtml(context: vscode.ExtensionContext, webview: vscode.Webview, view: HarnessView): string {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, ...HARNESS_MEDIA_DIR);
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const htmlPath = vscode.Uri.joinPath(mediaRoot, 'chat.html').fsPath;
  const raw = fs.readFileSync(htmlPath, 'utf8');
  // 注入 CSP 到 <head> 首行、视图标识内联脚本到 <body> 首行（均须先于 chat.js 求值）
  return raw
    .replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<body>', `<body>\n<script nonce="${nonce}">window.__NOTA_VIEW__ = ${JSON.stringify(view)};</script>`)
    .replace('href="chat.css"', `href="${cssUri.toString()}"`)
    .replace('src="chat.js"', `src="${jsUri.toString()}"`);
}

/** chat 视图 localResourceRoots（webview 仅可加载 media 目录内资源） */
export function harnessLocalRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  return [vscode.Uri.joinPath(context.extensionUri, ...HARNESS_MEDIA_DIR)];
}

/**
 * 注册 `aiStudy.chatPanel` webview view（`retainContextWhenHidden: true`：
 * 隐藏时保留上下文，流式回复跨视图切换不丢状态）。
 */
export function createChatView(
  context: vscode.ExtensionContext,
  controller: ChatController,
  sink: HarnessSink,
): vscode.Disposable {
  return vscode.window.registerWebviewViewProvider(
    'aiStudy.chatPanel',
    {
      resolveWebviewView(webviewView: vscode.WebviewView): void {
        sink.setChatView(webviewView);
        const view = webviewView;
        view.webview.options = {
          enableScripts: true,
          localResourceRoots: harnessLocalRoots(context),
        };
        view.webview.html = chatHtml(context, view.webview, 'chat');
        view.onDidDispose(() => sink.setChatView(undefined));
        view.webview.onDidReceiveMessage((msg: unknown) => {
          void controller.handleUiIn(msg as UiIn).catch((err) => {
            console.error('[nota] chat handleUiIn 失败:', err);
          });
        });
        // init 由扩展侧在视图加载完成后主动推送（前端 ready 消息保留不强求，Task 6 评审）
        void controller
          .buildInitPayload()
          .then((m) => view.webview.postMessage(m))
          .catch(() => {
            /* init 失败不影响视图挂载 */
          });
      },
    },
    { webviewOptions: { retainContextWhenHidden: true } },
  );
}