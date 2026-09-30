# AI 学习助手（计划 2：M4-M6）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 M4-M6：Harness 侧边栏（会话/三种模式/模型/Skill/附件）、研究模式（web 搜索 + 本地检索 + 一键生成为笔记）、工作区写确认流与错误处理打磨，并产出可安装的 vsix。

**Architecture:** 单进程 VS Code 扩展。核心层 `core/agent`、`core/skills`、`core/tools`、`core/search` 为纯 TS 模块（不 import `vscode`，能力经 `ToolContext` 构造注入，可在 node:test 下单测）；Harness 以两个 Webview view（会话列表 + 对话面板）呈现，与既有划词动作联动（「AI 搜索」→ research 会话、`explainTarget=conversation` 路由）；工作区写工具走「草稿 → 确认卡 → 应用」挂起流。

**Tech Stack:** TypeScript 5.7、Node 20、VS Code API >= 1.85、node:test（同计划 1，无新增运行时依赖；网页搜索走全局 fetch）；前端为原生 HTML/CSS/JS（与 `media/pdf` 同构）。

**Spec:** `docs/superpowers/specs/2026-09-30-ai-study-helper-design.md`（本计划实现 §3 架构图中 agent/skills/tools/search/ui 部分，即 §6.2/§6.3/§6.4/§8/§11/§12/§13/§15 的 M4-M6；M0-M3 已交付）

## Global Constraints

- 与计划 1 相同：`engines.vscode` >= `^1.85.0`；TypeScript `~5.7`；`@types/vscode` `^1.85.0`；配置键前缀 `aiStudy`；命令 id 前缀 `aiStudy.`；文案中文；`npm run check` = `compile + test`。
- 核心层（`src/core/`）**禁止 `import * as vscode`**；VS Code 能力经 `ToolContext` / 构造器注入。单测必须在无 VS Code 环境下运行。
- 会话持久化：`globalStorage/conversations/<id>.json` 每会话一文件 + `index.json` 维护列表；启动仅加载索引，点开会话才读全文。
- 三种模式：`Conversation.mode: 'chat' | 'research' | 'quiz'`；`research` 强制挂 `web_search` + `search_local`。
- 工具三级权限（spec §6.4）：只读直接执行；笔记库内写需 `isInsideVault` 白名单；工作区写**必须**确认流且受 `aiStudy.enableWorkspaceWrite` 控制（默认 `true`）；untrusted 工作区只注册只读 + 笔记库写，并声明 `capabilities.untrustedWorkspaces`。
- 附件（spec §7.3）：DeepSeek 无多模态 → 图片降级为 `[图片: 路径](vscode://file/...)` 引用 + 「该图为本地文件，模型不可见」提示；文本类文件读内容截断 **8KB**；二进制仅引用。
- API Key / 网页搜索 Key 仅存 SecretStorage（`aiStudy.apiKey` / `aiStudy.webSearch.apiKey`）；日志不输出 Key。
- 实现分支：基于 `main` 新建 **`feat/m4-m6`** 实施（与计划 1 流程一致），每个任务一个 commit，完成后 merge 回 `main`。
- Harness 前端资源（`src/ui/media/`）为**源文件可提交**（与 `media/pdf/viewer.*` 一致）；`media/pdf/pdf.min.mjs` 等 vendor 产物仍忽略。

## Review Focus

1. **无 API Key 即发送** → 内联错误卡「未配置 API Key」+「去配置」按钮（执行 `aiStudy.setApiKey`），会话不崩溃、可重试。所属任务：Task 7/11。
2. **工具执行抛错** → 错误文本作为 `tool` 消息回填，循环继续而非中断整个会话。所属任务：Task 4。
3. **会话文件/索引损坏**（JSON 解析失败）→ 列表跳过损坏项不崩溃；`index.json` 缺失或损坏时按目录重建。所属任务：Task 1。
4. **确认卡挂起期间用户中止/关闭** → 待决确认 promise 以「用户取消」收尾，无悬挂、无泄漏。所属任务：Task 10。
5. **附件为图片/二进制** → 降级为本地引用 + 提示文本，绝不外发二进制内容。所属任务：Task 7。
6. **空输入/纯空白发送** → 忽略（不产生空消息、不消耗轮次）。所属任务：Task 7。
7. **research 模式未配网页搜索 Key** → 优雅降级为仅本地检索并提示，不报错。所属任务：Task 8/9。

---

### Task 1: Agent 会话模型与持久化

**Files:**
- Create: `src/core/agent/types.ts`、`src/core/agent/store.ts`、`test/agent-store.test.ts`

**Interfaces:**
- Consumes: `src/core/llm/types.ts` 的 `ToolCall`
- Produces:
  - `type ConversationMode = 'chat' | 'research' | 'quiz'`
  - `interface AgentMessage { role: 'user'|'assistant'|'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string; reasoning?: string; ts: number }`（`ts` 为毫秒时间戳；`reasoning` 为 reasoner 的思考内容，UI 折叠）
  - `interface Conversation { id: string; title: string; mode: ConversationMode; model: string; provider: string; skillIds: string[]; messages: AgentMessage[]; createdAt: number; updatedAt: number; researchSource?: string }`（`researchSource` 为「AI 搜索」划词带入的来源路径，Task 9 一键笔记使用；可缺省）
  - `interface ConversationMeta { id: string; title: string; mode: ConversationMode; updatedAt: number; messageCount: number }`
  - `function deriveTitle(text: string): string`——取首个非空行、去首尾空白、截 30 字符；空输入返回 `'新对话'`
  - `class ConversationStore`（`constructor(private readonly dir: string)`，纯 fs 操作）：
    - `list(): Promise<ConversationMeta[]>`（按 `updatedAt` 降序；`index.json` 缺失/损坏时扫描 `dir/*.json` 重建）
    - `get(id: string): Promise<Conversation | undefined>`（单文件损坏 → `undefined`，不抛）
    - `save(conv: Conversation): Promise<void>`（写 `<id>.json` + 更新 `index.json`）
    - `remove(id: string): Promise<void>`（删文件 + 更新索引）
  - 目录布局：`<dir>/<id>.json` + `<dir>/index.json`（`{ conversations: ConversationMeta[] }`）

