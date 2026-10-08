/**
 * Agent 工具调用循环（纯逻辑，无 VS Code 依赖）。
 *
 * 职责：
 *   - buildSystemPrompt(mode, skills)：组装系统提示词（基础身份 + skill 段 + 模式指令）
 *   - runAgentLoop(opts)：驱动 LLM 与工具的多轮循环，返回 LoopResult
 *
 * 循环语义：
 *   1. 组装 ChatMessage[]：system + history（调用方已把用户输入放入 history 末尾）
 *   2. provider.chat({ messages, model, tools, signal, onDelta })
 *   3. 返回含 toolCalls → 逐条执行对应 ToolHandler（ToolError/任意异常 → `[工具错误] ${message}`，ok:false），回填 tool 消息后回到 2
 *   4. maxSteps：达到上限时再以 tools:[] 收尾调用一次；仍失败/空 → truncated: true 并保留已收集消息
 *   5. 中止：signal 触发（含等待工具执行期间）→ 返回 { messages: 已收集, aborted: true }，不抛
 *   6. LLM 错误 → { messages: 已收集, error: { kind, message, retryable } }，不抛
 *   7. 每条产出的 AgentMessage 带 ts 时间戳；reasoning 透传自 AssistantMessage.reasoning
 */
import { LLMError } from '../llm/types';
import type {
  AssistantMessage,
  ChatMessage,
  Delta,
  LLMProvider,
  ToolCall,
} from '../llm/types';
import type { AgentMessage, ConversationMode } from './types';
import type { Skill } from '../skills/skill';
import type { ToolContext, ToolHandler } from '../tools/context';

const BASE_SYSTEM_PROMPT = '你是「AI 学习助手」，用中文与用户交流，帮助其学习与答疑。';

const MODE_PROMPTS: Record<ConversationMode, string> = {
  chat: '',
  research:
    '输出格式：**结论** 后接 **来源** 列表（[标题](url) 或本地路径）；找不到答案时明说。',
  quiz: '苏格拉底式引导，一次只提一个问题，先引导思考再揭晓。',
};

export interface LoopHooks {
  onDelta?: (d: Delta) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (callId: string, result: string, ok: boolean) => void;
}

export interface LoopResult {
  messages: AgentMessage[];
  aborted: boolean;
  truncated: boolean;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface RunAgentLoopOptions {
  provider: LLMProvider;
  model: string;
  mode: ConversationMode;
  skills: Skill[];
  history: AgentMessage[];
  tools: ToolHandler[];
  ctx: ToolContext;
  maxSteps: number;
  signal?: AbortSignal;
  hooks?: LoopHooks;
}

/** 基础身份 + 每个启用 skill 的 systemPrompt 段 + 模式指令；skills 为空时仅基础身份 */
export function buildSystemPrompt(mode: ConversationMode, skills: Skill[]): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];
  for (const skill of skills) {
    if (skill.systemPrompt) {
      parts.push(skill.systemPrompt);
    }
  }
  const modePrompt = MODE_PROMPTS[mode];
  if (modePrompt) {
    parts.push(modePrompt);
  }
  return parts.filter(Boolean).join('\n\n');
}

function toChatMessage(m: AgentMessage): ChatMessage {
  const msg: ChatMessage = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    msg.toolCalls = m.toolCalls;
  }
  if (m.toolCallId) {
    msg.toolCallId = m.toolCallId;
  }
  return msg;
}

function collectAssistant(reply: AssistantMessage): AgentMessage {
  const message: AgentMessage = {
    role: 'assistant',
    content: reply.content ?? '',
    ts: Date.now(),
  };
  if (reply.reasoning) {
    message.reasoning = reply.reasoning;
  }
  if (reply.toolCalls && reply.toolCalls.length > 0) {
    message.toolCalls = reply.toolCalls;
  }
  return message;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorInfo(err: unknown): { kind: string; message: string; retryable: boolean } {
  if (err instanceof LLMError) {
    return { kind: err.kind, message: err.message, retryable: err.retryable };
  }
  return {
    kind: 'unknown',
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

async function executeTool(
  call: ToolCall,
  toolMap: Map<string, ToolHandler>,
  ctx: ToolContext
): Promise<{ result: string; ok: boolean }> {
  const handler = toolMap.get(call.name);
  if (!handler) {
    return { result: `[工具错误] 未知工具: ${call.name}`, ok: false };
  }
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return { result: `[工具错误] 工具参数不是合法 JSON: ${call.name}`, ok: false };
  }
  try {
    return { result: await handler.execute(args, ctx), ok: true };
  } catch (err) {
    return {
      result: `[工具错误] ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<LoopResult> {
  const { provider, model, mode, skills, history, tools, ctx, maxSteps, signal, hooks } = opts;
  const collected: AgentMessage[] = [];
  const toolMap = new Map(tools.map((t) => [t.definition.name, t] as const));
  const definitions = tools.map((t) => t.definition);

  const buildChatMessages = (): ChatMessage[] => [
    { role: 'system', content: buildSystemPrompt(mode, skills) },
    ...history.map(toChatMessage),
    ...collected.map(toChatMessage),
  ];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      signal?.throwIfAborted();
      const reply = await provider.chat({
        messages: buildChatMessages(),
        model,
        tools: definitions,
        signal,
        onDelta: hooks?.onDelta,
      });
      if (signal?.aborted) {
        return { messages: collected, aborted: true, truncated: false };
      }
      const calls = reply.toolCalls ?? [];
      if (calls.length === 0) {
        collected.push(collectAssistant(reply));
        return { messages: collected, aborted: false, truncated: false };
      }
      collected.push(collectAssistant(reply));
      for (const call of calls) {
        signal?.throwIfAborted();
        hooks?.onToolCall?.(call);
        const { result, ok } = await executeTool(call, toolMap, ctx);
        signal?.throwIfAborted();
        hooks?.onToolResult?.(call.id, result, ok);
        collected.push({ role: 'tool', content: result, toolCallId: call.id, ts: Date.now() });
      }
    }
    // 达到 maxSteps：以 tools:[] 收尾调用一次，保证最终文字回复
    signal?.throwIfAborted();
    const reply = await provider.chat({
      messages: buildChatMessages(),
      model,
      tools: [],
      signal,
      onDelta: hooks?.onDelta,
    });
    if (signal?.aborted) {
      return { messages: collected, aborted: true, truncated: false };
    }
    if (reply.content) {
      collected.push(collectAssistant(reply));
      return { messages: collected, aborted: false, truncated: false };
    }
    return { messages: collected, aborted: false, truncated: true };
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      return { messages: collected, aborted: true, truncated: false };
    }
    return { messages: collected, aborted: false, truncated: false, error: errorInfo(err) };
  }
}
