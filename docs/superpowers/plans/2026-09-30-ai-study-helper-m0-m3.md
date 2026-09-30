# AI 学习助手（计划 1：M0-M3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ai-study-helper 插件的 M0-M3：项目脚手架、DeepSeek 客户端、PDF 阅读器（含内嵌划词浮动工具栏）、续写式笔记系统与全局单词本，达成「读 PDF → 划词学习 → 记笔记」的可用闭环。

**Architecture:** 单进程 VS Code 扩展。核心层（llm / notes）为纯 TS 模块、不 import `vscode`，通过构造器注入依赖，可独立单测；PDF 阅读器为 Custom Editor + PDF.js webview；划词动作在扩展宿主编排，结果在 PDF 页内 popover（编辑器内为结果面板）展示。

**Tech Stack:** TypeScript 5.7、Node 20、VS Code API >= 1.85、pdfjs-dist ^4.10.38（唯一运行时依赖）、node:test 测试、vsce 打包。

**Spec:** `docs/superpowers/specs/2026-09-30-ai-study-helper-design.md`（本计划只实现其中 §4/§5/§6.1/§7/§9/§10/§13/§14 的 M0-M3 部分；M4-M6 见后续计划 2）

## Global Constraints

- `engines.vscode` >= `^1.85.0`；TypeScript `~5.7`；`@types/vscode` `^1.85.0`。
- 配置键一律前缀 `aiStudy`，键名与默认值逐字取自 spec §5：`notesRoot=~/Documents/StudyNotes`、`provider=deepseek`、`baseUrl=https://api.deepseek.com/v1`、`model=deepseek-chat`、`models=["deepseek-chat","deepseek-reasoner"]`、`maxSteps=8`、`sidePanelWidth=45`、`enableWorkspaceWrite=true`、`explainTarget=popover`；`apiKey` 仅存 SecretStorage（`"restricted": true`）。
- 命令 id 前缀 `aiStudy.`；命令/菜单文案为中文（与 pico-reading-vscode 风格一致）。
- 核心层（`src/core/llm/`、`src/notes/`）禁止 `import * as vscode`；VS Code 能力经构造器参数注入。`node:test` 单测必须可在无 VS Code 环境下运行（`npm test` 不启动扩展宿主）。
- 笔记库写路径白名单：任何写操作前必须通过 `isInsideVault` 校验（拒绝 `..`、绝对路径逃逸）。
- API Key 不得写入日志或配置导出。
- PDF 阅读器保留 `pico-reading-vscode` 已验证的 vendor 方式：`scripts/copy-pdf-assets.js` 将 `pdfjs-dist` 的 `build/pdf.min.mjs`、`pdf.worker.min.mjs`、`cmaps/` 复制到 `media/pdf/`。
- 已知实现限制（写入 README）：VS Code 无公开 API 精确控制分屏宽度，笔记以 `ViewColumn.Beside` 打开，`sidePanelWidth` 配置键本计划仅保留不生效。

## Review Focus

1. **空选区/无源文本**：用户未选中文本时执行划词命令 → 提示「请先选中文本」，不抛未捕获异常。所属任务：Task 5（`requireSelection` 单测）。
2. **笔记已存在**：对同一来源第二次「添加笔记」→ 打开既有文件续写、不覆盖、`created:false`。所属任务：Task 4（`openOrCreate` 幂等单测）。
3. **路径穿越**：`notesRoot/../x.md`、绝对路径、符号链接逃逸 → `isInsideVault` 返回 false，写操作拒绝。所属任务：Task 4。
4. **扫描版 PDF 无文字层**：选中文本为空 → 页内提示「无文本层」，提供「手动添加笔记」入口，不崩溃。所属任务：Task 3（`classifyPageText` 单测）。
5. **模型服务非 200 / 流中断**：401/429/5xx 与 SSE 中断 → 映射为分类错误卡（auth/rateLimit/network），rateLimit 标记 `retryable:true`，UI 提供重试。所属任务：Task 2（`mapHttpError`、`parseSseChunk` 单测）。

---

