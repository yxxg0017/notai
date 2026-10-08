import { test } from 'node:test';
import assert from 'node:assert';
import { runAgentLoop, buildSystemPrompt } from '../src/core/agent/loop';
import type { LLMProvider, AssistantMessage, ToolCall } from '../src/core/llm/types';
import type { ToolHandler, ToolContext } from '../src/core/tools/context';

const call = (id: string, name: string, args: string): ToolCall => ({ id, name, arguments: args });
const tool = (name: string, result: string, fail = false): ToolHandler => ({
  access: 'read',
  definition: { name, description: '', parameters: {} },
  execute: async () => { if (fail) throw new Error('boom'); return result; },
});
const ctx = {} as ToolContext;
const mkProvider = (script: AssistantMessage[]): LLMProvider => {
  let i = 0;
  return { name: 'mock', capabilities: { supportsTools: true, supportsImages: false, supportsReasoning: true },
    chat: async () => script[Math.min(i++, script.length - 1)] };
};
const base = { model: 'm', mode: 'chat' as const, skills: [], tools: [tool('t1', 'R1')], ctx, maxSteps: 3 };

test('单轮无工具调用直接返回', async () => {
  const r = await runAgentLoop({ ...base, provider: mkProvider([{ content: '你好' }]), history: [] });
  assert.strictEqual(r.messages.length, 1);
  assert.strictEqual(r.messages[0].content, '你好');
  assert.strictEqual(r.messages[0].ts > 0, true);
});

test('工具调用回填后继续到最终回复', async () => {
  const provider = mkProvider([
    { content: '', toolCalls: [call('c1', 't1', '{}')] },
    { content: '最终答案' },
  ]);
  const r = await runAgentLoop({ ...base, provider, history: [] });
  assert.strictEqual(r.messages.length, 3); // assistant(tool) + tool + assistant
  assert.strictEqual(r.messages[1].role, 'tool');
  assert.strictEqual(r.messages[1].content, 'R1');
  assert.strictEqual(r.messages[2].content, '最终答案');
});

test('工具抛错回填错误文本不中断', async () => {
  const provider = mkProvider([
    { content: '', toolCalls: [call('c1', 't1', '{}')] },
    { content: '补救' },
  ]);
  const r = await runAgentLoop({ ...base, provider, tools: [tool('t1', '', true)], history: [] });
  assert.ok(r.messages[1].content.includes('[工具错误] boom'));
  assert.strictEqual(r.messages[2].content, '补救');
});

test('maxSteps 达到后无工具收尾', async () => {
  let calls = 0;
  const provider: LLMProvider = { name: 'm', capabilities: { supportsTools: true, supportsImages: false, supportsReasoning: true },
    chat: async (req) => { calls++; return calls <= 2 ? { content: '', toolCalls: [call('c' + calls, 't1', '{}')] } : { content: '收尾' }; } };
  const r = await runAgentLoop({ ...base, provider, maxSteps: 2, history: [] });
  assert.strictEqual(calls, 3); // 2 轮工具 + 1 次无工具收尾
  assert.strictEqual(r.messages[r.messages.length - 1].content, '收尾');
});

test('中止返回 aborted 且不抛', async () => {
  const ac = new AbortController();
  const provider: LLMProvider = { name: 'm', capabilities: { supportsTools: true, supportsImages: false, supportsReasoning: true },
    chat: async (req) => { ac.abort(); return { content: 'x' }; } };
  const r = await runAgentLoop({ ...base, provider, history: [], signal: ac.signal });
  assert.strictEqual(r.aborted, true);
});

test('buildSystemPrompt 含模式指令与 skill 段', () => {
  const p = buildSystemPrompt('research', [{ id: 'search', displayName: 'x', description: '', systemPrompt: '【搜索技能】', tools: [], defaultOn: false }]);
  assert.ok(p.includes('【搜索技能】') && p.includes('来源'));
});
