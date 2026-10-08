import { test } from 'node:test';
import assert from 'node:assert';
import { parseTavilyResponse } from '../src/core/search/tavily';
import { parseBochaResponse } from '../src/core/search/bocha';
import { webSearchTool } from '../src/core/tools/webSearchTool';
import { ToolError } from '../src/core/tools/context';

test('parseTavilyResponse 容错解析', () => {
  const r = parseTavilyResponse({ results: [
    { title: 'T', url: 'https://a', content: 'c' },
    { title: '', url: 'https://b' },
  ] });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].snippet, 'c');
  assert.strictEqual(r[1].snippet, '');
  assert.deepStrictEqual(parseTavilyResponse({}), []);
  assert.deepStrictEqual(parseTavilyResponse(null), []);
});

test('parseBochaResponse 容错解析', () => {
  const r = parseBochaResponse({ data: { webPages: { value: [
    { name: 'B', url: 'https://c', snippet: 's' } ] } } });
  assert.strictEqual(r[0].title, 'B');
  assert.deepStrictEqual(parseBochaResponse({}), []);
});

test('webSearchTool 未配置时不注册', () => {
  assert.strictEqual(webSearchTool(undefined), undefined);
});

test('webSearchTool 无 Key 抛 ToolError', async () => {
  const t = webSearchTool({ id: 'tavily', displayName: 'T', search: async () => { throw new ToolError('未配置 Tavily API Key'); } })!;
  await assert.rejects(() => t.execute({ query: 'q' }, {} as any), /未配置/);
});

test('parseTavilyResponse 非数组 results 与畸形条目返回空/容错', () => {
  assert.deepStrictEqual(parseTavilyResponse({ results: 'x' }), []);
  // 畸形条目（非对象）被过滤，字段非字符串容错为空串
  assert.deepStrictEqual(
    parseTavilyResponse({ results: [null, 42, { title: 1 }, { title: 'ok', url: 'u' }] }),
    [{ title: '', url: '', snippet: '' }, { title: 'ok', url: 'u', snippet: '' }]
  );
});

test('parseBochaResponse 缺省嵌套返回空', () => {
  assert.deepStrictEqual(parseBochaResponse({ data: {} }), []);
  assert.deepStrictEqual(parseBochaResponse({ data: { webPages: null } }), []);
  assert.deepStrictEqual(parseBochaResponse(null), []);
});

test('webSearchTool 成功时按 标题/链接/摘要 拼接，条目间空行', async () => {
  const t = webSearchTool({
    id: 'tavily', displayName: 'T',
    search: async () => [
      { title: 'T1', url: 'https://a', snippet: 's1' },
      { title: 'T2', url: 'https://b', snippet: 's2' },
    ],
  })!;
  const out = await t.execute({ query: 'q' }, {} as any);
  assert.strictEqual(out, 'T1\nhttps://a\ns1\n\nT2\nhttps://b\ns2');
});

test('webSearchTool 无命中返回占位文案', async () => {
  const t = webSearchTool({ id: 'tavily', displayName: 'T', search: async () => [] })!;
  assert.strictEqual(await t.execute({ query: 'q' }, {} as any), '（无搜索命中）');
});

test('webSearchTool 意外失败回填 [搜索失败] 不抛出，缺 query 抛 ToolError', async () => {
  const t = webSearchTool({
    id: 'tavily', displayName: 'T',
    search: async () => { throw new Error('boom'); },
  })!;
  assert.strictEqual(await t.execute({ query: 'q' }, {} as any), '[搜索失败] boom');
  await assert.rejects(() => t.execute({}, {} as any), /缺少 query/);
});