/**
 * DeepSeek OpenAI 兼容流式客户端。
 *
 * 全局约束：本文件禁止 `import 'vscode'`（运行于 node:test，无 VS Code 运行时）。
 * 只使用 node 内建能力与全局 fetch（Node 20+）。
 */

import { LLMError } from './types';
import type {
  AssistantMessage,
  ChatRequest,
  Delta,
  LLMProvider,
  ProviderCapabilities,
  ToolCall,
} from './types';

/**
 * 解析单行 SSE 数据（`data: ` 前缀）。
 *
 * - 非 `data: ` 行、`[DONE]`、空行、JSON 解析失败、无 choices → 返回 null
 * - 透出 `delta.content`（text）、`delta.reasoning_content`（reasoning）、
 *   `delta.tool_calls[0]`（index/id/name/arguments 增量）
 * - `finish_reason` 存在时设置 `finish: true` 与 `finishReason`（原始值透传）
 */
export function parseSseChunk(
  line: string
): {
  text?: string;
  reasoning?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  finish?: boolean;
  finishReason?: string;
} | null {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice('data: '.length);
  if (!payload || payload === '[DONE]') return null;

  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const choice = json?.choices?.[0];
  if (!choice) return null;

  const out: {
    text?: string;
    reasoning?: string;
    toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
    finish?: boolean;
    finishReason?: string;
  } = {};

  const delta = choice.delta ?? {};
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    out.text = delta.content;
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    out.reasoning = delta.reasoning_content;
  }
  const tc = Array.isArray(delta.tool_calls) ? delta.tool_calls[0] : undefined;
  if (tc && typeof tc === 'object') {
    const toolCall: NonNullable<ReturnType<typeof parseSseChunk>>['toolCall'] = {
      index: typeof tc.index === 'number' ? tc.index : 0,
    };
    if (typeof tc.id === 'string') toolCall.id = tc.id;
    if (typeof tc.function?.name === 'string') toolCall.name = tc.function.name;
    if (typeof tc.function?.arguments === 'string') toolCall.argumentsDelta = tc.function.arguments;
    out.toolCall = toolCall;
  }
  if (choice.finish_reason != null) {
    out.finish = true;
    if (typeof choice.finish_reason === 'string') out.finishReason = choice.finish_reason;
  }

  return out;
}

/** 按 HTTP 状态码与响应体将错误分类为 LLMError */
export function mapHttpError(status: number, body: string): LLMError {
  if (status === 401 || status === 403) {
    return new LLMError('auth', `认证失败（HTTP ${status}）`, false);
  }
  if (status === 429) {
    return new LLMError('rateLimit', '请求过于频繁，已限流（HTTP 429）', true);
  }
  if (status === 400 && /context\s*length|maximum\s*context/i.test(body)) {
    return new LLMError('contextLength', '上下文长度超出模型限制（HTTP 400）', false);
  }
  // 全局约束：retryable 仅 rateLimit 为 true —— 其余 5xx/网络错误一律不可自动重试
  return new LLMError(
    'network',
    `请求失败（HTTP ${status}）${body ? `：${body.slice(0, 200)}` : ''}`,
    false
  );
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';
  readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsImages: false,
    supportsReasoning: true,
  };

  constructor(
    private readonly getApiKey: () => Promise<string>,
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  async chat(req: ChatRequest): Promise<AssistantMessage> {
    const apiKey = (await this.getApiKey()).trim();
    if (!apiKey) {
      throw new LLMError('noApiKey', '未配置 DeepSeek API Key', false);
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      // DeepSeek（OpenAI 兼容）要求 tools 元素为 { type: 'function', function: {...} }；
      // 内部 ToolDefinition 为 {name, description, parameters}，此处做线格式映射（HTTP 422 修复）
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError('network', '请求已取消（AbortError）', false);
      }
      // 全局约束：retryable 仅 rateLimit 为 true —— 网络错误不可自动重试
      throw new LLMError(
        'network',
        `网络错误：${err instanceof Error ? err.message : String(err)}`,
        false
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw mapHttpError(res.status, errBody);
    }
    if (!res.body) {
      throw new LLMError('network', '响应缺少 body', false);
    }

    let content = '';
    let reasoning = '';
    const toolAccums = new Map<number, ToolCallAccum>();
    let finishReason: string | undefined;

    const handleLine = (line: string) => {
      const parsed = parseSseChunk(line);
      if (!parsed) return;
      if (parsed.text !== undefined) {
        content += parsed.text;
        req.onDelta?.({ type: 'text', text: parsed.text });
      }
      if (parsed.reasoning !== undefined) {
        reasoning += parsed.reasoning;
        req.onDelta?.({ type: 'reasoning', text: parsed.reasoning });
      }
      if (parsed.toolCall) {
        const tc = parsed.toolCall;
        const delta: Delta = {
          type: 'toolCall',
          index: tc.index,
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          ...(tc.name !== undefined ? { name: tc.name } : {}),
          ...(tc.argumentsDelta !== undefined ? { argumentsDelta: tc.argumentsDelta } : {}),
        };
        req.onDelta?.(delta);
        const acc = toolAccums.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id !== undefined) acc.id = tc.id;
        if (tc.name !== undefined) acc.name = tc.name;
        if (tc.argumentsDelta !== undefined) acc.arguments += tc.argumentsDelta;
        toolAccums.set(tc.index, acc);
      }
      if (parsed.finishReason !== undefined) finishReason = parsed.finishReason;
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // stream: true —— 跨 chunk 的 UTF-8 多字节字符由 decoder 保序拼接
          buffer += decoder.decode(value, { stream: true });
          for (let idx = buffer.indexOf('\n'); idx >= 0; idx = buffer.indexOf('\n')) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            handleLine(line);
          }
        }
        // 最后一个 chunk 可能没有结尾换行
        if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ''));
      } catch (err) {
        // 流中段错误（如响应头之后触发 abort、连接中断）：映射为统一的网络错误，
        // 不再把 DOMException/TypeError 裸抛给调用方；retryable 仅 rateLimit 为 true。
        if (err instanceof Error && err.name === 'AbortError') {
          throw new LLMError('network', '流式读取已取消（AbortError）', false);
        }
        throw new LLMError(
          'network',
          `流式读取错误：${err instanceof Error ? err.message : String(err)}`,
          false
        );
      }
    } finally {
      reader.releaseLock();
    }

    const msg: AssistantMessage = { content };
    if (reasoning.length > 0) msg.reasoning = reasoning;
    if (finishReason === 'tool_calls' && toolAccums.size > 0) {
      const toolCalls: ToolCall[] = [...toolAccums.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: acc.arguments }));
      if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    }
    return msg;
  }
}
