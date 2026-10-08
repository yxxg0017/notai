import { test } from 'node:test';
import assert from 'node:assert';
import { chatWithRetry } from '../src/core/llm/retry';
import { LLMError } from '../src/core/llm/types';
import type { AssistantMessage, ChatRequest, LLMProvider } from '../src/core/llm/types';

/** 测试用最小请求（retry 仅转发给 provider，不关心消息内容） */
const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], model: 'test-model' };

/** 计数 mock provider：调用次数 n 从 1 开始 */
function countingProvider(
  impl: (n: number) => Promise<AssistantMessage>,
): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      name: 'mock',
      capabilities: { supportsTools: false, supportsImages: false, supportsReasoning: false },
      chat: async () => {
        n += 1;
        return impl(n);
      },
    },
    calls: () => n,
  };
}

test('rateLimit 前两次、第三次成功：共调用 3 次并返回结果', async () => {
  const { provider, calls } = countingProvider(async (n) => {
    if (n < 3) {
      throw new LLMError('rateLimit', '429 Too Many Requests', true);
    }
    return { content: 'ok' };
  });
  const msg = await chatWithRetry(provider, req, [0, 0]);
  assert.strictEqual(msg.content, 'ok');
  assert.strictEqual(calls(), 3);
});

test('持续 rateLimit：最后一档失败原样抛出（kind=rateLimit），共调用 3 次', async () => {
  const { provider, calls } = countingProvider(async () => {
    throw new LLMError('rateLimit', '429 Too Many Requests', true);
  });
  await assert.rejects(
    chatWithRetry(provider, req, [0, 0]),
    (err: unknown) => {
      assert.ok(err instanceof LLMError);
      assert.strictEqual(err.kind, 'rateLimit');
      assert.strictEqual(err.retryable, true);
      return true;
    },
  );
  assert.strictEqual(calls(), 3);
});

test('非 rateLimit（network）不重试：仅调用 1 次', async () => {
  const { provider, calls } = countingProvider(async () => {
    throw new LLMError('network', 'ECONNRESET', false);
  });
  await assert.rejects(
    chatWithRetry(provider, req),
    (err: unknown) => {
      assert.ok(err instanceof LLMError);
      assert.strictEqual(err.kind, 'network');
      return true;
    },
  );
  assert.strictEqual(calls(), 1);
});

test('signal 已中止：即使 rateLimit 也不重试，仅调用 1 次即抛', async () => {
  const ac = new AbortController();
  ac.abort();
  const { provider, calls } = countingProvider(async () => {
    throw new LLMError('rateLimit', '429 Too Many Requests', true);
  });
  await assert.rejects(
    chatWithRetry(provider, { ...req, signal: ac.signal }, [0, 0]),
    (err: unknown) => {
      assert.ok(err instanceof LLMError);
      assert.strictEqual(err.kind, 'rateLimit');
      return true;
    },
  );
  assert.strictEqual(calls(), 1);
});