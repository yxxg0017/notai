import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveWithin, localHitToString, readTools, ToolError } from '../src/core/tools/readTools';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));

test('resolveWithin 拒绝 .. 与绝对路径逃逸', () => {
  const r = root();
  assert.ok(resolveWithin(r, path.join('a', 'b.txt'))?.startsWith(r));
  assert.strictEqual(resolveWithin(r, '../etc/passwd'), undefined);
  assert.strictEqual(resolveWithin(r, '/etc/passwd'), undefined);
  assert.strictEqual(resolveWithin(r, path.join(r, '..', 'x')), undefined);
});

test('localHitToString 截断条数', () => {
  const hits = Array.from({ length: 9 }, (_, i) => ({ path: '/a.md', line: i, text: `t${i}` }));
  const out = localHitToString(hits, 5);
  assert.strictEqual(out.split('\n').length, 5);
  assert.ok(out.includes('/a.md:0: t0'));
});

test('read_file 读取、截断与逃逸拒绝', async () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'a.txt'), 'x'.repeat(100));
  const ctx = { notesRoot: r, cwd: r,
    readFile: async (p: string, mb?: number) => { throw new Error('unused'); },
    searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  const out1 = await tools.read_file.execute({ path: 'a.txt' }, ctx);
  assert.strictEqual(out1, 'x'.repeat(100));
  const out2 = await tools.read_file.execute({ path: 'a.txt', maxBytes: 10 }, ctx);
  assert.ok(out2.endsWith('[已截断，共 100 字节]') && out2.startsWith('x'.repeat(10)));
  await assert.rejects(() => tools.read_file.execute({ path: '../x' }, ctx), ToolError);
});

test('search_local 与 list_notes 空结果文案', async () => {
  const ctx = { notesRoot: '/x', searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  assert.strictEqual(await tools.search_local.execute({ query: 'q' }, ctx as any), '（无匹配）');
  assert.strictEqual(await tools.list_notes.execute({}, ctx as any), '（暂无笔记）');
});
