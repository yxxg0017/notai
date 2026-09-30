import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteService } from '../src/notes/noteService';
import { WordBook } from '../src/notes/wordbook';

// 集成：同一来源多次「加笔记」→ 单文件续写；同一个词多次加 → 单词本追加不去重（保留多次记录）
test('同一来源多次加笔记始终续写同一文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ni-'));
  try {
    const svc = new NoteService(root);
    const src = { displayName: 'pico.pdf', sourcePath: '/d/pico.pdf', sourceType: 'pdf' as const, page: 3 };
    const a = await svc.openOrCreate(src, { headings: [{ heading: '第3页 · 解释', body: 'X' }] });
    const b = await svc.openOrCreate({ ...src, page: 7 }, { headings: [{ heading: '第7页 · 手动笔记', body: 'Y' }] });
    assert.strictEqual(a.notePath, b.notePath);          // 同一文件
    const text = readFileSync(a.notePath, 'utf8');
    assert.ok(text.includes('X') && text.includes('Y'));
    assert.strictEqual((text.match(/^---$/m) || []).length, 1); // 仅一份 frontmatter
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('单词本只存在一个文件且多次追加', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wi-'));
  try {
    const wb = new WordBook(root);
    await wb.addEntry({ word: 'loop', translation: '循环', source: 'pico.pdf', date: '2026-09-30' });
    await wb.addEntry({ word: 'loop', translation: '循环', source: 'pico.pdf', date: '2026-09-30' });
    const entries = wb.parseAll(readFileSync(wb.path(), 'utf8'));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(readdirSync(root).filter(f => f.endsWith('.md')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});