### Task 1: 项目脚手架 + 配置模块

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`、`LICENSE`、`.vscodeignore`、`scripts/copy-pdf-assets.js`、`src/config.ts`、`src/extension.ts`、`test/config.test.ts`
- Modify: 无

**Interfaces:**
- Consumes: 无（本任务建立全部基础）
- Produces:
  - `loadConfig(): AppConfig`（`src/config.ts`，同步读取 `workspace.getConfiguration('aiStudy')`）
  - `class SecretStore { constructor(storage: vscode.SecretStorage); getApiKey(): Promise<string>; setApiKey(v: string): Promise<void>; }`（`secrets.aiStudy.apiKey`）
  - 命令：`aiStudy.setApiKey`（工作流：输入 → `setApiKey` → 提示成功）
  - `npm run compile` / `npm test` / `npm run check` / `npm run package` 可用

- [ ] **Step 1: 生成 package.json 与 tsconfig.json**

`package.json` 关键字段：`name: "ai-study-helper"`、`displayName: "AI 学习助手"`、`publisher: "pico-local"`、`version: "0.1.0"`、`engines.vscode: "^1.85.0"`、`main: "./out/extension.js"`、`activationEvents: ["onStartupFinished","onCustomEditor:aiStudy.pdfEditor"]`、`contributes.commands` 仅注册：`aiStudy.openPdf`、`aiStudy.translateSelection`、`aiStudy.explainSelection`、`aiStudy.copySelection`、`aiStudy.addNoteFromSelection`、`aiStudy.addToWordBook`、`aiStudy.setApiKey`（各命令中文标题，如 `AI 学习: 添加笔记`）、`contributes.menus.editor/context` 六条 `when: "editorHasSelection"`（`openPdf` 在 `explorer/context` 且 `when: "resourceExtname == .pdf"`）、`contributes.customEditors`（viewType `aiStudy.pdfEditor`、`*.pdf`、`priority: "default"`）、`contributes.configuration` 全部 `aiStudy.*` 键与默认值（见 Global Constraints，`apiKey` 设 `"scope": "machine", "restricted": true`）、scripts：`compile: "npm run copy-pdf-assets && tsc -p tsconfig.json"`、`test: "tsc -p tsconfig.test.json && node --test out-test/test/"`、`check`、`package: "npm run compile && npx vsce package --no-dependencies"`；deps 仅 `pdfjs-dist: "^4.10.38"`，devDeps：`typescript ~5.7`、`@types/vscode ^1.85.0`、`@types/node 20.x`、`@vscode/vsce ^3.2.2`。

`tsconfig.json`：`outDir: "out"`、`rootDir: "src"`、`strict: true`、`module: "commonjs"`、`target: "ES2022"`、`lib: ["ES2022","DOM"]`；`tsconfig.test.json` 另配 `rootDir: "."`、`outDir: "out-test"`、`include: ["src","test"]`。

- [ ] **Step 2: 编写 copy-pdf-assets.js 与 .gitignore**

`scripts/copy-pdf-assets.js`：从 `node_modules/pdfjs-dist` 复制 `build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/` 到 `media/pdf/`（幂等，`fs.cp` 递归）。`.gitignore`：`node_modules/`、`out/`、`out-test/`、`*.vsix`、`media/pdf/pdf.min.mjs`、`media/pdf/pdf.worker.min.mjs`、`media/pdf/cmaps/`（**仅忽略 PDF.js 构建产物；`media/pdf/viewer.html/js/css` 为源文件，必须可提交**）。

- [ ] **Step 3: 编写失败的配置测试** `test/config.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { expandHome, DEFAULT_NOTES_ROOT } from '../src/util/paths';

test('expandHome 展开 ~ 为 home 目录', () => {
  assert.strictEqual(expandHome('~/x'), `${process.env.HOME}/x`);
  assert.strictEqual(expandHome('/abs/x'), '/abs/x');
});
test('默认笔记库为 ~/Documents/StudyNotes', () => {
  assert.strictEqual(DEFAULT_NOTES_ROOT, '~/Documents/StudyNotes');
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `../src/util/paths` 不存在

- [ ] **Step 5: 实现 `src/util/paths.ts`、`src/config.ts` 与最小 `src/extension.ts`**

- `src/util/paths.ts`（**纯模块，不 import `vscode`**，供 `node:test` 直接测试）：`expandHome(p: string): string`（`~` 前缀替换为 `os.homedir()`，其余原样）、`DEFAULT_NOTES_ROOT = '~/Documents/StudyNotes'`
- `AppConfig` 接口（字段照抄 Global Constraints 配置键；`webSearchProvider: 'tavily'|'bocha'|'none'`（Tavily/博查为计划 2 预留给值））
- `loadConfig(): AppConfig` 从 `vscode.workspace.getConfiguration('aiStudy')` 读取并展开 notesRoot（复用 `src/util/paths.ts`）
- `SecretStore`：`secretStorage.get/set('aiStudy.apiKey')`
- `extension.ts`：`activate()` 注册 `aiStudy.setApiKey`（`showInputBox: { password: true, prompt: '输入 DeepSeek API Key' }` → `setApiKey` → `showInformationMessage('API Key 已保存')`）；其余命令注册空实现占位（`registerCommand(id, () => {})`），后续任务填充；`deactivate()` 空

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test`
Expected: PASS（2 个用例）

- [ ] **Step 7: 提交**

```bash
git add package.json tsconfig.json tsconfig.test.json .gitignore LICENSE .vscodeignore scripts/ src/ test/
git commit -m "feat: 项目脚手架与配置模块 (aiStudy.* 配置/SecretStorage)"
```

---

### Task 2: LLM 类型与 DeepSeek 客户端（流式/工具调用/推理）

**Files:**
- Create: `src/core/llm/types.ts`、`src/core/llm/deepseek.ts`、`test/llm-deepseek.test.ts`
- Modify: `src/extension.ts`（无——仅导入检查；如不需要可不改）

**Interfaces:**
- Consumes: `SecretStore`（Task 1）
- Produces:
  - `type ChatRole = 'system'|'user'|'assistant'|'tool'`
  - `interface ToolCall { id: string; name: string; arguments: string }`
  - `interface ChatMessage { role: ChatRole; content: string; toolCalls?: ToolCall[]; toolCallId?: string }`
  - `interface ToolDefinition { name: string; description: string; parameters: object }`
  - `interface ChatRequest { messages: ChatMessage[]; model: string; tools?: ToolDefinition[]; temperature?: number; signal?: AbortSignal; onDelta?: (d: Delta) => void }`
  - `type Delta = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'toolCall'; index: number; id?: string; name?: string; argumentsDelta?: string }`
  - `interface AssistantMessage { content: string; reasoning?: string; toolCalls?: ToolCall[] }`
  - `interface ProviderCapabilities { supportsTools: boolean; supportsImages: boolean; supportsReasoning: boolean }`
  - `interface LLMProvider { name: string; capabilities: ProviderCapabilities; chat(req: ChatRequest): Promise<AssistantMessage> }`
  - `class LLMError extends Error { kind: 'noApiKey'|'network'|'rateLimit'|'auth'|'contextLength'|'unknown'; retryable: boolean }`
  - `class DeepSeekProvider implements LLMProvider`（`constructor(getApiKey: () => Promise<string>, baseUrl: string, model: string)`；`capabilities = { supportsTools: true, supportsImages: false, supportsReasoning: true }`）
  - `function parseSseChunk(line: string): { text?: string; reasoning?: string; toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string }; finish?: boolean } | null`（纯函数）
  - `function mapHttpError(status: number, body: string): LLMError`

- [ ] **Step 1: 编写失败的测试** `test/llm-deepseek.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSseChunk, mapHttpError, DeepSeekProvider } from '../src/core/llm/deepseek';
import { LLMError } from '../src/core/llm/types';

