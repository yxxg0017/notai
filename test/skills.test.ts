import { test } from 'node:test';
import assert from 'node:assert';
import { builtinSkills, defaultSkillIds, skillIds } from '../src/core/skills/builtin';

test('内置 7 个 Skill，id 唯一且工具 id 合法', () => {
  assert.strictEqual(builtinSkills.length, 7);
  const ids = builtinSkills.map(s => s.id);
  assert.strictEqual(new Set(ids).size, 7);
  for (const s of builtinSkills) {
    for (const t of s.tools) assert.ok(skillIds.includes(t), `${s.id} 引用非法工具 ${t}`);
    assert.ok(s.systemPrompt.length > 20, `${s.id} 缺少 systemPrompt`);
  }
});

test('defaultSkillIds 按模式返回', () => {
  const chat = defaultSkillIds('chat');
  assert.ok(chat.includes('translate') && chat.includes('summarize'));
  assert.deepStrictEqual(defaultSkillIds('research'), ['search']);
  assert.deepStrictEqual(defaultSkillIds('quiz'), ['quiz']);
});

test('search 工具白名单含 web_search 与 search_local', () => {
  const search = builtinSkills.find(s => s.id === 'search');
  assert.ok(search!.tools.includes('web_search'));
  assert.ok(search!.tools.includes('search_local'));
});