- [ ] **Step 1: 编写失败的测试** `test/agent-store.test.ts`（临时目录 `fs.mkdtempSync`，`after` 清理）

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/agent/store` 不存在

- [ ] **Step 3: 实现 `src/core/agent/types.ts` 与 `src/core/agent/store.ts`**

`types.ts` 只含上述类型；`store.ts` 含 `deriveTitle` 与 `ConversationStore`（`save` 写文件后重建 `index.json` 单条元数据：`id/title/mode/updatedAt/messageCount`；`list` 读索引失败时列目录、逐个 `get` 试解析重建；`get` 用 `JSON.parse` try/catch）。所有读写用 `fs.promises`；`mkdir(dir, { recursive: true })` 兜底。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/agent/ test/agent-store.test.ts
git commit -m "feat(agent): 会话模型与持久化 (ConversationStore/deriveTitle)"
```

---

### Task 2: 工具框架与只读工具

**Files:**
- Create: `src/core/tools/context.ts`、`src/core/tools/readTools.ts`、`test/tools-read.test.ts`

**Interfaces:**
- Consumes: `src/core/llm/types.ts` 的 `ToolDefinition`；`src/notes/vault.ts` 的 `isInsideVault`（语义对照，不挪用）
- Produces:
  - `type ToolAccess = 'read' | 'notes' | 'workspace'`
  - `interface LocalHit { path: string; line: number; text: string }`
  - `interface WorkspaceProposal { path: string; summary: string; currentContent: string; newContent: string }`
  - `interface ToolContext { notesRoot: string; cwd?: string; readFile(rel: string, maxBytes?: number): Promise<string>; searchLocal(query: string, limit?: number): Promise<LocalHit[]>; readPdfPage?: (page?: number) => Promise<string | undefined>; listNotes(): Promise<{ path: string; title: string }[]>; confirmWorkspaceWrite?: (proposal: WorkspaceProposal) => Promise<boolean>; signal?: AbortSignal }`
  - `interface ToolHandler { definition: ToolDefinition; access: ToolAccess; execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> }`
  - `function resolveWithin(root: string, p: string): string | undefined`——`path.resolve` 后必须 `=== root` 或以 `root + path.sep` 开头，且不包含 `..` 逃逸；非法返回 `undefined`（纯函数）
  - `function localHitToString(hits: LocalHit[], limit?: number): string`——`路径:行号: 文本` 逐行，截断 `limit`（默认 5）条
  - `function readTools(): ToolHandler[]`——四个工具，`access: 'read'`：
    - `read_file { path: string, maxBytes?: number }`：`resolveWithin(ctx.cwd ?? ctx.notesRoot, path)` 校验（`cwd` 未配置时仅允许笔记库内？——**定：`cwd` 未配置时允许 `notesRoot` 内**；真实路径再经 `fs.realpath` 二次校验防符号链接逃逸）；内容超 `maxBytes`（默认 16384）截断并注 `[已截断，共 N 字节]`
    - `search_local { query: string }`：`ctx.searchLocal(query)` → `localHitToString`；无结果返回 `（无匹配）`
    - `read_pdf_page { page?: number }`：`ctx.readPdfPage` 不存在或返回空 → `（当前无打开或可读的 PDF 页）`
    - `list_notes {}`：`ctx.listNotes()` → `标题 (路径)` 逐行
  - `class ToolError extends Error`——工具内部错误（执行层捕获回填，不中断循环）

- [ ] **Step 1: 编写失败的测试** `test/tools-read.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveWithin, localHitToString, readTools, ToolError } from '../src/core/tools/readTools';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));

test('resolveWithin 拒绝 .. 与绝对路径逃逸', () => {
  const r = root();
  assert.ok(resolveWithin(r, path.join('a', 'b.txt'))?.startsWith(r));
  assert.strictEqual(resolveWithin(r, '../etc/passwd'), undefined);
  assert.strictEqual(resolveWithin(r, '/etc/passwd'), undefined);
  assert.strictEqual(resolveWithin(r, path.join(r, '..', 'x')), undefined);
});

test('localHitToString 截断条数', () => {
  const hits = Array.from({ length: 9 }, (_, i) => ({ path: '/a.md', line: i, text: `t${i}` }));
  const out = localHitToString(hits, 5);
  assert.strictEqual(out.split('\n').length, 5);
  assert.ok(out.includes('/a.md:0: t0'));
});

test('read_file 读取、截断与逃逸拒绝', async () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'a.txt'), 'x'.repeat(100));
  const ctx = { notesRoot: r, cwd: r,
    readFile: async (p: string, mb?: number) => { throw new Error('unused'); },
    searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  const out1 = await tools.read_file.execute({ path: 'a.txt' }, ctx);
  assert.strictEqual(out1, 'x'.repeat(100));
  const out2 = await tools.read_file.execute({ path: 'a.txt', maxBytes: 10 }, ctx);
  assert.ok(out2.endsWith('[已截断，共 100 字节]') && out2.startsWith('x'.repeat(10)));
  await assert.rejects(() => tools.read_file.execute({ path: '../x' }, ctx), ToolError);
});

test('search_local 与 list_notes 空结果文案', async () => {
  const ctx = { notesRoot: '/x', searchLocal: async () => [], listNotes: async () => [] };
  const tools = Object.fromEntries(readTools().map(t => [t.definition.name, t]));
  assert.strictEqual(await tools.search_local.execute({ query: 'q' }, ctx as any), '（无匹配）');
  assert.strictEqual(await tools.list_notes.execute({}, ctx as any), '（暂无笔记）');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/tools/readTools` 不存在

- [ ] **Step 3: 实现 `context.ts` 与 `readTools.ts`**