test('parseSseChunk 解析内容增量', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"content":"你好"}}]}');
  assert.strictEqual(d?.text, '你好');
});
test('parseSseChunk 解析推理增量', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}');
  assert.strictEqual(d?.reasoning, '思考');
});
test('parseSseChunk 解析 tool_calls 增量并归并', () => {
  const d = parseSseChunk('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"p"}}]}}]}');
  assert.strictEqual(d?.toolCall?.index, 0);
  assert.strictEqual(d?.toolCall?.id, 'call_1');
  assert.strictEqual(d?.toolCall?.name, 'read_file');
  assert.strictEqual(d?.toolCall?.argumentsDelta, '{"p');
});
test('parseSseChunk 忽略非 data 行与结束行', () => {
  assert.strictEqual(parseSseChunk(': keep-alive'), null);
  assert.strictEqual(parseSseChunk('data: [DONE]'), null);
});
test('mapHttpError 分类错误', () => {
  assert.strictEqual(mapHttpError(401, '').kind, 'auth');
  assert.strictEqual(mapHttpError(429, '').kind, 'rateLimit');
  assert.strictEqual(mapHttpError(400, 'context length exceeded').kind, 'contextLength');
  assert.strictEqual(mapHttpError(503, '').kind, 'network');
  assert.strictEqual(mapHttpError(429, '').retryable, true);
  assert.strictEqual(mapHttpError(401, '').retryable, false);
});
test('DeepSeekProvider chat 发送流式请求并聚合', async () => {
  // mock fetch: 返回 ReadableStream，两个 chunk 各含一个文本增量，最后 finish_reason=stop
  const calls: { url: string; init: any }[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"B"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return { ok: true, status: 200, body } as any;
  };
  const p = new DeepSeekProvider(async () => 'sk-test', 'https://api.deepseek.com/v1', 'deepseek-chat');
  const deltas: string[] = [];
  const msg = await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat', onDelta: (d) => { if (d.type === 'text') deltas.push(d.text); } });
  assert.strictEqual(msg.content, 'AB');
  assert.deepStrictEqual(deltas, ['A', 'B']);
  assert.ok(calls[0].url.startsWith('https://api.deepseek.com/v1/chat/completions'));
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-test');
});
```

（说明：`ChatRequest` 需含 `onDelta?: (d: Delta) => void` 回调字段，测试以上述断言锁定。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/core/llm/types.ts`**

按 Interfaces 原样定义全部类型与 `LLMError`（`kind` 联合与 `retryable`，`retryable` 仅 `rateLimit` 为 true）。

- [ ] **Step 4: 实现 `src/core/llm/deepseek.ts`**

