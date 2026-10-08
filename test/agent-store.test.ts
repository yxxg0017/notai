import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConversationStore, deriveTitle } from '../src/core/agent/store';
import type { Conversation } from '../src/core/agent/types';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-'));

const conv = (id: string, title = '新对话'): Conversation => ({
  id, title, mode: 'chat', model: 'deepseek-chat', provider: 'deepseek', skillIds: [],
  messages: [], createdAt: 1, updatedAt: 2,
});

test('deriveTitle 取首行并截断', () => {
  assert.strictEqual(deriveTitle('  你好世界  '), '你好世界');
  assert.strictEqual(deriveTitle('a'.repeat(50)), 'a'.repeat(30));
  assert.strictEqual(deriveTitle('\n\n'), '新对话');
});

test('store save/get 往返并维护索引', async () => {
  const d = dir();
  const s = new ConversationStore(d);
  const c = conv('c1', '标题一');
  c.messages.push({ role: 'user', content: 'hi', ts: 10 });
  await s.save(c);
  const got = await s.get('c1');
  assert.strictEqual(got?.title, '标题一');
  assert.strictEqual(got?.messages.length, 1);
  const metas = await s.list();
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].messageCount, 1);
  assert.strictEqual(metas[0].mode, 'chat');
});

test('index.json 缺失时重建', async () => {
  const d = dir();
  const s = new ConversationStore(d);
  await s.save(conv('c1'));
  await s.save(conv('c2'));
  fs.rmSync(path.join(d, 'index.json'));
  const metas = await s.list();
  assert.deepStrictEqual(metas.map(m => m.id).sort(), ['c1', 'c2']);
  assert.ok(fs.existsSync(path.join(d, 'index.json')), '重建索引');
});

test('损坏的会话文件与索引不崩溃', async () => {
  const d = dir();
  const s = new ConversationStore(d);
  await s.save(conv('c1'));
  fs.writeFileSync(path.join(d, 'c1.json'), '{not json');
  fs.writeFileSync(path.join(d, 'index.json'), 'not json');
  const metas = await s.list();
  assert.deepStrictEqual(metas, [], '索引损坏 → 重建后 c1 损坏被跳过');
  assert.strictEqual(await s.get('c1'), undefined);
});

test('remove 删除文件与索引项', async () => {
  const d = dir();
  const s = new ConversationStore(d);
  await s.save(conv('c1'));
  await s.remove('c1');
  assert.strictEqual(await s.get('c1'), undefined);
  assert.strictEqual((await s.list()).length, 0);
});
