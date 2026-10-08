import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NoteService } from '../src/notes/noteService';
import { noteTools } from '../src/core/tools/noteTools';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notetools-'));
const tools = (r: string) => Object.fromEntries(noteTools(new NoteService(r)).map(t => [t.definition.name, t]));
// 注意：必须用字符串拼接保留 `..` 段（path.join 会规范化掉），
// 使 notePathForSource 命中退化平铺分支，笔记落在 notesRoot 根下 a.md
const src = (r: string) => ({ displayName: 'a.pdf', sourcePath: r + '/../a.pdf', sourceType: 'pdf' as const });
const ctx = (r: string) => ({ notesRoot: r }) as any;

test('create_note 新建并追加内容', async () => {
  const r = root();
  const t = tools(r);
  const out = await t.create_note.execute({ source: src(r).sourcePath, content: '正文', heading: '总结' }, ctx(r));
  const p = path.join(r, 'a.md');
  assert.ok(out.includes(p));
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('## 总结') && text.includes('正文'));
});

test('append_note 幂等续写', async () => {
  const r = root();
  const t = tools(r);
  await t.create_note.execute({ source: src(r).sourcePath, content: 'A', heading: '一' }, ctx(r));
  const out = await t.append_note.execute({ source: src(r).sourcePath, heading: '二', content: 'B' }, ctx(r));
  assert.ok(out.includes('a.md'));
  assert.ok(fs.readFileSync(path.join(r, 'a.md'), 'utf8').includes('## 二'));
});

test('.. 穿越被白名单拒绝', async () => {
  const r = root();
  const t = tools(r);
  await assert.rejects(() =>
    t.append_note.execute({ note: '../../evil.md', heading: 'h', content: 'x' }, ctx(r)));
});

test('edit_note 覆盖与 update_frontmatter', async () => {
  const r = root();
  const t = tools(r);
  await t.create_note.execute({ source: src(r).sourcePath, content: 'old', heading: '一' }, ctx(r));
  const p = path.join(r, 'a.md');
  await t.edit_note.execute({ note: 'a.md', content: 'new' }, ctx(r));
  assert.ok(fs.readFileSync(p, 'utf8').includes('new'));
  await t.update_frontmatter.execute({ note: 'a.md', key: 'tags', value: '[agent]' }, ctx(r));
  assert.ok(fs.readFileSync(p, 'utf8').includes('tags: [agent]'));
});
