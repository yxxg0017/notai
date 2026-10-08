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
  | { type: 'openNote'; path: string };

/** 扩展侧 → webview 的消息 */
export type UiOut =
  | {
      type: 'init';
      sessions: SessionMeta[];
      models: string[];
      skills: { id: string; displayName: string; description: string; defaultOn: boolean; icon?: string }[];
      webSearchAvailable: boolean;
      workspaceWriteEnabled: boolean;
    }
  | { type: 'conversation'; conv: Conversation }
  | { type: 'delta'; conversationId: string; delta: Delta }
  | { type: 'finalize'; conversationId: string; messageId: string; html: string }
  | { type: 'toolLifecycle'; conversationId: string; callId: string; name: string; status: 'running' | 'done' | 'error'; result?: string }
  | { type: 'error'; conversationId: string; kind: string; message: string; retryable: boolean }
  | { type: 'confirmRequest'; conversationId: string; proposal: WorkspaceProposal }
  | { type: 'confirmResolved'; conversationId: string; accepted: boolean }
  | { type: 'noteSaved'; path: string; created: boolean }
  | { type: 'pageText'; text: string }
  | { type: 'attachmentPicked'; attachment: UiAttachment | undefined };
