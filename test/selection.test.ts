import { test } from 'node:test';
import assert from 'node:assert';
import {
  requireSelection,
  buildTranslatePrompt,
  buildExplainPrompt,
  parseTranslateResult,
} from '../src/selection/prompts';

test('requireSelection 拒绝空选区', () => {
  assert.throws(() => requireSelection(undefined), /请先选中文本/);
  assert.throws(() => requireSelection('   '), /请先选中文本/);
  assert.strictEqual(requireSelection(' 你好 '), '你好');
});
test('buildTranslatePrompt 强制固定「译文+术语表」格式', () => {
  const { system, user } = buildTranslatePrompt("Let's train the agent.");
  // 固定格式行必须逐字出现（下游 parseTranslateResult 依赖）
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

/* ---- parseTranslateResult：固定格式正则提取（0.3 规范格式） ---- */
test('parseTranslateResult 提取标准固定格式', () => {
  const raw = ['译文：形式化', '术语表：', '- formalisation：形式化（用精确语言表达的过程）'].join('\n');
  const r = parseTranslateResult(raw);
  assert.strictEqual(r.translation, '形式化');
  assert.ok(r.glossary.includes('formalisation'));
  assert.ok(r.glossary.includes('形式化（用精确语言表达的过程）'));
});
test('parseTranslateResult 兼容 markdown 加粗与全角冒号变体', () => {
  const raw = '**译文：** 聚集；采集；聚会\n\n**术语表：**\n- gathering: 名词，指聚集。';
  const r = parseTranslateResult(raw);
  assert.strictEqual(r.translation, '聚集；采集；聚会');
  assert.ok(r.glossary.includes('gathering'));
  assert.ok(r.glossary.includes('名词，指聚集。'));
});
test('parseTranslateResult 无译文行时回退整段（保证非空）', () => {
  const r = parseTranslateResult('这是一段没有固定格式的输出');
  assert.strictEqual(r.translation, '这是一段没有固定格式的输出');
  assert.strictEqual(r.glossary, '');
});
test('parseTranslateResult 空输入回退空串', () => {
  const r = parseTranslateResult('');
  assert.strictEqual(r.translation, '');
});