`context.ts` 放全部类型与 `ToolError`；`readTools.ts` 放 `resolveWithin`、`localHitToString` 与四个工具定义（`definition.parameters` 为 JSON Schema，`read_file` 的 `path` 描述注明「相对工作区根的路径」；工具函数内错误统一 `throw new ToolError(...)`）。`read_file` 实现：`resolveWithin` → `fs.realpath`（存在时）再 `resolveWithin` → `fs.promises.readFile`，超限截断。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/tools/ test/tools-read.test.ts
git commit -m "feat(tools): 工具框架与只读工具 (read_file/search_local/read_pdf_page/list_notes)"
```

---

### Task 3: Skills 注册表与内置 Skills

**Files:**
- Create: `src/core/skills/skill.ts`、`src/core/skills/builtin.ts`（7 个 Skill 为纯数据，单文件；如超过 250 行再拆 `builtin/` 目录）、`test/skills.test.ts`

**Interfaces:**
- Consumes: `ConversationMode`（Task 1）
- Produces:
  - `type ToolId = 'read_file'|'search_local'|'read_pdf_page'|'list_notes'|'create_note'|'append_note'|'edit_note'|'move_note'|'update_frontmatter'|'web_search'|'edit_workspace_file'`
  - `interface Skill { id: string; displayName: string; icon?: string; description: string; systemPrompt: string; tools: ToolId[]; defaultOn: boolean }`
  - `builtinSkills: Skill[]`——7 个：`translate`（翻译-解释对照）、`explain`（通俗解释+例子）、`summarize`（总结）、`quiz`（出题自测，systemPrompt 含「先出题、用户作答后批改；用户说『展示答案』给出解析，『换一题』出下一题」）、`note`（笔记助手，挂 `create_note/append_note/edit_note/move_note/update_frontmatter/list_notes`）、`search`（知识搜索与整理，挂 `web_search/search_local`）、`code`（代码考据，挂 `read_file/search_local`）
  - `export const skillIds: ToolId[]`（合法工具 id 全集，测试用）
  - `function defaultSkillIds(mode: ConversationMode): string[]`——`chat`：`defaultOn` 的 id 列表；`research`：`['search']`；`quiz`：`['quiz']`
- 说明：`systemPrompt` 为中文、学习场景、直接可注入系统提示的段落（不含工具说明——工具定义随请求下发）。

- [ ] **Step 1: 编写失败的测试** `test/skills.test.ts`

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/skills/builtin` 不存在

- [ ] **Step 3: 实现 `skill.ts` 与 `builtin.ts`**

按 Interfaces 逐字实现；`note` 的 `defaultOn: false`（笔记助手需显式开启），其余除 `code`（`false`）外 `defaultOn: true`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/skills/ test/skills.test.ts
git commit -m "feat(skills): Skill 接口与 7 个内置 Skill"
```

---

### Task 4: Agent 工具循环

**Files:**
- Create: `src/core/agent/loop.ts`、`test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`/`ChatMessage`/`Delta`/`ToolCall`/`LLMError`（`src/core/llm/types.ts`）、`AgentMessage`/`ConversationMode`（Task 1）、`Skill`（Task 3）、`ToolHandler`/`ToolContext`（Task 2）
- Produces:
  - `interface LoopHooks { onDelta?: (d: Delta) => void; onToolCall?: (call: ToolCall) => void; onToolResult?: (callId: string, result: string, ok: boolean) => void }`
  - `function buildSystemPrompt(mode: ConversationMode, skills: Skill[]): string`——基础身份（AI 学习助手，中文输出）+ 每个启用 skill 的 `systemPrompt` 段 + 模式指令：`chat` 无附加；`research`「输出格式：**结论** 后接 **来源** 列表（`[标题](url)` 或本地路径）；找不到答案时明说」；`quiz`「苏格拉底式引导，一次只提一个问题，先引导思考再揭晓」——`skills` 为空时仅基础身份
  - `interface LoopResult { messages: AgentMessage[]; aborted: boolean; truncated: boolean; error?: { kind: string; message: string; retryable: boolean } }`
  - `async function runAgentLoop(opts: { provider: LLMProvider; model: string; mode: ConversationMode; skills: Skill[]; history: AgentMessage[]; tools: ToolHandler[]; ctx: ToolContext; maxSteps: number; signal?: AbortSignal; hooks?: LoopHooks }): Promise<LoopResult>`
- 循环语义：
  1. 组装 `ChatMessage[]`（history 的 role/content/toolCalls/toolCallId + 末尾追加一条携带本轮指令的 `user` 消息——指令由调用方放入 `history` 最后一条？**定：调用方把「用户输入/附件拼接文本」作为 `history` 最后一条 user 消息传入**，本函数不再拼接）
  2. `provider.chat({ messages, model, tools: 白名单过滤后的 definitions, signal, onDelta: hooks?.onDelta })`
  3. 返回含 `toolCalls` → 逐条执行对应 `ToolHandler`（按 `call.name` 查表；`ToolError`/任意异常 → 结果文本 `[工具错误] ${message}`，`ok:false`），回填 `tool` 消息后回到 2；否则结束
  4. `maxSteps`：达到上限时**再以 `tools: []` 收尾调用一次**（保证最终文字回复）；仍失败/空 → `truncated: true` 并保留已收集消息
  5. 中止：`signal` 触发（含等待工具执行期间）→ 返回 `{ messages: 已收集, aborted: true }`，不抛
  6. LLM 错误 → `{ messages: 已收集, error: { kind, message, retryable } }`，不抛
  7. 每条产出的 `AgentMessage` 带 `ts` 时间戳；`reasoning` 透传自 `AssistantMessage.reasoning`

- [ ] **Step 1: 编写失败的测试** `test/agent-loop.test.ts`（mock provider + 假工具 + 假 ctx）

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/agent/loop` 不存在

- [ ] **Step 3: 实现 `src/core/agent/loop.ts`**

