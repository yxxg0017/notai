/**
 * web_search 工具（纯逻辑，无 VS Code 依赖）：
 * 调用注入的网页搜索 Provider，返回「标题\n链接\n摘要」拼接文本（条目间空行）。
 *
 * - provider 为 undefined（配置 none 或无 Key 时调用方传 undefined）→ 返回 undefined（不注册）
 * - 领域错误（ToolError，如未配置 Key / 服务非 200）原样抛出，由执行层统一回填；
 *   其他意外失败回填 `[搜索失败] 原因`（不抛出，供 LLM 阅读）
 */
import { ToolContext, ToolError, ToolHandler } from './context';
import { WebResult, WebSearchProvider } from '../search/provider';

/** WebResult 列表 → 每条「标题\n链接\n摘要」三行，条目间空行 */
export function formatWebResults(results: WebResult[]): string {
  return results.map((r) => [r.title, r.url, r.snippet].join('\n')).join('\n\n');
}

export function webSearchTool(provider: WebSearchProvider | undefined): ToolHandler | undefined {
  if (!provider) {
    return undefined;
  }
  return {
    definition: {
      name: 'web_search',
      description:
        '在互联网上搜索并返回结果（标题、链接、摘要），用于补充本地笔记与知识库之外的信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
    access: 'read',
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        throw new ToolError('web_search 缺少 query 参数');
      }
      try {
        const results = await provider.search(query, ctx.signal);
        if (!results || results.length === 0) {
          return '（无搜索命中）';
        }
        return formatWebResults(results);
      } catch (err) {
        if (err instanceof ToolError) {
          throw err;
        }
        return `[搜索失败] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}