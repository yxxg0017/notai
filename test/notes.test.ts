import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../src/notes/frontmatter';
import { notePathForSource, isInsideVault } from '../src/notes/vault';
import { NoteService } from '../src/notes/noteService';
import { WordBook } from '../src/notes/wordbook';

test('frontmatter 往返', () => {
  const text = '---\ntitle: 笔记\nsourceType: pdf\ntags: [a, b]\ncreated: 2026-09-30T00:00:00+08:00\npass: true\ncount: 3\n---\n\n# body\n内容';
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.title, '笔记');
  assert.deepStrictEqual(data.tags, ['a', 'b']);
  assert.strictEqual(data.pass, true);
  assert.strictEqual(data.count, 3);
  assert.ok(body.includes('# body'));
  const again = stringifyFrontmatter(data) + '\n---\n\n' + body;
  assert.deepStrictEqual(parseFrontmatter(again).data, data);
});
test('无 frontmatter 时返回空 data', () => {
  const { data, body } = parseFrontmatter('# 纯正文');
  assert.deepStrictEqual(data, {});
  assert.strictEqual(body, '# 纯正文');
});
test('notePathForSource 镜像目录且同名 .md', () => {
  assert.strictEqual(notePathForSource('/n', '/docs/a/b/2-Agent八股2️⃣.pdf'), '/n/a/b/2-Agent八股2️⃣.md');
  assert.strictEqual(notePathForSource('/n', '/2.pdf'), '/n/2.md');
});
test('isInsideVault 拒绝路径穿越与外部绝对路径', () => {
  assert.ok(isInsideVault('/n', '/n/子/笔记.md'));
  assert.ok(!isInsideVault('/n', '/n/../etc/passwd'));
  assert.ok(!isInsideVault('/n', '/etc/passwd'));
  assert.ok(!isInsideVault('/n', '/n2/other.md'));
});
test('NoteService 幂等续写：已存在笔记不覆盖只追加', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const svc = new NoteService(root);
    const src = { displayName: '2-Agent八股2️⃣.pdf', sourcePath: '/d/2-Agent八股2️⃣.pdf', sourceType: 'pdf' as const, page: 1, quote: '原文' };
    const r1 = await svc.openOrCreate(src, { headings: [{ heading: '第1页 · 解释', body: '内容A' }] });
    assert.strictEqual(r1.created, true);
    const r2 = await svc.openOrCreate(src, { headings: [{ heading: '第2页 · 手动笔记', body: '内容B' }] });
    assert.strictEqual(r2.created, false);
    const text = readFileSync(r1.notePath, 'utf8');
    assert.ok(text.includes('内容A'));
    assert.ok(text.includes('内容B'));
    assert.ok(text.includes('第1页 · 解释'));
    assert.ok(text.includes('第2页 · 手动笔记'));
    assert.strictEqual((text.match(/内容A/g) || []).length, 1); // 不重复写入
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('NoteService 首次创建含 frontmatter 与回链', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const svc = new NoteService(root);
    const src = { displayName: '2-Agent八股2️⃣.pdf', sourcePath: '/d/2-Agent八股2️⃣.pdf', sourceType: 'pdf' as const, page: 12, quote: '选中文本' };
    const { notePath } = await svc.openOrCreate(src, { headings: [] });
    const text = readFileSync(notePath, 'utf8');
    assert.ok(text.includes('source: 2-Agent八股2️⃣.pdf'));
    assert.ok(text.includes('sourceLink: vscode://file/d/2-Agent八股2️⃣.pdf#page=12'));
    assert.ok(text.includes('> 📎 原文引用（第 12 页）'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('WordBook 追加与解析', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-'));
  try {
    const wb = new WordBook(root);
    await wb.addEntry({ word: 'agent', translation: '代理', source: '2-Agent八股2️⃣.pdf', sentence: 'An agent uses tools.', date: '2026-09-30' });
    await wb.addEntry({ word: 'harness', translation: '编排框架', source: 'KamaClaude', date: '2026-09-30' });
    const entries = wb.parseAll(readFileSync(wb.path(), 'utf8'));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].word, 'agent');
    assert.strictEqual(entries[0].translation, '代理');
  } finally { rmSync(root, { recursive: true, force: true }); }
});