按循环语义实现；工具白名单 = `tools.filter(t => t.access !== 'workspace' || ctx.confirmWorkspaceWrite)`？**否**——白名单按模式装配（Task 7 的组装层决定传入哪些 `tools`，本层只执行传入的）。`provider.chat` 的 `tools` 传 `tools.map(t => t.definition)`；`AbortSignal` 上挂 `abort` 监听把进行中的请求/确认置为已中止（用 `signal.throwIfAborted()` 于每轮循环起始与工具执行前后检查）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/agent/loop.ts test/agent-loop.test.ts
git commit -m "feat(agent): 工具调用循环 (maxSteps/中止/错误回填/收尾)"
```

---

### Task 5: 笔记库写工具

**Files:**
- Create: `src/core/tools/noteTools.ts`、`test/tools-note.test.ts`

**Interfaces:**
- Consumes: `NoteService`/`SourceInfo`（`src/notes/noteService.ts`，M3 已交付：`openOrCreate(source, { headings })`、`appendTo(notePath, headings)`）、`isInsideVault`、`ToolHandler`/`ToolContext`（Task 2）
- Produces:
  - `function noteTools(noteService: NoteService): ToolHandler[]`（`access: 'notes'`），五个工具（参数均相对 `notesRoot` 或以来源绝对路径定位；笔记路径统一经 `isInsideVault` 白名单）：
    - `create_note { source?: string, title?: string, content: string, heading?: string }`——`source` 为来源文件绝对路径（缺省 → `Inbox`，`SourceInfo.sourceType:'none'`）；`NoteService.openOrCreate`（`titleOverride: title`）；`content` 非空再 `appendTo` 追加一段
    - `append_note { note: string, source?: string, heading: string, content: string }`——`note` 相对路径或经 `source` 派生（`noteService.notePathFor`）；`appendTo`；笔记不存在 → 先 `openOrCreate` 再追加
    - `edit_note { note: string, content: string }`——整文件覆盖（frontmatter 保留：`parseFrontmatter` 后重组）
    - `move_note { from: string, to: string }`——重命名/移动，`to` 同样白名单校验
    - `update_frontmatter { note: string, key: string, value: string }`——更新单个键
  - 每个工具返回给模型的文本：`已写入 <notePath>` / `已移动 <from> -> <to>` 等；`ToolError` 兜底白名单拒绝

- [ ] **Step 1: 编写失败的测试** `test/tools-note.test.ts`（临时 notesRoot）

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NoteService } from '../src/notes/noteService';
import { noteTools } from '../src/core/tools/noteTools';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notetools-'));
const tools = (r: string) => Object.fromEntries(noteTools(new NoteService(r)).map(t => [t.definition.name, t]));
const src = (r: string) => ({ displayName: 'a.pdf', sourcePath: path.join(r, '..', 'a.pdf'), sourceType: 'pdf' as const });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/tools/noteTools` 不存在

- [ ] **Step 3: 实现 `src/core/tools/noteTools.ts`**

