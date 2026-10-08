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

test('read_file 符号链接：root 内→外拒绝，root 内→内放行', async () => {
  const r = root();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-out-'));
  fs.writeFileSync(path.join(r, 'in.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
  fs.symlinkSync(path.join(r, 'in.txt'), path.join(r, 'link-in'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(r, 'link-out'));
  const ctx = { notesRoot: r, cwd: r,
    readFile: async () => { throw new Error('unused'); },
    searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  // 指向 root 内的符号链接：正常读取
  assert.strictEqual(await tools.read_file.execute({ path: 'link-in' }, ctx), 'inside');
  // 指向 root 外的符号链接：拒绝并报符号链接逃逸
  await assert.rejects(
    () => tools.read_file.execute({ path: 'link-out' }, ctx),
    (err: unknown) => err instanceof ToolError && err.message.includes('符号链接逃逸')
  );
});

test('read_file 不存在的路径报「文件不存在或不可读」而非「逃逸」', async () => {
  const r = root();
  const ctx = { notesRoot: r, cwd: r,
    readFile: async (p: string, mb?: number) => { throw new Error('unused'); },
    searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  await assert.rejects(
    () => tools.read_file.execute({ path: 'nope.txt' }, ctx),
    (err: unknown) => err instanceof ToolError && err.message.includes('文件不存在或不可读')
  );
});

test('ctx 回调异常包装为 ToolError，参数非正值钳制回落默认', async () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'a.txt'), 'x'.repeat(100));
  const boom = async () => { throw new Error('boom'); };
  const ctx = { notesRoot: r, cwd: r,
    readFile: async (p: string, mb?: number) => { throw new Error('unused'); },
    searchLocal: boom, readPdfPage: boom, listNotes: boom };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  // ctx 回调异常统一包装为 ToolError
  await assert.rejects(
    () => tools.search_local.execute({ query: 'q' }, ctx),
    (err: unknown) => err instanceof ToolError && err.message.includes('search_local')
  );
  await assert.rejects(
    () => tools.read_pdf_page.execute({}, ctx),
    (err: unknown) => err instanceof ToolError && err.message.includes('read_pdf_page')
  );
  await assert.rejects(
    () => tools.list_notes.execute({}, ctx),
    (err: unknown) => err instanceof ToolError && err.message.includes('list_notes')
  );
  // maxBytes=0 回落默认 16384：100 字节内容完整返回（不截断）
  const out = await tools.read_file.execute({ path: 'a.txt', maxBytes: 0 }, ctx);
  assert.strictEqual(out, 'x'.repeat(100));
});

test('search_local limit 非正值回落默认 5', async () => {
  const r = root();
  const seen: { limit?: number } = {};
  const ctx = { notesRoot: r, cwd: r,
    readFile: async () => { throw new Error('unused'); },
    searchLocal: async (_q: string, limit?: number) => {
      seen.limit = limit;
      return Array.from({ length: 3 }, (_, i) => ({ path: '/a.md', line: i, text: `t${i}` }));
    },
    listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  await tools.search_local.execute({ query: 'q', limit: -1 }, ctx as any);
  assert.strictEqual(seen.limit, 5);
});
