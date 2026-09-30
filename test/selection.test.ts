import { test } from 'node:test';
import assert from 'node:assert';
import { requireSelection, buildTranslatePrompt, buildExplainPrompt } from '../src/selection/prompts';

test('requireSelection 拒绝空选区', () => {
  assert.throws(() => requireSelection(undefined), /请先选中文本/);
  assert.throws(() => requireSelection('   '), /请先选中文本/);
  assert.strictEqual(requireSelection(' 你好 '), '你好');
});
test('buildTranslatePrompt 输出译文+术语结构', () => {
  const { system, user } = buildTranslatePrompt('Let\'s train the agent.');
  assert.ok(system.includes('翻译') && system.includes('术语'));
  assert.ok(user.includes('Let\'s train the agent.'));
});
test('buildExplainPrompt 输出先结论后例子结构', () => {
  const { system, user } = buildExplainPrompt('ReentrantLock');
  assert.ok(system.includes('结论') && system.includes('例子'));
  assert.ok(user.includes('ReentrantLock'));
});