按 Interfaces 实现；`create_note` 的 `source` 缺省时 `SourceInfo = { displayName: 'Inbox', sourcePath: '', sourceType: 'none' }`（`NoteService.notePathFor` 对空源的处理需核对——若无法派生，则拼 `Inbox/<title>.md`：**定：`source` 缺省时直接写 `path.join(notesRoot, 'Inbox', (title || '无标题') + '.md')` 经 `isInsideVault` 后 `openOrCreate` 同款流程**）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/tools/noteTools.ts test/tools-note.test.ts
git commit -m "feat(tools): 笔记库写工具 (create/append/edit/move/update_frontmatter)"
```

---

### Task 6: Harness 前端（会话列表 + 对话面板 webview）

**Files:**
- Create: `src/ui/protocol.ts`（纯类型）、`src/ui/media/chat.html`、`src/ui/media/chat.css`、`src/ui/media/chat.js`
- Modify: 无（装配见 Task 7）

**Interfaces:**
- Produces（`protocol.ts`，实现时可补充字段但不得改名）：
  - `type UiAttachment = { kind: 'text' | 'file' | 'image' | 'selection' | 'pdfPage'; name: string; content?: string }`
  - `type UiIn = { type: 'ready' } | { type: 'newConversation'; mode: ConversationMode; model: string; skillIds: string[] } | { type: 'send'; conversationId: string; text: string; attachments: UiAttachment[] } | { type: 'abort'; conversationId: string } | { type: 'openConversation'; id: string } | { type: 'deleteConversation'; id: string } | { type: 'renameConversation'; id: string; title: string } | { type: 'setMode'; conversationId: string; mode: ConversationMode } | { type: 'setModel'; conversationId: string; model: string } | { type: 'toggleSkill'; conversationId: string; skillId: string } | { type: 'confirmWorkspace'; conversationId: string; accept: boolean } | { type: 'saveAsNote'; conversationId: string; text: string; source?: string } | { type: 'retry'; conversationId: string } | { type: 'requestPageText' } | { type: 'pickAttachment' } | { type: 'openNote'; path: string }`
  - `type UiOut = { type: 'init'; sessions: ConversationMeta[]; models: string[]; skills: { id: string; displayName: string; description: string; defaultOn: boolean }[]; webSearchAvailable: boolean; workspaceWriteEnabled: boolean } | { type: 'conversation'; conv: Conversation } | { type: 'delta'; conversationId: string; delta: Delta } | { type: 'finalize'; conversationId: string; messageId: string; html: string } | { type: 'toolLifecycle'; conversationId: string; callId: string; name: string; status: 'running' | 'done' | 'error'; result?: string } | { type: 'error'; conversationId: string; kind: string; message: string; retryable: boolean } | { type: 'confirmRequest'; conversationId: string; proposal: WorkspaceProposal } | { type: 'confirmResolved'; conversationId: string; accepted: boolean } | { type: 'noteSaved'; path: string; created: boolean } | { type: 'pageText'; text: string } | { type: 'attachmentPicked'; attachment: UiAttachment | undefined }`
  - 说明：assistant 消息流式期间前端以 `delta` 的文本增量做转义渲染；**流结束时扩展下发 `finalize`（`renderSimpleMarkdown` 渲染结果）整体替换该消息**；「附件」按钮点击发 `pickAttachment`（扩展 `showOpenDialog` 处理后回 `attachmentPicked`）。
- 前端结构（`chat.html` 单文件，`?view=session|chat` 决定渲染分支；纯原生 JS，与 `media/pdf/viewer.js` 同风格，无框架；`acquireVsCodeApi()` 通信）：
  - `view=session`：`+ 新对话`（点击弹出模式选择：chat/research/quiz）→ `newConversation`；列表项（标题/时间/模式徽章/hover 显示「删除」「重命名」）→ `openConversation`/`deleteConversation`/`renameConversation`
  - `view=chat`：
    - 顶部：会话标题 + 模式 tab（chat/research/quiz，当前高亮）→ `setMode`
    - 消息流：`msg-user` 气泡（右）、`msg-assistant` 气泡（左，见上 `finalize` 说明）；`msg-tool` 工具卡（可折叠，默认展开前 3 行，`[展开/收起]`）；`msg-reasoning` 推理折叠（默认收起）；`msg-error` 错误卡（文案 + `[重试]`/`[去配置]` 按钮）；`confirm-card` 工作区写确认卡（`summary` + `[查看 Diff]`（`<pre>` 并排两栏展示 currentContent/newContent）+ `[应用]`/`[拒绝]`）
    - 输入区：`<textarea>`（Enter 发送、Shift+Enter 换行、Esc 清空）+ 模型 `<select>`（`init.models`）+ Skill chips（多选切换 `toggleSkill`，禁用态为灰色）+ 附件按钮（`[📎 文件]` → `pickAttachment` → `attachmentPicked` 后把附件挂到待发送队列，输入框下方显示已附件 chips 可移除）+ 发送按钮；流式进行中发送按钮变「停止」（`abort`）
    - 会话列表刷新：`init` 后渲染；`conversation` 消息整体替换当前会话 DOM
- 手工验证（F5 开发宿主）：两个 view 出现、新会话/切换模式/删除/重命名、空输入发送被忽略、流式渲染、推理折叠、错误卡。

- [ ] **Step 1: 定义 `src/ui/protocol.ts` 类型**（按 Interfaces 逐字；`tsc` 通过即可）
- [ ] **Step 2: 实现 `chat.html` / `chat.css` / `chat.js`**（按上述结构；`chat.js` 约 400-600 行，状态：`current: { conversationId, streamingMsgId }` + `sessions` 缓存；消息按 `conversationId` + 序号去重）
- [ ] **Step 3: 编译检查**

Run: `npm run compile`
Expected: 通过（注意 `src/` 在 tsconfig 的 `include` 内，`ui/media/*.js` 为纯 JS 不参与编译——需要 `tsc` 不报错即可）

- [ ] **Step 4: 提交**

```bash
git add src/ui/
git commit -m "feat(ui): Harness 前端 (会话列表/对话面板/工具卡/确认卡)"
```

---

### Task 7: Harness 装配与划词联动

**Files:**
- Create: `src/ui/sessionView.ts`、`src/ui/chatView.ts`、`src/ui/chatController.ts`、`resources/harness.svg`
- Modify: `src/extension.ts`、`package.json`、`src/pdf/pdfEditor.ts`（`ToolbarAction` 增 `'search'` + `getCurrentPageText()`）、`media/pdf/viewer.js`（工具栏加 `[AI 搜索]` 按钮；监听 `request-page-text` 回传当前页文本）

**Interfaces:**
- Consumes: `ConversationStore`（Task 1）、`runAgentLoop`/`buildSystemPrompt`（Task 4）、`builtinSkills`/`defaultSkillIds`（Task 3）、`readTools`/`noteTools`（Task 2/5）、`NoteService`（M3）、`SecretStore`（M0）
- Produces:
  - `class ChatController`（`constructor(deps: { store: ConversationStore; provider: LLMProvider; config: AppConfig; notes: NoteService; getSecrets: () => Promise<{ apiKey: string; webSearchKey: string }>; postToChat: (msg: UiOut) => void; focusChat: () => void; readPdfSelection: () => PdfSelection | undefined; readPdfPageText: (page?: number) => Promise<string | undefined>; workspace: { cwd?: string; untrusted: boolean; enabled: boolean } })`）：
    - `listSessions(): Promise<ConversationMeta[]>`
    - `newConversation(mode, model?, skillIds?): Promise<Conversation>`
    - `open(id: string): Promise<Conversation | undefined>`
    - `send(conversationId: string, text: string, attachments: UiAttachment[]): Promise<void>`——空/纯空白忽略；组装附件文本（图片→降级引用；文本→截断 8KB）拼入用户消息；`runAgentLoop`（`tools` 按模式装配：`research` 强制 `web_search`+`search_local`；`signal` 存 `activeAbort` Map）；结束后 `store.save`
    - `abort(conversationId: string): void`
    - `rename(id, title)` / `remove(id)` / `setMode` / `setModel` / `toggleSkill`（即改 `conversation.skillIds` 后 `save`）
    - `handleConfirm(conversationId, accept): void`（resolve 挂起的确认 promise）
    - `saveAsNote(conversationId, text, source?): Promise<void>`（`openOrCreate` + `appendTo`；提示 `noteSaved`）
    - `retry(conversationId): void`（重发最后一条 user 消息）
    - `explainToConversation(text: string, source?: SourceInfo): Promise<void>`（新建/复用 `chat` 会话并发送）
    - `ensureResearchSession(text: string): Promise<void>`（复用最近未完成 research 会话或新建，发送文本，`focusChat()`）
  - `createToolContext(deps)`：`ToolContext` 的 VS Code 实现——`readFile`（`vscode.workspace.fs` + `resolveWithin` + realpath）、`searchLocal`（`workspace.findFiles('**/*.{md,txt}')` 于 `cwd` 与 `notesRoot`，读前 64KB 行匹配，`LocalHit[]`）、`readPdfPage`（`pdfProvider.getCurrentPageText`）、`listNotes`（递归扫 `notesRoot` 的 `*.md`，用 `glob` 或 `findFiles`）、`confirmWorkspaceWrite`（写死为 `undefined`——工作区写确认在 Task 10 接入，Task 7 不注册 workspace 工具）
  - `buildTools(mode: ConversationMode, deps: { read: ToolHandler[]; notes: ToolHandler[]; web: ToolHandler | undefined; workspace: ToolHandler[] }): ToolHandler[]`——模式装配：`research` 强制含 `web_search`（`deps.web` 存在时）与 `search_local`；`chat`/`quiz` 为只读 + 笔记库；`workspace` 仅当 `enableWorkspaceWrite && cwd && !untrusted` 时并入（Task 10/11 的门控点）
  - `createHarnessViews(context, controller)`：两个 Webview view 的 `resolveWebviewView`（`localResourceRoots` 指 `src/ui/media`；CSP 同 `getHtml` 模式；`retainContextWhenHidden: true` 于 view 的 `options`）
- `package.json` 增补：`contributes.viewsContainers.activitybar`（`aiStudy.harness`，title 学习，icon `resources/harness.svg`）、`contributes.views.aiStudy.harness`（`aiStudy.sessionList` / `aiStudy.chatPanel`，均 `"type": "webview"`）、`activationEvents` 增 `"onView:aiStudy.sessionList"`、命令 `aiStudy.newResearchSession`（标题 `AI 学习: AI 搜索选中内容`；`editorHasSelection` 与 PDF 工具栏共用）、`capabilities.untrustedWorkspaces: { "supported": "limited", "description": "未信任工作区：仅提供只读工具与笔记库写入" }`
- 划词联动：`pdfEditor` 的 `ToolbarAction` 增 `'search'`（工具栏 `[AI 搜索]` → `toolbar-action { action: 'search' }` → `extension.ts` 的 `runPdfAction` 分支：`controller.ensureResearchSession(selection.text)`）；`explainTarget === 'conversation'` 时 `onShowResult` 的 `explain` 改走 `controller.explainToConversation`（extension.ts 路由改造）
- 手工 E2E（F5）：配置 API Key → 新建 chat 会话 → 提问 → 流式回复 + 工具卡 → 切 research → 划词「AI 搜索」→ 自动建会话并发送 → 附件（文本文件/图片降级提示）→ 历史/删除/重命名 → 无 Key 时错误卡 + 去配置。

