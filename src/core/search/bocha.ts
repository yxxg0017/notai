/**
 * 博查（Bocha）网页搜索 Provider（纯逻辑，无 VS Code 依赖）。
 *
 * - POST https://api.bochaai.com/v1/web-search，header `Authorization: Bearer <key>`
 *   body { query, summary: true, count: 5 }
 * - 无 Key 抛 ToolError('未配置博查 API Key')，与 Tavily 对称
 * - 非 200 抛 ToolError('搜索服务返回 ' + status)；请求内部 15s 超时（与外部 signal 合并）
 */
import { ToolError } from '../tools/context';
import { WebResult, WebSearchProvider } from './provider';

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search';
const SEARCH_TIMEOUT_MS = 15000;

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `data.webPages.value[]` 的 name/url/snippet（缺失字段容错为空串；畸形返回 []） */
export function parseBochaResponse(json: unknown): WebResult[] {
  if (!json || typeof json !== 'object') {
    return [];
  }
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return [];
  }
  const webPages = (data as { webPages?: unknown }).webPages;
  if (!webPages || typeof webPages !== 'object') {
    return [];
  }
  const value = (webPages as { value?: unknown }).value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      title: asStr(p.name),
      url: asStr(p.url),
      snippet: asStr(p.snippet),
    }));
}

export class BochaProvider implements WebSearchProvider {
  readonly id = 'bocha';
  readonly displayName = '博查';

  constructor(private readonly getKey: () => Promise<string>) {}

  async search(query: string, signal?: AbortSignal): Promise<WebResult[]> {
    const apiKey = await this.getKey();
    if (!apiKey) {
      throw new ToolError('未配置博查 API Key');
    }
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const res = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, summary: true, count: 5 }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) {
      throw new ToolError(`搜索服务返回 ${res.status}`);
    }
    return parseBochaResponse(await res.json());
  }
}