- `parseSseChunk`：仅处理 `data: ` 前缀行；`[DONE]` 与空行返回 null；透出 `delta.content`、`delta.reasoning_content`、`delta.tool_calls[0]`（index/id/name/arguments 增量）
- `mapHttpError`：401/403→auth；429→rateLimit(retryable)；400 且 body 含 `context length`/`maximum context`→contextLength；其他 5xx 与非 ok→network
- `DeepSeekProvider.chat`：`fetch('${baseUrl}/chat/completions', { method:'POST', headers: { 'Content-Type':'application/json', Authorization:'Bearer ' + await getApiKey() }, body: { model, messages, tools?, temperature?, stream: true }, signal })`；SSE 逐行 `parseSseChunk` → 调 `req.onDelta` → 聚合 `msg`（`reasoning` 由 `reasoning_content` 累积）；非 2xx 先 `mapHttpError`；空 Key 抛 `noApiKey`；`AbortError` 重新抛出为 `network` 错误（`retryable:false`）
- 工具调用：收集增量按 `index` 归并，`finish_reason==='tool_calls'` 时随消息返回 `toolCalls`（`arguments` 为完整 JSON 字符串）

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS（7 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/core/llm/ test/llm-deepseek.test.ts
git commit -m "feat: DeepSeek 流式客户端（SSE/推理/工具调用增量解析 + 错误分类）"
```

---

### Task 3: PDF 阅读器（Custom Editor + PDF.js + 选区提取 + 阅读位置记忆）

**Files:**
- Create: `src/pdf/helpers.ts`、`src/pdf/pdfEditor.ts`、`media/pdf/viewer.html`、`media/pdf/viewer.js`、`media/pdf/viewer.css`、`test/pdf-helpers.test.ts`
- Modify: `src/extension.ts`（注册 custom editor 与 `aiStudy.openPdf` 命令）、`package.json`（`activationEvents` 已含，无需改；若命令未注册则补）

**Interfaces:**
- Consumes: 无（不依赖 Task 1/2；本任务只读，划词动作在 Task 5 接入）
- Produces:
  - `src/pdf/helpers.ts`（**纯模块，不 import `vscode`**，供 `node:test` 直接测试）：`pageStateKey(fileUri: string): string`（如 `pdf.lastPage.${fileUri}`）、`clampPage(page: number, total: number): number`（1..total 夹取）、`classifyPageText(text: string): 'hasText' | 'scanned'`（trim 后为空 → `scanned`）
  - `class PdfEditorProvider implements vscode.CustomTextEditorProvider`（`static readonly viewType = 'aiStudy.pdfEditor'`；构造注入 `context: vscode.ExtensionContext` 供 Memento 存阅读位置；`pageStateKey` 等从 `./helpers` 导入）
  - viewer 内浮动工具栏骨架：`[翻译] [解释] [复制]`（Task 5 接功能；本任务先展示与隐藏，点击占位 postMessage `{ type:'toolbar-action', action:'translate' }` 等）

- [ ] **Step 1: 编写失败的测试** `test/pdf-helpers.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { clampPage, classifyPageText, pageStateKey } from '../src/pdf/helpers';