- [ ] **Step 1: package.json 增补**（viewsContainers/views/命令/activationEvents/capabilities 按上述逐字）
- [ ] **Step 2: `ChatController` 与 `createToolContext`**（先实现 `send` 的纯装配路径：无 Key 检查 → `runAgentLoop` → `store.save` → `postToChat`；附件降级逻辑独立 `formatAttachments(attachments): { text: string }` 便于后续单测核验——**本任务加 `test/chat-attachments.test.ts`：图片降级文本、文本截断 8KB、空输入忽略**（纯函数 `formatAttachments` 放 `src/ui/attachment.ts`）**
- [ ] **Step 3: webview view 注册与消息桥**（`sessionView.ts`/`chatView.ts` 的 `resolveWebviewView`；`postToChat` 由 controller 持有当前 view 引用）
- [ ] **Step 4: 划词联动**（pdfEditor `'search'` + viewer 工具栏按钮 + `explainTarget` 路由）
- [ ] **Step 5: 运行单测**

Run: `npm test`
Expected: PASS（含 `test/chat-attachments.test.ts` 3 个用例）

- [ ] **Step 6: 手工 E2E 验收清单**（F5）：按上述「手工 E2E」逐项打勾
- [ ] **Step 7: 提交**

```bash
git add src/ui/ src/extension.ts package.json src/pdf/pdfEditor.ts media/pdf/viewer.js resources/ test/chat-attachments.test.ts
git commit -m "feat(harness): 侧边栏装配、划词联动 (AI 搜索/explainTarget) 与附件降级"
```

---

### Task 8: 网页搜索 Provider 与 web_search 工具

**Files:**
- Create: `src/core/search/provider.ts`、`src/core/search/tavily.ts`、`src/core/search/bocha.ts`、`src/core/tools/webSearchTool.ts`、`test/search.test.ts`
- Modify: `src/config.ts`（`SecretStore` 增 `getWebSearchKey(): Promise<string>`，键 `aiStudy.webSearch.apiKey`）

**Interfaces:**
- Consumes: `fetch`（全局）、`ToolHandler`（Task 2）
- Produces:
  - `interface WebResult { title: string; url: string; snippet: string }`
  - `interface WebSearchProvider { id: string; displayName: string; search(query: string, signal?: AbortSignal): Promise<WebResult[]> }`
  - `function parseTavilyResponse(json: unknown): WebResult[]`——`results[]` 的 `title/url/content`（缺失字段容错为空串；畸形返回 `[]`）
  - `function parseBochaResponse(json: unknown): WebResult[]`——`data.webPages.value[]` 的 `name/url/snippet`
  - `class TavilyProvider implements WebSearchProvider`（`constructor(getKey: () => Promise<string>)`；POST `https://api.tavily.com/search`，body `{ api_key, query, max_results: 5, include_answer: false }`；无 Key 抛 `ToolError('未配置 Tavily API Key')`）
  - `class BochaProvider implements WebSearchProvider`（POST `https://api.bochaai.com/v1/web-search`，header `Authorization: Bearer <key>`，body `{ query, summary: true, count: 5 }`）
  - `function webSearchTool(provider: WebSearchProvider | undefined): ToolHandler | undefined`——`provider` 为 `undefined`（配置 `none` 或无 Key）时返回 `undefined`（调用方不注册）；`access: 'read'`；返回 `标题\n链接\n摘要` 拼接文本，失败回填 `[搜索失败] 原因`

- [ ] **Step 1: 编写失败的测试** `test/search.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseTavilyResponse, parseBochaResponse } from '../src/core/search/tavily';
import { webSearchTool } from '../src/core/tools/webSearchTool';
import { ToolError } from '../src/core/tools/context';

test('parseTavilyResponse 容错解析', () => {
  const r = parseTavilyResponse({ results: [
    { title: 'T', url: 'https://a', content: 'c' },
    { title: '', url: 'https://b' },
  ] });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].snippet, 'c');
  assert.strictEqual(r[1].snippet, '');
  assert.deepStrictEqual(parseTavilyResponse({}), []);
  assert.deepStrictEqual(parseTavilyResponse(null), []);
});

test('parseBochaResponse 容错解析', () => {
  const r = parseBochaResponse({ data: { webPages: { value: [
    { name: 'B', url: 'https://c', snippet: 's' } ] } } });
  assert.strictEqual(r[0].title, 'B');
  assert.deepStrictEqual(parseBochaResponse({}), []);
});

test('webSearchTool 未配置时不注册', () => {
  assert.strictEqual(webSearchTool(undefined), undefined);
});

test('webSearchTool 无 Key 抛 ToolError', async () => {
  const t = webSearchTool({ id: 'tavily', displayName: 'T', search: async () => { throw new ToolError('未配置 Tavily API Key'); } })!;
  await assert.rejects(() => t.execute({ query: 'q' }, {} as any), /未配置/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/search/tavily` 不存在

- [ ] **Step 3: 实现 `provider.ts` / `tavily.ts` / `bocha.ts` / `webSearchTool.ts` 与 `SecretStore.getWebSearchKey`**

按 Interfaces；`search` 内部超时 15s（`AbortSignal.timeout` 与外部 signal 任选其一用 `AbortSignal.any`——Node 20 支持），非 200 抛 `ToolError('搜索服务返回 ' + status)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/search/ src/core/tools/webSearchTool.ts src/config.ts test/search.test.ts
git commit -m "feat(search): Tavily/博查 Provider 与 web_search 工具"
```

---

### Task 9: 研究模式闭环（来源卡 + 一键生成为笔记）

**Files:**
- Modify: `src/ui/chatView.ts`（来源链接渲染 + 结果卡 `[生成为笔记]`）、`src/ui/chatController.ts`（`saveAsNote` 路由与 `noteSaved` 回执）、`src/extension.ts`（无 Key 降级提示的装配分支）
- Create: 无（`NoteService` 已具备；无新增单测——接线层，手工验证）

