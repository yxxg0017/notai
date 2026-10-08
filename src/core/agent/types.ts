/**
 * 纯 Agent 会话层类型定义。
 *
 * 全局约束：本目录（src/core/agent/）禁止 `import 'vscode'` —— 这些模块需要在
 * node:test 环境下直接运行（无 VS Code 运行时），只允许 node 内建模块与全局 fetch。
 */
import { ToolCall } from '../llm/types';

export type ConversationMode = 'chat' | 'research' | 'quiz';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** reasoner 的思考内容，UI 折叠展示 */
  reasoning?: string;
  /** 毫秒时间戳 */
  ts: number;
}

export interface Conversation {
  id: string;
  title: string;
  mode: ConversationMode;
  model: string;
  provider: string;
  skillIds: string[];
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  /** 「AI 搜索」划词带入的来源路径，Task 9 一键笔记使用；可缺省 */
  researchSource?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  mode: ConversationMode;
  updatedAt: number;
  messageCount: number;
}
