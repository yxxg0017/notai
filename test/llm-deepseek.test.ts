import { test } from 'node:test';
import assert from 'node:assert';
import { parseSseChunk, mapHttpError, DeepSeekProvider } from '../src/core/llm/deepseek';
import { LLMError } from '../src/core/llm/types';

test('parseSseChunk 解析内容增量', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"content":"你好"}}]}');
  assert.strictEqual(d?.text, '你好');
});
test('parseSseChunk 解析推理增量', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}');
  assert.strictEqual(d?.reasoning, '思考');
});
test('parseSseChunk 解析 tool_calls 增量并归并', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"p"}}]}}]}');
  assert.strictEqual(d?.toolCall?.index, 0);
  assert.strictEqual(d?.toolCall?.id, 'call_1');
  assert.strictEqual(d?.toolCall?.name, 'read_file');
  assert.strictEqual(d?.toolCall?.argumentsDelta, '{"p');
});
test('parseSseChunk 忽略非 data 行与结束行', () => {
  assert.strictEqual(parseSseChunk(': keep-alive'), null);
  assert.strictEqual(parseSseChunk('data: [DONE]'), null);
});
test('mapHttpError 分类错误', () => {
  assert.strictEqual(mapHttpError(401, '').kind, 'auth');
  assert.strictEqual(mapHttpError(429, '').kind, 'rateLimit');
  assert.strictEqual(mapHttpError(400, 'context length exceeded').kind, 'contextLength');
  assert.strictEqual(mapHttpError(503, '').kind, 'network');
  assert.strictEqual(mapHttpError(429, '').retryable, true);
  assert.strictEqual(mapHttpError(401, '').retryable, false);
});
test('DeepSeekProvider chat 发送流式请求并聚合', async () => {
  // mock fetch: 返回 ReadableStream，两个 chunk 各含一个文本增量，最后 finish_reason=stop
  const calls: { url: string; init: any }[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"B"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const deltas: string[] = [];
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat', onDelta: (d) => { if (d.type === 'text') deltas.push(d.text); } });
  assert.strictEqual(msg.content, 'AB');
  assert.deepStrictEqual(deltas, ['A', 'B']);
  assert.ok(calls[0].url.startsWith('https://api.deepseek.com/v1/chat/completions'));
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-test');
});

test('SSE 行跨 chunk 切分仍能解析完整 delta', async () => {
  // 把一行 `data: {...}\n\n` 拆成两个 chunk 发送（第一个 chunk 只有 `data: {"choice`）
  const enc = new TextEncoder();
  const full = 'data: {"choices":[{"delta":{"content":"跨行"}}]}\n\ndata: [DONE]\n\n';
  const bytes = enc.encode(full);
  const cut = enc.encode('data: {"choice').length;
  (globalThis as any).fetch = async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.subarray(0, cut));
        c.enqueue(bytes.subarray(cut));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat' });
  assert.strictEqual(msg.content, '跨行');
});

test('多字节 UTF-8 字符跨 chunk 边界不丢失', async () => {
  // 手工用 subarray 把「内」的字节拆到两个 chunk 边界（第一个 chunk 以「内」的前 2 字节结尾）
  const enc = new TextEncoder();
  const full = 'data: {"choices":[{"delta":{"content":"内容"}}]}\n\ndata: [DONE]\n\n';
  const bytes = enc.encode(full);
  const cut = enc.encode('data: {"choices":[{"delta":{"content":"内').length - 1;
  (globalThis as any).fetch = async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.subarray(0, cut));
        c.enqueue(bytes.subarray(cut));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat' });
  assert.strictEqual(msg.content, '内容');
});

test('finish_reason=stop 时有 tool_calls 增量也不返回 toolCalls', async () => {
  const enc = new TextEncoder();
  (globalThis as any).fetch = async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat' });
  assert.strictEqual(msg.toolCalls, undefined);
});

test('finish_reason=tool_calls 时返回按 index 归并的完整 toolCalls', async () => {
  const enc = new TextEncoder();
  (globalThis as any).fetch = async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/a.txt\\"}"}}]}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","function":{"name":"write_file","arguments":"{}"}}]}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat' });
  assert.strictEqual(msg.toolCalls?.length, 2);
  assert.strictEqual(msg.toolCalls?.[0].id, 'call_0');
  assert.strictEqual(msg.toolCalls?.[0].name, 'read_file');
  assert.strictEqual(msg.toolCalls?.[0].arguments, '{"path":"/a.txt"}');
  assert.strictEqual(msg.toolCalls?.[1].id, 'call_1');
  assert.strictEqual(msg.toolCalls?.[1].name, 'write_file');
  assert.strictEqual(msg.toolCalls?.[1].arguments, '{}');
});

test('流中段 AbortError 映射为 network 且 retryable=false', async () => {
  const enc = new TextEncoder();
  (globalThis as any).fetch = async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
        c.error(new DOMException('aborted', 'AbortError'));
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  await assert.rejects(
    p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat' }),
    (err: unknown) => {
      assert.ok(err instanceof LLMError);
      assert.strictEqual(err.kind, 'network');
      assert.strictEqual(err.retryable, false);
      return true;
    }
  );
});

test('mapHttpError 5xx 一律不可重试', () => {
  assert.strictEqual(mapHttpError(503, '').retryable, false);
  assert.strictEqual(mapHttpError(500, '').retryable, false);
});