**Interfaces:**
- Consumes: `ChatController.saveAsNote`（Task 7）、`renderSimpleMarkdown`（`src/util/markdown.ts`，M0）
- 行为：
  - research 模式会话：`init` 时 `webSearchAvailable: false`（无 Key）→ 前端在输入区上方提示「未配置网页搜索，仅本地检索」（Review Focus 7）
  - assistant 消息最终帧以 `renderSimpleMarkdown` 渲染（`[标题](url)` 自动成为可点击链接）
  - 结果卡（含来源链接的消息块）右下角 `[生成为笔记]`：`saveAsNote(conversationId, 该条 assistant 全文, source?)` → `openOrCreate(Inbox, { headings: [{ heading: '研究 · ' + 会话标题, body }] })` → `noteSaved { path, created }` → 前端提示「已保存到 <path>」+ `[打开笔记]`（`vscode.open` 命令由扩展处理——`UiIn` 增 `{ type: 'openNote'; path: string }`）
  - `source` 传参：本会话若由「AI 搜索」划词发起则带来源（`SelectionActions` 侧注入会话属性？——**简化：`ensureResearchSession(text, sourcePath?)` 把来源存于会话级字段 `researchSource?: string`（`Conversation` 增可选字段，Task 1 类型同步），一键笔记优先写入该来源笔记**）
- 手工 E2E（F5）：配 Tavily Key → research 会话提问「什么是注意力机制」→ 结论 + 来源卡 → `[生成为笔记]` → Inbox 出现笔记 → `[打开笔记]` 分屏；未配 Key → 降级提示 + 仅本地检索。

- [ ] **Step 1: `Conversation` 增 `researchSource?: string`**（`types.ts` 与 `store` 序列化天然兼容——JSON 可缺省）
- [ ] **Step 2: 前端来源渲染与 `[生成为笔记]`/`[打开笔记]` 接线**（`chatView.ts` + `chatView.js`；`openNote` 消息处理）
- [ ] **Step 3: controller 的 `saveAsNote`/`ensureResearchSession` 补来源传递**（`researchSource` 写入/读取）
- [ ] **Step 4: 手工 E2E 验收**
- [ ] **Step 5: 提交**

```bash
git add src/
git commit -m "feat(research): 来源卡一键生成为笔记 + 无 Key 降级提示"
```

---

### Task 10: 工作区写确认流

**Files:**
- Create: `src/core/tools/workspaceTools.ts`、`test/tools-workspace.test.ts`
- Modify: `src/ui/chatView.ts`（确认卡渲染：`[查看 Diff]` 展开两栏 `<pre>`、`[应用]`/`[拒绝]`）、`src/ui/chatController.ts`（挂起 promise 表 + `handleConfirm` + `abort` 时拒绝）、`src/extension.ts`（`createToolContext` 提供 `confirmWorkspaceWrite` 实现与 `enableWorkspaceWrite` 门控）

**Interfaces:**
- Consumes: `WorkspaceProposal`/`ToolContext`（Task 2）、`resolveWithin`（Task 2）、`ChatController.handleConfirm`（Task 7）
- Produces:
  - `function workspaceTools(): ToolHandler[]`——单个工具 `edit_workspace_file { path: string, content: string, summary: string }`，`access: 'workspace'`
  - 执行语义：
    1. `ctx.cwd` 未配置 → `ToolError('未打开工作区')`
    2. `resolveWithin(ctx.cwd, path)` + `fs.realpath` 二次校验失败 → `ToolError('路径不在工作区内')`
    3. `ctx.confirmWorkspaceWrite` 未提供 → `ToolError('工作区写入未启用（aiStudy.enableWorkspaceWrite）')`
    4. 读 `currentContent`（不存在 → 空串，视为新建）→ 挂起 `await ctx.confirmWorkspaceWrite({ path, summary, currentContent, newContent: content })`
    5. `true` → `fs.promises.writeFile`（含 mkdir）→ 返回 `已写入 <path>（<summary>）`；`false`/`undefined` → 返回 `用户已拒绝写入 <path>`
    6. 挂起期间 `signal` abort → 抛 `ToolError('已取消')`
  - `ChatController` 增：`pendingConfirms: Map<conversationId, { resolve: (v: boolean) => void; reject: (e: Error) => void }>`；`confirmRequester(conversationId): (proposal: WorkspaceProposal) => Promise<boolean>`（入表 + `postToChat({ type: 'confirmRequest', ... })`；`handleConfirm` resolve；`abort`/会话关闭时 reject「已取消」）；确认期间同一会话只有一张卡（再次调用前先 resolve 前一张为 `false`）
- 装配（extension.ts）：`buildTools(mode, deps)`——`enableWorkspaceWrite && cwd && !untrusted` 时才 `[..., ...workspaceTools()]`（Review Focus：untrusted 不注册）
- 测试（`test/tools-workspace.test.ts`，临时目录）：

```ts
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
    cwd: c, confirmWorkspaceWrite: async (p) => { proposed = p; return true; },
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
```