test('clampPage 夹取范围', () => {
  assert.strictEqual(clampPage(0, 10), 1);
  assert.strictEqual(clampPage(5, 10), 5);
  assert.strictEqual(clampPage(11, 10), 10);
});
test('classifyPageText 区分有文字层与扫描页', () => {
  assert.strictEqual(classifyPageText('  \n '), 'scanned');
  assert.strictEqual(classifyPageText('hello 世界'), 'hasText');
});
test('pageStateKey 以文件为键', () => {
  assert.strictEqual(pageStateKey('/a/b.pdf'), 'pdf.lastPage./a/b.pdf');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 `src/pdf/helpers.ts` 与 `src/pdf/pdfEditor.ts`**

- `resolveCustomTextEditor(document, webviewPanel, _token)`：`webview.options = { enableScripts: true, localResourceRoots: [media/pdf 目录] }`；html 指向 `viewer.html`（`Webview.asWebviewUri` 注入 `pdfjs` 资源路径与 `initialPage`）
- 注入脚本：`acquireVsCodeApi`，`postMessage({ type:'pdf:open', uri, fileName, initialPage })`；接收来自 viewer 的消息并转发给事件总线：`onPdfSelection(uri, page, text)`（供 Task 5 消费，用 `vscode.EventEmitter<PdfSelection>` 暴露）
- 阅读位置：`webviewPanel.onDidDispose` 时以 `pageStateKey(uri)` 写 `context.workspaceState`；打开时读取并作为 `initialPage`
- 供外部查询当前选区：`getCurrentSelection(): { uri: string; page: number; text: string } | undefined`（Task 5 使用）

- [ ] **Step 4: 实现 viewer（`media/pdf/viewer.html` + `viewer.js` + `viewer.css`）**

- HTML：容器 + 顶部工具栏（页码输入/上一页/下一页/缩放 +/-/适配宽度）+ 画布区 + 浮动工具栏 `#floating-toolbar`（按钮 `[翻译] [解释] [复制]`，`data-action`）+ 无文字层提示条
- JS（原生 ES module，无构建）：`import * as pdfjsLib from './pdf.min.mjs'`；`pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'`；CSS `percent` 分页渲染 ✓、text layer ✓、`window.getSelection()` 监听 `selectionchange`——选区非空且落在本页 text layer 内时显示浮动工具栏并定位到选区上方（`getBoundingClientRect`，超出视口自动翻转/夹取），清空时隐藏
- 工具栏点击 → `vscode.postMessage({ type:'toolbar-action', action, text: selectedText, page })`；无文字层（`classifyPageText` 返回 `scanned`）→ 隐藏翻译/解释/复制按钮，显示「无文本层」提示条与「手动添加笔记」（占位，Task 4/5 接线）
- 页码变化/滚动停止 → `postMessage({ type:'page-change', page })`；收到 `pdf:open` 后 `getDocument({ data })`（`webview` 用 `vscode.Uri` 经 `Webview.asWebviewUri` 传给 viewer fetch）
- `getDocument` 失败（损坏/加密 PDF）→ 画布区显示错误占位页（含错误信息与「重新加载」按钮，点击重试）

- [ ] **Step 5: 在 `src/extension.ts` 注册**

`vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, new PdfEditorProvider(context), { webviewOptions: { retainContextWhenHidden: true } })`；`aiStudy.openPdf` 命令：取资源 URI → `vscode.commands.executeCommand('vscode.openWith', uri, PdfEditorProvider.viewType)`；explorer 右键菜单已在 Task 1 声明。

- [ ] **Step 6: 运行测试确认通过 + 手工冒烟**

Run: `npm test`
Expected: PASS（3 个用例）

Run: `npm run compile && open -a Code .` 后在开发宿主（F5）打开任一 PDF，确认渲染、翻页、选中文本出现浮动工具栏、关闭重开后回到上次页码。
Expected: 全部正常

- [ ] **Step 7: 提交**

```bash
git add src/pdf/ media/pdf/ test/pdf-helpers.test.ts src/extension.ts
git commit -m "feat: PDF.js 阅读器（Custom Editor/选区提取/阅读位置记忆/浮动工具栏骨架）"
```

---

### Task 4: 笔记核心（frontmatter + vault 白名单 + 续写服务 + 单词本）

**Files:**
- Create: `src/notes/frontmatter.ts`、`src/notes/vault.ts`、`src/notes/noteService.ts`、`src/notes/wordbook.ts`、`test/notes.test.ts`
- Modify: 无（接线在 Task 5/6）

**Interfaces:**
- Consumes: 无
- Produces:
  - `function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string }`（无 frontmatter 时 `data:{}`）
  - `function stringifyFrontmatter(data: Record<string, unknown>): string`（支持 string、string[]、number、boolean；数组 `[a, b]` 内联）
  - `function expandHome(p: string): string`（复用 config）
  - `function notePathForSource(notesRoot: string, sourcePath: string): string`（取来源文件目录镜像 + `stem.md`；源无目录时平铺根；`stem` 空则用 `_note`）
  - `function isInsideVault(notesRoot: string, target: string): boolean`（`path.resolve` 后前缀匹配；含 `..` 或符号链接解析后逃逸 ⇒ false）
  - `interface SourceInfo { displayName: string; sourcePath: string; sourceType: 'pdf' | 'editor' | 'none'; page?: number; quote?: string }`
  - `class NoteService { constructor(notesRoot: string); notePathFor(source: SourceInfo): string; openOrCreate(source: SourceInfo, opts?: { headings?: { heading: string; body: string }[] }): Promise<{ notePath: string; created: boolean }>; appendTo(notePath: string, headings: { heading: string; body: string }[]): Promise<void> }`（纯逻辑可测；`vscode.Uri` 的打开与分屏由调用方（Task 6）负责）
  - `interface WordEntry { word: string; translation: string; source: string; sentence?: string; tags?: string[]; date: string }`
  - `class WordBook { constructor(notesRoot: string); path(): string; addEntry(e: WordEntry): Promise<void>; parseAll(text: string): WordEntry[] }`
  - 模板常量：`NOTE_QUOTE_LINE = (page?: number) => ...`（按 spec §7.2 生成引用块与回链行）

- [ ] **Step 1: 编写失败的测试** `test/notes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../src/notes/frontmatter';
import { notePathForSource, isInsideVault } from '../src/notes/vault';
import { NoteService } from '../src/notes/noteService';
import { WordBook } from '../src/notes/wordbook';

test('frontmatter 往返', () => {
  const text = '---\ntitle: 笔记\nsourceType: pdf\ntags: [a, b]\ncreated: 2026-09-30T00:00:00+08:00\npass: true\ncount: 3\n---\n\n# body\n内容';
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.title, '笔记');
  assert.deepStrictEqual(data.tags, ['a', 'b']);
  assert.strictEqual(data.pass, true);
  assert.strictEqual(data.count, 3);
  assert.ok(body.includes('# body'));
  const again = stringifyFrontmatter(data) + '\n---\n\n' + body;
  assert.deepStrictEqual(parseFrontmatter(again).data, data);
});
test('无 frontmatter 时返回空 data', () => {
  const { data, body } = parseFrontmatter('# 纯正文');
  assert.deepStrictEqual(data, {});
  assert.strictEqual(body, '# 纯正文');
});
test('notePathForSource 镜像目录且同名 .md', () => {
  assert.strictEqual(notePathForSource('/n', '/docs/a/b/2-Agent八股2️⃣.pdf'), '/n/a/b/2-Agent八股2️⃣.md');
  assert.strictEqual(notePathForSource('/n', '/2.pdf'), '/n/2.md');
});
test('isInsideVault 拒绝路径穿越与外部绝对路径', () => {
  assert.ok(isInsideVault('/n', '/n/子/笔记.md'));
  assert.ok(!isInsideVault('/n', '/n/../etc/passwd'));
  assert.ok(!isInsideVault('/n', '/etc/passwd'));
  assert.ok(!isInsideVault('/n', '/n2/other.md'));
});
test('NoteService 幂等续写：已存在笔记不覆盖只追加', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const svc = new NoteService(root);
    const src = { displayName: '2-Agent八股2️⃣.pdf', sourcePath: '/d/2-Agent八股2️⃣.pdf', sourceType: 'pdf' as const, page: 1, quote: '原文' };
    const r1 = await svc.openOrCreate(src, { headings: [{ heading: '第1页 · 解释', body: '内容A' }] });
    assert.strictEqual(r1.created, true);
    const r2 = await svc.openOrCreate(src, { headings: [{ heading: '第2页 · 手动笔记', body: '内容B' }] });
    assert.strictEqual(r2.created, false);
    const text = readFileSync(r1.notePath, 'utf8');
    assert.ok(text.includes('内容A'));
    assert.ok(text.includes('内容B'));
    assert.ok(text.includes('第1页 · 解释'));
    assert.ok(text.includes('第2页 · 手动笔记'));
    assert.strictEqual((text.match(/内容A/g) || []).length, 1); // 不重复写入
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('NoteService 首次创建含 frontmatter 与回链', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const svc = new NoteService(root);
    const src = { displayName: '2-Agent八股2️⃣.pdf', sourcePath: '/d/2-Agent八股2️⃣.pdf', sourceType: 'pdf' as const, page: 12, quote: '选中文本' };
    const { notePath } = await svc.openOrCreate(src, { headings: [] });
    const text = readFileSync(notePath, 'utf8');
    assert.ok(text.includes('source: 2-Agent八股2️⃣.pdf'));
    assert.ok(text.includes('sourceLink: vscode://file/d/2-Agent八股2️⃣.pdf#page=12'));
    assert.ok(text.includes('> 📎 原文引用（第 12 页）'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('WordBook 追加与解析', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-'));
  try {
    const wb = new WordBook(root);
    await wb.addEntry({ word: 'agent', translation: '代理', source: '2-Agent八股2️⃣.pdf', sentence: 'An agent uses tools.', date: '2026-09-30' });
    await wb.addEntry({ word: 'harness', translation: '编排框架', source: 'KamaClaude', date: '2026-09-30' });
    const entries = wb.parseAll(readFileSync(wb.path(), 'utf8'));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].word, 'agent');
    assert.strictEqual(entries[0].translation, '代理');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现四个模块**

- `frontmatter.ts`：手写极简 YAML 子集（键: 值；`[a, b]` 数组；字符串可带引号；数字/布尔转换）。不引入 yaml 依赖。
- `vault.ts`：`notePathForSource` 用 `path.dirname/sourcePath` 镜像 + `path.parse().name + '.md'`；`isInsideVault` 用 `path.resolve` + `relative` 判定（`rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))`）。
- `noteService.ts`：`openOrCreate` —— 目标存在则 `created:false` 并 `appendTo`（body 非空时）；不存在则创建（含 frontmatter：title/source/sourceType/sourceLink/tags/created/updated，sourceLink 按 `sourceType==='pdf'` 生成 `vscode://file${sourcePath}#page=${page}`、`editor` 生成 `vscode://file${sourcePath}`），随后 `appendTo`；`appendTo` 对每个 heading 追加 `\n\n## ${heading}\n\n${body}\n`，写入后更新 `updated`；日期用 `new Date().toISOString()`。`quote` 非空时作为首段引用（模板 `> 📎 原文引用（第 N 页）\n> ...` + 回链行）。
- `wordbook.ts`：`path() = join(notesRoot, '单词本.md')`；`addEntry` 不存在则创建（`# 单词本\n` 头），追加 `\n## ${entry.word}\n- 翻译：...\n- 来源：...\n- 例句：...\n- 标签：...\n- 日期：...\n`（空字段省略）；`parseAll` 解析回 `WordEntry[]`（`## 词` 与 `- 键：值` 行）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/notes/ test/notes.test.ts
git commit -m "feat: 笔记核心（frontmatter/vault 白名单/一文档一笔记续写/单词本）"
```

---

### Task 5: 划词动作与结果展示（编辑器结果面板 + 浮动工具栏接线）

**Files:**
- Create: `src/selection/prompts.ts`、`src/selection/actions.ts`、`src/util/markdown.ts`、`test/selection.test.ts`
- Modify: `src/extension.ts`（命令接线）、`media/pdf/viewer.js`（浮动工具栏按钮触发既有 `toolbar-action` 消息）、`src/pdf/pdfEditor.ts`（把动作结果回传 viewer 的 postMessage 通道）

**Interfaces:**
- Consumes: `LLMProvider`/`DeepSeekProvider`（Task 2）、`PdfEditorProvider.getCurrentSelection()`（Task 3）、`SecretStore`（Task 1）；`NoteService`/`WordBook`（Task 4，仅本任务测试桩）
- Produces:
  - `src/selection/prompts.ts`（**纯模块，不 import `vscode`**，供 `node:test` 直接测试）：`requireSelection(text: string | undefined): string`（空/undefined 抛 `new Error('请先选中文本')`，由 UI 捕获并提示）、`buildTranslatePrompt(text: string): { system: string; user: string }`（system：`你是一个翻译引擎。将用户文本翻译成中文；术语保留英文并给出释义。输出格式：译文 + 术语表。`；user：`翻译：${text}`）、`buildExplainPrompt(text: string): { system: string; user: string }`（system：`你是一位导师。用通俗语言解释用户文本，先给结论，再分点展开，最后给一个例子。`；user：`解释：${text}`）
  - `src/util/markdown.ts`（**纯模块**）：`renderSimpleMarkdown(md: string): string`（转义 + `\n\n` 分段 + `**b**`/`` `code` ``/`[t](url)` 三件套）
  - `class SelectionActions { constructor(deps: { provider: LLMProvider; config: AppConfig; getPdfSelection: () => { uri: string; page: number; text: string } | undefined }) ... }`（`requireSelection` 等从 `./prompts` 导入）
  - `translate(text: string): Promise<string>` / `explain(text: string): Promise<string>`（内部走 provider.chat，`model: config.model`，`tools` 不传；流式 delta 经 `onShowResult` 回调逐段上屏）
  - `copy(text: string): Promise<void>`
  - `onShowResult: (payload: { kind: 'translate' | 'explain'; text: string; markdown: string; source?: SourceInfo; page?: number; retry: () => void }) => void`（渲染回调，由扩展宿主注入——编辑器场景打开结果面板，PDF 场景 postMessage 到 viewer popover）

- [ ] **Step 1: 编写失败的测试** `test/selection.test.ts`

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 `src/selection/prompts.ts`、`src/selection/actions.ts`（含错误卡与重试）、`src/util/markdown.ts`**

- `prompts.ts`：`requireSelection`：trim 后为空即抛错；`buildTranslatePrompt`/`buildExplainPrompt` 按 Interfaces 的 system 原文构造
- `selection/actions.ts`：`translate/explain` 组装 prompt → `provider.chat`（`req.onDelta` 转发 `onShowResult` 流式 markdown）→ 返回全文；捕获 `LLMError`：`noApiKey` 提示运行 `aiStudy.setApiKey`；`rateLimit` 自动重试一次（退避 1s）；其余错误卡含「重试」按钮（重新调用本方法）；`AbortError` 静默
- `copy`：`vscode.env.clipboard.writeText`
- `util/markdown.ts`：`renderSimpleMarkdown`（转义 + `\n\n` 分段 + `**b**`/`` `code` ``/`[t](url)` 三件套；不引入额外依赖，预留升级位）

- [ ] **Step 4: 实现结果面板与 PDF popover 回传**

- 编辑器场景：`showResultPanel(title: string, render: (el) => void)` —— `window.createWebviewPanel('aiStudy.result', title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: false })`，用 `renderSimpleMarkdown` 渲染
- PDF 场景：`PdfEditorProvider.broadcastToPdf(uri, msg)` 将 `{ type:'result', kind, markdown, page, source }` 发给对应 viewer；viewer.js 收到后渲染进页内 popover（浮层，含「关闭」「加笔记」「加单词本」按钮——按钮先禁用，Task 6 接线）

- [ ] **Step 5: 在 `src/extension.ts` 接线命令**

- `aiStudy.translateSelection` / `aiStudy.explainSelection`：`requireSelection(activeEditor?.document.getText(activeEditor.selection))`（编辑器）或 `PdfEditorProvider.getCurrentSelection()?.text`（PDF 聚焦时）→ `actions.translate/explain`
- `aiStudy.copySelection`：同上取文本 → `copy`；成功 `showInformationMessage('已复制')`
- 每个命令包 `try/catch`：`e.message === '请先选中文本'` → `showWarningMessage`，否则 `showErrorMessage`

- [ ] **Step 6: 运行测试确认通过 + 冒烟**

Run: `npm test`
Expected: PASS（3 个用例）

Run: F5 开发宿主：编辑器选中文本 → 右键「翻译」→ 结果面板流式出现；PDF 内选中 → 浮动工具栏「翻译/解释」→ 页内 popover。
Expected: 正常（无 API Key 时显示引导提示）

- [ ] **Step 7: 提交**

```bash
git add src/selection/ src/util/ src/extension.ts media/pdf/ test/selection.test.ts
git commit -m "feat: 划词动作（翻译/解释/复制 + 编辑器结果面板 + PDF popover）"
```

---

### Task 6: 加笔记/加单词本接线 + 分屏续写 + 验收打包

**Files:**
- Create: `test/note-integration.test.ts`
- Modify: `src/extension.ts`（`aiStudy.addNoteFromSelection`、`aiStudy.addToWordBook` 命令）、`src/selection/actions.ts`（`addNote`/`addToWordBook` 方法）、`media/pdf/viewer.js`（popover 与浮动工具栏「加笔记/加单词本」按钮启用）、`README.md`（使用说明 + 已知限制）

**Interfaces:**
- Consumes: `NoteService`/`WordBook`（Task 4）、`SelectionActions`（Task 5）、`PdfEditorProvider`（Task 3）、`loadConfig`（Task 1）
- Produces: 无（本任务为收尾接线；`SelectionActions` 新增方法合并进既有类）

- [ ] **Step 1: 编写失败的测试** `test/note-integration.test.ts`

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（Task 4 已通过的用例现在应全部通过；本文件新用例失败——若 Task 4 实现已满足，标记为确认即可）

- [ ] **Step 3: 实现 `SelectionActions.addNote` / `addToWordBook`**

- `addNote(text, source)`：`showInputBox({ prompt: '笔记标题', value: 来源名 })` → `NoteService.openOrCreate(source, { headings: [{ heading: '手动笔记', body: text }] })` → `window.showTextDocument(vscode.Uri.file(notePath), { viewColumn: vscode.ViewColumn.Beside, preview: false })`（打开后 `revealRange` 光标置于文件末尾续写区，`showTextDocument` 后 `editor.selection = 末尾空选择`）→ `showInformationMessage('已打开笔记，可直接续写')`
- `addToWordBook(text, source)`：`showInputBox({ prompt: '翻译', value: '' })` 获取翻译（允许留空）→ `WordBook.addEntry({ word: text 首词/整段截断 50 字, translation, source: source.displayName, date })` → `showInformationMessage('已加入单词本')`
- popover/浮动工具栏按 source 自动携带 `page` 与 `quote`

- [ ] **Step 4: 接线命令与启用按钮**

- `aiStudy.addNoteFromSelection` / `aiStudy.addToWordBook`：与 Task 5 相同取文本逻辑 → `actions.addNote/addToWordBook`；`viewer.js` 两处按钮解除 disabled。
- 结果 popover 内「加笔记/加单词本」按钮 → `postMessage({ type:'note-action', action:'note'|'wordbook', text, page })`；`pdfEditor.ts` 转发给 `SelectionActions`。

- [ ] **Step 5: 补充 README 与已知限制**

`README.md`：安装（`npm run package` → `code --install-extension`）、配置（DeepSeek API Key 命令）、功能清单（PDF 阅读/划词工具栏/续写式笔记/单词本）、已知限制（分屏宽度无公开 API、`sidePanelWidth` 暂不生效、扫描版 PDF 需手动笔记）。

- [ ] **Step 6: 全量验证**

Run: `npm run check`
Expected: compile + test 全绿

Run: F5 手动 E2E —— 打开 `2-Agent八股2️⃣.pdf` → 选中文本 → 浮动工具栏「翻译」→ popover 展示 → 「加笔记」→ 输入标题 → 分屏打开续写 → 再选一段「加笔记」→ 回到同一文件追加；「加单词本」→ `单词本.md` 出现条目。
Expected: 全部符合

- [ ] **Step 7: 打包并提交**

Run: `npm run package`
Expected: 产出 `ai-study-helper-0.1.0.vsix`

```bash
git add -A
git commit -m "feat: 加笔记/加单词本接线，分屏续写闭环，v0.1.0 打包"
```

---

## 计划 1 完成定义

- `npm run check` 全绿；`ai-study-helper-0.1.0.vsix` 可安装。
- 手动 E2E 通过：读 PDF → 划词（翻译/解释/复制）→ 加笔记（分屏续写、回链跳转）→ 加单词本。
- 计划 2（M4-M6：Harness 会话/模式/Skill/附件、研究模式、工作区写确认流）在计划 1 合并后另行规划。