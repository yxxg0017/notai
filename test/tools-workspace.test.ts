import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { workspaceTools } from '../src/core/tools/workspaceTools';

const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const tool = () => workspaceTools()[0];

test('确认接受后写入文件', async () => {
  const c = cwd();
  let proposed: any;
  const out = await tool().execute({ path: 'a.txt', content: 'hello', summary: '新建' }, {
    cwd: c, confirmWorkspaceWrite: async (p: any) => { proposed = p; return true; },
  } as any);
  assert.ok(out.includes('a.txt'));
  assert.strictEqual(fs.readFileSync(path.join(c, 'a.txt'), 'utf8'), 'hello');
  assert.strictEqual(proposed.newContent, 'hello');
});

test('确认拒绝不写入', async () => {
  const c = cwd();
  const out = await tool().execute({ path: 'a.txt', content: 'x', summary: 's' }, {
    cwd: c, confirmWorkspaceWrite: async () => false,
  } as any);
  assert.ok(out.includes('拒绝'));
  assert.strictEqual(fs.existsSync(path.join(c, 'a.txt')), false);
});

test('路径逃逸与未启用拒绝', async () => {
  const c = cwd();
  await assert.rejects(() => tool().execute({ path: '../x', content: 'x', summary: 's' }, { cwd: c } as any), /工作区/);
  await assert.rejects(() => tool().execute({ path: 'a.txt', content: 'x', summary: 's' }, { cwd: c } as any), /未启用/);
});