- [ ] **Step 1: 编写失败的测试** `test/tools-workspace.test.ts`
- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/tools/workspaceTools` 不存在

- [ ] **Step 3: 实现 `workspaceTools.ts` 与确认挂起接线**（ChatController `pendingConfirms`/`confirmRequester`/`handleConfirm`/`abort`；extension `createToolContext` 提供真实确认实现 + 门控注册）
- [ ] **Step 4: 运行测试确认通过 + 编译**

Run: `npm test && npm run compile`
Expected: PASS（3 个用例）+ 编译通过

- [ ] **Step 5: 手工 E2E**：`enableWorkspaceWrite: true` → chat 模式让模型改工作区文件（系统提示引导）→ 确认卡 → `[查看 Diff]` 两栏展示 → `[应用]` 写入 / `[拒绝]` 不写 → 流式进行中 `abort` 时挂起确认被取消；`enableWorkspaceWrite: false` → 工具不出现在请求中
- [ ] **Step 6: 提交**

```bash
git add src/core/tools/workspaceTools.ts src/ui/chatView.ts src/ui/chatController.ts src/extension.ts test/tools-workspace.test.ts
git commit -m "feat(tools): 工作区写确认流 (草稿→确认卡→应用)"
```

---

### Task 11: 错误处理打磨

**Files:**
- Create: `src/core/llm/retry.ts`、`test/llm-retry.test.ts`
- Modify: `src/extension.ts`（`chat` 与 `actions` 的 LLM 调用统一走 `chatWithRetry`；错误卡路由：noApiKey/contextLength 引导）、`src/ui/chatView.ts`（错误卡按钮：`[去配置]`/`[重试]`/`[新建会话]`）、`media/pdf/viewer.js`（核对 PDF 加载失败的错误占位 + 重新加载按钮，缺失则补）

**Interfaces:**
- Consumes: `LLMProvider`/`ChatRequest`/`AssistantMessage`/`LLMError`（`src/core/llm/types.ts`）
- Produces:
  - `async function chatWithRetry(provider: LLMProvider, req: ChatRequest, delaysMs: number[] = [1000, 2000]): Promise<AssistantMessage>`——`LLMError.kind === 'rateLimit'` 时按 `delaysMs` 逐档 `setTimeout` 重试（最后一次失败原样抛出）；其余错误直接抛；成功返回
- 错误卡统一（chat 内联 `msg-error`）：`noApiKey` → 「未配置 API Key」+ `[去配置]`（`aiStudy.setApiKey`）；`rateLimit`/`network` → 文案 + `[重试]`（`retry`）；`contextLength` → 「上下文过长，请精简或新建会话」+ `[新建会话]`；`unknown` → message 原文。`retry` 实现：重发该会话最后一条 user 消息（不走附件）。
- untrusted 工作区：`buildTools` 已剔除 workspace 工具（Task 10）；chat 顶部提示「受限工作区：仅只读与笔记库」。
- PDF 加载失败：`openPdf` 的 catch 已有错误占位——核对「重新加载」按钮存在，缺失则补（`pdf:error` → 面板 [重试] 重新 `openPdf`）。
- 测试（`test/llm-retry.test.ts`）：mock provider 前两次抛 `rateLimit`、第三次成功 → 调用 3 次且返回成功；一直 `rateLimit` → 抛且调用 3 次；非 rateLimit（`network`）→ 只调用 1 次。

- [ ] **Step 1: 编写失败的测试** `test/llm-retry.test.ts`
- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/core/llm/retry` 不存在

- [ ] **Step 3: 实现 `retry.ts` 并接线**（`actions` 与 `ChatController.send` 的 `provider.chat` 换 `chatWithRetry`；错误卡按上述分类；`doc` 处理：`activeAbort` 中止不重试）
- [ ] **Step 4: 运行测试确认通过 + 编译**

Run: `npm test && npm run compile`
Expected: PASS + 通过

- [ ] **Step 5: 提交**

```bash
git add src/core/llm/retry.ts src/extension.ts src/ui/chatView.ts media/pdf/viewer.js test/llm-retry.test.ts
git commit -m "fix(llm): 429 指数退避重试与错误卡统一路由"
```

---

### Task 12: 打包 vsix 与完成定义

**Files:**
- Modify: `README.md`（Harness/研究模式/确认流/限制说明：`window.restoreWindows` 方案已弃用、`explainTarget`、附件降级规则）、`docs/2026-09-30-pdf-reader-known-issues.md`（「方案 A：自管 WebviewPanel」标记为**计划 2 之后**的 backlog 项）、`.vscodeignore`（核对不排除 `out/` 与 `media/`、`resources/`——`src/**` 本就是排除项，`src/ui/media` 需在**编译期**由 `copy 到 out 或改为 `media/`？——**关键决策：`media/chat` 静态资源放 `src/ui/media/` 则被打包排除，需在 `npm run compile` 时复制到 `out/ui/media/`（`copy-pdf-assets.js` 同款脚本 `scripts/copy-chat-assets.js`）且 `getHtml` 从 `out` 读取——本任务实现并验证**）
- 注：`scripts/copy-chat-assets.js`：复制 `src/ui/media/` → `out/ui/media/`（幂等）；`package.json` script `compile` 追加 `&& node scripts/copy-chat-assets.js`；`chatView.ts` 的 `localResourceRoots` 与资源 URI 指向 `out/ui/media`（extension 运行时代码在 `out/` 下，`context.extensionUri/out/...`）

**验证:**
- [ ] `npm run check` 全绿（compile + 全部单测）
- [ ] `npm run package` 产出 `.vsix`（体积与计划 1 同量级；含 `out/ui/media` 与 `resources/`）
- [ ] F5 全链路手工 E2E：读 PDF → 划词（翻译/解释 popover）→ 加笔记 → 分屏续写 → Harness 三种模式 → 附件（文件/图片降级）→ research 一键笔记 → 工作区写确认流 → 无 Key/断网错误卡 → untrusted 工作区降级
- [ ] merge：`git checkout main && git merge --no-ff feat/m4-m6 && git push`
- [ ] 提交

```bash
git add README.md docs/2026-09-30-pdf-reader-known-issues.md scripts/copy-chat-assets.js package.json src/ui/chatView.ts .vscodeignore
git commit -m "chore: 打包 vsix、README 与完成定义 (计划 2)"
```

---

## 计划 2 完成定义

- [ ] Harness 侧边栏（会话列表 + 对话面板）：新建/历史/删除/重命名、三种模式切换、模型选择、Skill chips、附件（含图片降级）
- [ ] Agent 循环：工具调用、maxSteps 收尾、中止、错误回填、流式渲染（含 reasoning 折叠）
- [ ] 研究模式：web 搜索（Tavily/博查）+ 本地检索 + 来源卡 + 一键生成为笔记；无 Key 优雅降级
- [ ] 工作区写确认流：草稿 → 确认卡（Diff 两栏）→ 应用/拒绝；`enableWorkspaceWrite` 与 untrusted 门控
- [ ] 错误处理：429 重试一次、错误卡分类（noApiKey/network/rateLimit/contextLength/unknown）、PDF 加载失败重载按钮
- [ ] 划词联动：「AI 搜索」→ research 会话；`explainTarget=conversation` 路由
- [ ] `npm run check` 全绿；`npm run package` 产出 vsix；README 与已知问题文档更新
- [ ] `feat/m4-m6` merge 回 `main`

## 开放依赖（不阻塞本计划，实现时确认）

- `media/pdf/viewer.js` 的「AI 搜索」按钮与「当前页文本」消息需在 Task 7 与 pdfEditor 同步小改（工具函数已预留）。
- Tavily/博查的实际响应字段以线上为准，解析函数需容忍缺字段（容错已由测试覆盖）。
- 计划 2 之后（即「整个项目完成后再细改」）：PDF 阅读器方案 A（自管 `WebviewPanel` + `WebviewPanelSerializer`）与 OCR 预留，见已知问题文档与 spec §2。