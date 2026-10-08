/**
 * LLM 调用 429 退避重试包装。
 *
 * 语义（Task 11）：
 * - 仅 `LLMError.kind === 'rateLimit'`（HTTP 429）按 `delaysMs` 逐档退避重试：
 *   第 n 次失败（0-based）且未达最后一档 → 等待 `delaysMs[n]` 后重试；
 * - 最后一档失败（或重试耗尽）→ **原样抛出**最后一次错误（总调用次数 = 1 + delaysMs.length）；
 * - 中止（`req.signal?.aborted`）→ 不 sleep 不重试，立即抛出；
 * - 其余错误（network/auth/contextLength/noApiKey/unknown）直接抛；成功返回。
 *
 * 全局约束：本文件位于 src/core/llm/，禁止 `import 'vscode'`（node:test 直接运行）。
 */
import { LLMError } from './types';
import type { AssistantMessage, ChatRequest, LLMProvider } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatWithRetry(
  provider: LLMProvider,
  req: ChatRequest,
  delaysMs: number[] = [1000, 2000],
): Promise<AssistantMessage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.chat(req);
    } catch (err) {
      // 中止：用户主动停止，不重试（含「最后一档等待期间已中止」由调用方 signal 检查兜底）
      if (req.signal?.aborted) {
        throw err;
      }
      const retryable = err instanceof LLMError && err.kind === 'rateLimit';
      if (!retryable || attempt >= delaysMs.length) {
        // 非 429，或已用完全部重试档位：原样抛出
        throw err;
      }
      await sleep(delaysMs[attempt]);
    }
  }
}