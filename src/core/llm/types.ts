/**
 * 纯 LLM 层类型定义。
 *
 * 全局约束：本目录（src/core/llm/）禁止 `import 'vscode'` —— 这些模块需要在
 * node:test 环境下直接运行（无 VS Code 运行时），只允许 node 内建模块与全局 fetch。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** 完整 JSON 参数字符串（DeepSeek 流式返回时按片段累积） */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 形式的参数定义 */
  parameters: object;
}

/** 流式增量回调负载：文本 / 推理 / 工具调用（按 index 归并） */
export type Delta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; index: number; id?: string; name?: string; argumentsDelta?: string };

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (d: Delta) => void;
}

export interface AssistantMessage {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
}

export interface LLMProvider {
  name: string;
  capabilities: ProviderCapabilities;
  chat(req: ChatRequest): Promise<AssistantMessage>;
}

export type LLMErrorKind =
  | 'noApiKey'
  | 'network'
  | 'rateLimit'
  | 'auth'
  | 'contextLength'
  | 'unknown';

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  /** 是否可安全重试（仅限流与网络/服务端错误为 true） */
  readonly retryable: boolean;

  constructor(kind: LLMErrorKind, message: string, retryable = false) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.retryable = retryable;
  }
}