import { test } from 'node:test';
import assert from 'node:assert';
import { requireSelection, buildTranslatePrompt, buildExplainPrompt } from '../src/selection/prompts';

test('requireSelection 拒绝空选区', () => {
  assert.throws(() => requireSelection(undefined), /请先选中文本/);
  assert.throws(() => requireSelection('   '), /请先选中文本/);
  assert.strictEqual(requireSelection(' 你好 '), '你好');
});
test('buildTranslatePrompt 固定「译文+术语表」格式', () => {
  const { system, user } = buildTranslatePrompt("Let's train the agent.");
  assert.ok(system.includes('译文：<中文译文>'), 'system 应含固定译文行模板');
  assert.ok(system.includes('术语表：'), 'system 应含术语表标题');
  assert.ok(system.includes('- <英文术语>：<中文释义>'), 'system 应含术语行模板');
  assert.ok(user.includes("Let's train the agent."));
});
test('buildExplainPrompt 输出先结论后例子结构', () => {
  const { system, user } = buildExplainPrompt('ReentrantLock');
  assert.ok(system.includes('结论') && system.includes('例子'));
  assert.ok(user.includes('ReentrantLock'));
});