/**
 * Harness 前端 webview 消息协议（纯类型，无运行时代码）。
 *
 * 方向约定：
 * - UiIn：webview → 扩展侧（window.acquireVsCodeApi().postMessage）
 * - UiOut：扩展侧 → webview（webview.postMessage）
 *
 * 类型出处说明（勿凭空猜测）：
 * - ConversationMode/Conversation/ConversationMeta：src/core/agent/types.ts
 * - Delta：src/core/llm/types.ts（agent/types.ts 未转发该类型，按真实出处导入）
 * - WorkspaceProposal：src/core/tools/context.ts（readTools.ts 未转发该类型）
 */
import type { ConversationMode, Conversation, ConversationMeta } from '../core/agent/types';
import type { Delta } from '../core/llm/types';
import type { WorkspaceProposal } from '../core/tools/context';

/** 用户输入附件：file/image/pdfPage 的 content 为扩展侧读取后的内容（或资源引用） */
export type UiAttachment = {
  kind: 'text' | 'file' | 'image' | 'selection' | 'pdfPage';
  name: string;
  content?: string;
};

/** init 会话元数据：ConversationMeta 基础上补 model 字段（前端模型选择器精确回显，Task 7 增补） */
export type SessionMeta = ConversationMeta & { model?: string };

/** webview → 扩展侧的消息 */
export type UiIn =
  | { type: 'ready' }
  | { type: 'openSettings' }
  | { type: 'newConversation'; mode: ConversationMode; model: string; skillIds: string[] }
  | { type: 'send'; conversationId: string; text: string; attachments: UiAttachment[] }
  | { type: 'abort'; conversationId: string }
  | { type: 'openConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'renameConversation'; id: string; title: string }
  | { type: 'setMode'; conversationId: string; mode: ConversationMode }
  | { type: 'setModel'; conversationId: string; model: string }
  | { type: 'toggleSkill'; conversationId: string; skillId: string }
  | { type: 'confirmWorkspace'; conversationId: string; accept: boolean }
  | { type: 'saveAsNote'; conversationId: string; text: string; source?: string }
  | { type: 'retry'; conversationId: string }
  | { type: 'requestPageText' }
  | { type: 'pickAttachment' }
  // openNote：Task 9 已接线（controller 打开笔记、前端 noteSaved 的 [打开笔记] 按钮发送）
  | { type: 'openNote'; path: string }
  /** 侧边栏「打开单词本」：扩展侧确保文件存在并打开（0.3） */
  | { type: 'openWordBook' }
  /** 消息悬浮栏 Fork：以该条 assistant 消息为终点派生新会话（历史含该条，原会话不动） */
  | { type: 'fork'; conversationId: string; messageTs: number }
  /** 消息悬浮栏回溯：截断到该条 user 消息（含）并自动重发该条（附件不重发） */
  | { type: 'rewind'; conversationId: string; messageTs: number };

/** 扩展侧 → webview 的消息 */
export type UiOut =
  | {
      type: 'init';
      sessions: SessionMeta[];
      models: string[];
      skills: { id: string; displayName: string; description: string; defaultOn: boolean; icon?: string }[];
      webSearchAvailable: boolean;
      workspaceWriteEnabled: boolean;
      /** 未信任工作区：前端在输入区上方显示「受限工作区」提示条（true 显示，init 重推时更新） */
      untrustedWorkspace: boolean;
    }
  | { type: 'conversation'; conv: Conversation }
  | { type: 'delta'; conversationId: string; delta: Delta }
  /** ts：该条 assistant 消息时间戳（悬浮栏 Fork 定位用，0.3 增补） */
  | { type: 'finalize'; conversationId: string; messageId: string; ts: number; html: string }
  | { type: 'toolLifecycle'; conversationId: string; callId: string; name: string; status: 'running' | 'done' | 'error'; result?: string }
  | { type: 'error'; conversationId: string; kind: string; message: string; retryable: boolean }
  | { type: 'confirmRequest'; conversationId: string; proposal: WorkspaceProposal }
  | { type: 'confirmResolved'; conversationId: string; accepted: boolean }
  | { type: 'noteSaved'; path: string; created: boolean }
  | { type: 'pageText'; text: string }
  | { type: 'attachmentPicked'; attachment: UiAttachment | undefined };
