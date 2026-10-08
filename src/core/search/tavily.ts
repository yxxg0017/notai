/**
 * Tavily 网页搜索 Provider（纯逻辑，无 VS Code 依赖）。
 *
 * - POST https://api.tavily.com/search，body { api_key, query, max_results: 5, include_answer: false }
 * - 无 Key 抛 ToolError('未配置 Tavily API Key')
 * - 非 200 抛 ToolError('搜索服务返回 ' + status)；请求内部 15s 超时（与外部 signal 合并）
 */
import { ToolError } from '../tools/context';
import { WebResult, WebSearchProvider } from './provider';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 15000;

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `results[]` 的 title/url/content（缺失字段容错为空串；畸形返回 []） */
export function parseTavilyResponse(json: unknown): WebResult[] {
  if (!json || typeof json !== 'object') {
    return [];
  }
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      title: asStr(r.title),
      url: asStr(r.url),
      snippet: asStr(r.content),
    }));
}

export class TavilyProvider implements WebSearchProvider {
  readonly id = 'tavily';
  readonly displayName = 'Tavily';

  constructor(private readonly getKey: () => Promise<string>) {}

  async search(query: string, signal?: AbortSignal): Promise<WebResult[]> {
    const apiKey = await this.getKey();
    if (!apiKey) {
      throw new ToolError('未配置 Tavily API Key');
    }
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_answer: false,
      }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) {
      throw new ToolError(`搜索服务返回 ${res.status}`);
    }
    return parseTavilyResponse(await res.json());
  }
}