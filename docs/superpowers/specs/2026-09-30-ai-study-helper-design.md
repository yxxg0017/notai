# AI 学习助手（ai-study-helper）设计文档

- 日期：2026-09-30
- 状态：已通过设计评审，待实现
- 目录：`/Users/yxxg/Documents/project/codagentlearn/ai-study-helper`

## 1. 概述与目标

一个本地优先的 AI 辅助学习 VS Code 插件，围绕「读 PDF / 文档 → 划词学习 → 记笔记 → 对话深挖」的闭环设计，包含三大部分：

1. **PDF 阅读器**（Custom Editor + PDF.js）：查看与阅读 PDF 文档。
2. **AI 划词工具栏**（豆包式浮动工具栏）：翻译、解释、复制、加笔记、加单词本；编辑器内选中文本以右键菜单/命令兼容。
3. **Agent Harness**（Codex 式侧边栏）：新建/历史会话，普通对话 / 知识搜索与整理 / 引导学习三种模式，输入框可选模型、配置 Skill、附加图片或文件。

LLM 首选 DeepSeek（OpenAI 兼容协议），Provider 接口可扩展其他 API。

## 2. 非目标（YAGNI）

- 不做独立进程/本地 Server（单进程纯扩展，如 `pico-reading-vscode` 同构）。
- 本期不做扫描版 PDF 的 OCR（预留接口，无文字层时提示并引导手动笔记）。
- 不引入向量数据库 / RAG 索引（本地搜索用 VS Code 自带 ripgrep/findFiles，预留索引接口）。
- 不做双链图谱可视化（仅 `[[标题]]` 双链文本与回链跳转）。
- 不做 marketplace 正式发布（本地 vsix 打包，预留 publisher 字段）。
- 不实现多模态直传（DeepSeek 官方 API 当前仅文本；图片附件走降级路径，见 §7.3）。

## 3. 总体架构

单进程 VS Code 扩展。所有逻辑运行在 Extension Host 内，与 `pico-reading-vscode` 同构；核心层（llm/agent/skills/tools/notes/search）设计为纯 TS 模块，不直接依赖 VS Code API（通过注入的接口访问），可单独测试，未来可整体搬入独立进程。

```text
┌───────────────────────── VS Code 扩展 ─────────────────────────┐
│                                                                 │
│  UI 表面                                                         │
│  ├─ PDF 阅读器 (Custom Editor + PDF.js)          ← 查看/阅读     │
│  │    └─ 内嵌划词浮动工具栏 (豆包式)                              │
│  ├─ 编辑器右键菜单/命令 (拖选兼容)                                │
│  └─ Harness 侧边栏 (Codex 式)                ← 对话/搜索/整理    │
│       ├─ 会话列表 (历史/新建)                                    │
│       └─ 对话面板 (模式·模型·Skill·附件·输入框)                   │
│                                                                 │
│  核心层 (纯 TS 模块)                                              │
│  ├─ llm/     Provider 接口 + DeepSeek 实现 (流式/工具调用/推理)   │
│  ├─ agent/   会话模型 + 工具循环 + 持久化                        │
│  ├─ skills/  预置 Skill 模块 (可开关)                            │
│  ├─ tools/   三级权限工具 (只读 / 笔记库写 / 工作区写确认)         │
│  ├─ notes/   Vault: 一文档一笔记(续写) + frontmatter + 回链       │
│  └─ search/  可插拔网页搜索 Provider (Tavily 兼容 / 博查)         │
│                                                                 │
│  持久化: SecretStorage(API Key) / globalStorage(会话) / 磁盘(笔记)│
└─────────────────────────────────────────────────────────────────┘
```

## 4. 工程结构

```text
ai-study-helper/
├── package.json
├── tsconfig.json
├── media/                        # PDF viewer 与 chat 的静态资源 (js/css/html)
├── src/
│   ├── extension.ts              # 激活、命令注册、装配
│   ├── config.ts                 # 配置读取 + SecretStorage 封装
│   ├── core/
│   │   ├── llm/
│   │   │   ├── types.ts          # ChatMessage/Delta/ProviderCapabilities/LLMProvider
│   │   │   ├── deepseek.ts       # DeepSeek 实现 (OpenAI 兼容)
│   │   │   ├── compatible.ts     # 任意 OpenAI 兼容实现
│   │   │   └── registry.ts       # 模型清单 + capabilities
│   │   ├── agent/
│   │   │   ├── types.ts          # Conversation/Mode/Message
│   │   │   ├── store.ts          # globalStorage 会话持久化
│   │   │   └── loop.ts           # 工具调用循环 (maxSteps/中止/确认挂起)
│   │   ├── skills/
│   │   │   ├── skill.ts          # Skill 接口
│   │   │   └── builtin/          # translate/explain/summarize/quiz/note/search/code
│   │   ├── tools/
│   │   │   ├── context.ts        # 工具执行上下文 (VS Code 注入点、确认回调)
│   │   │   ├── readTools.ts      # read_file/search_local/read_pdf_page/list_notes
│   │   │   ├── noteTools.ts      # create_note/append_note/edit_note/move_note/...
│   │   │   ├── workspaceTools.ts # edit_workspace_file (确认流)
│   │   │   └── webSearchTool.ts  # web_search
│   │   └── search/
│   │       ├── provider.ts       # WebSearchProvider 接口
│   │       ├── tavily.ts         # Tavily 兼容
│   │       └── bocha.ts          # 博查 (国内)
│   ├── notes/
│   │   ├── vault.ts              # 笔记库目录解析/归档布局/路径白名单
│   │   ├── noteService.ts        # 一文档一笔记的创建与续写
│   │   ├── wordbook.ts           # 单词本 (全局唯一, 追加)
│   │   └── frontmatter.ts        # YAML frontmatter 读写
│   ├── pdf/
│   │   └── pdfEditor.ts          # PDF Custom Editor
│   ├── ui/
│   │   ├── sessionView.ts        # 会话列表 view
│   │   ├── chatView.ts           # 对话面板 view
│   │   └── media/                # chat 前端 (html/css/js)
│   └── selection/
│       └── actions.ts            # 划词动作编排 (翻译/解释/加笔记/加单词本)
└── test/                         # node:test 单测
```

## 5. 配置（package.json contributes.configuration 前缀 `aiStudy`）

| 键 | 默认 | 说明 |
|---|---|---|
| `aiStudy.notesRoot` | `~/Documents/StudyNotes` | 笔记库根目录（首次设置时可用快速选择器更改） |
| `aiStudy.provider` | `deepseek` | `deepseek` / `openai-compatible` |
| `aiStudy.baseUrl` | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| `aiStudy.model` | `deepseek-chat` | 默认模型 |
| `aiStudy.models` | `["deepseek-chat","deepseek-reasoner"]` | 模型选择器候选 |
| `aiStudy.apiKey` | — | SecretStorage 存储（`restricted` 配置 + 专用命令） |
| `aiStudy.maxSteps` | `8` | 每轮最多工具调用次数 |
| `aiStudy.sidePanelWidth` | `45` | 笔记分屏宽度（%） |
| `aiStudy.webSearch.provider` | `tavily` | `tavily` / `bocha` / `none` |
| `aiStudy.webSearch.apiKey` | — | 网页搜索 Key（SecretStorage） |
| `aiStudy.enableWorkspaceWrite` | `true` | 工作区写工具是否启用（始终走确认流） |
| `aiStudy.explainTarget` | `popover` | 划词「解释」结果展示位置：`popover`（页内弹层）/ `conversation`（发送到 Harness 对话） |

## 6. 核心层设计

### 6.1 LLM 层（`core/llm/`）

```ts
interface ProviderCapabilities {
  supportsTools: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;   // 如 deepseek-reasoner 的 thinking 字段
}

interface LLMProvider {
  name: string;
  capabilities: ProviderCapabilities;
  chat(req: ChatRequest, signal: AbortSignal, onDelta: (d: Delta) => void): Promise<AssistantMessage>;
}
```

- `DeepSeekProvider`：官方 `https://api.deepseek.com/v1`，流式 SSE + function calling；`deepseek-reasoner` 的 `reasoning_content` 单独透出，UI 折叠展示。
- `OpenAICompatibleProvider`：自定义 baseUrl/model，为后续其他 API 预留。
- 错误分类与展示：无 Key / 网络 / 429（自动重试一次，指数退避 1s/2s）/ 上下文超长 → 内联错误卡 + 重试按钮。

### 6.2 Agent 循环（`core/agent/`）

```ts
interface Conversation {
  id: string; title: string;
  mode: 'chat' | 'research' | 'quiz';
  model: string; provider: string;
  skillIds: string[];
  messages: Message[];           // 含 tool 消息与工具调用记录
  createdAt: number; updatedAt: number;
}
```

- 持久化：`globalStorage/conversations/<id>.json` 每会话一文件 + `index.json` 维护列表（含标题、时间、模式、消息数）。启动时仅加载索引，点开才读全文。
- 循环：用户消息 → 组装（系统提示 + 启用的 Skill 注入 + 工具定义）→ 模型 → 工具调用 → 执行回填 → 重复，最多 `maxSteps`；支持中止（AbortSignal）与流式渲染。
- **三种模式**：
  - `chat` 普通对话：默认 Skills + 只读工具。
  - `research` 知识搜索与整理：强制启用 `web_search` + `search_local`，输出「结论 → 来源列表」，结果卡可一键「生成为笔记」（追加到当前来源笔记或 Inbox）。
  - `quiz` 引导学习（激发思考）：苏格拉底式提问/出题自测；输入源为选中文本、当前 PDF 页或笔记内容；支持「展示答案/换一题」。

### 6.3 Skills（`core/skills/`）

```ts
interface Skill {
  id: string; displayName: string; icon?: string;
  description: string;
  systemPrompt: string;     // 注入 system 的段落
  tools: ToolId[];          // 该 Skill 允许挂载的工具白名单
  defaultOn: boolean;
}
```

预置：`translate`（翻译-解释对照）、`explain`（通俗解释+例子）、`summarize`（总结）、`quiz`（出题）、`note`（笔记助手：整理/改写/大纲，挂笔记库写工具）、`search`（知识搜索与整理）、`code`（代码考据，挂代码检索工具）。

### 6.4 工具与三级权限（`core/tools/`）

| 级别 | 工具 | 执行方式 |
|---|---|---|
| 只读 | `read_file`、`search_local`、`read_pdf_page`、`list_notes`、`web_search` | 直接执行 |
| 笔记库内写 | `create_note`、`append_note`、`edit_note`、`move_note`/`rename_note`、`update_frontmatter` | 直接执行；路径白名单校验（必须在 `notesRoot` 内，防 `..` 穿越） |
| 工作区写 | `edit_workspace_file` | **草稿 → 确认卡 → 应用**：工具产出 proposal（路径+完整内容+diff 摘要），循环挂起，对话流显示确认卡 `[查看 Diff] [应用] [拒绝]`；应用后继续。受 `enableWorkspaceWrite` 开关控制 |

- 工具执行上下文 `ToolContext` 通过依赖注入提供 VS Code 能力（`workspace`, `window`, `notesRoot` 等），核心层不 import `vscode`，纯逻辑可单测。
- `read_pdf_page` 读取当前打开的 PDF 阅读器选中页文本（由 `pdfEditor` 注册提供）。

## 7. 笔记系统（`notes/`）

**一文档一笔记、续写式**（用户确认的核心形态）：一个来源文档对应唯一一份笔记 `.md`，文件名 = 来源名（`.pdf` → `.md`），**不带时间**；所有入口（AI 解释、手动添加、Harness 生成为笔记、笔记助手整理）都**追加/归并**到该笔记，不新建文件。单词本全局唯一一份，多文档集成。

### 7.1 归档布局

```text
<notesRoot>/
├── 后端agent开发资料/            ← 镜像来源相对目录；无来源则平铺于根
│   └── 2-Agent八股2️⃣.md          ← 与来源同名，一份承载该文档全部笔记
├── 单词本.md                      ← 全局唯一
└── Inbox/灵感.md                  ← 无来源笔记（Harness 无源对话等）
```

### 7.2 笔记文件结构

```markdown
---
title: 2-Agent八股2️⃣
source: 2-Agent八股2️⃣.pdf
sourceType: pdf
sourceLink: vscode://file/.../2-Agent八股2️⃣.pdf
tags: [agent]
created: 2026-09-30T15:40:00+08:00
updated: 2026-09-30T15:40:00+08:00
---

## 第12页 · 解释
> 选中文本……

（解释内容；[返回来源](vscode://file/....pdf#page=12)）

## 第15页 · 手动笔记
（续写；[返回来源](vscode://file/....pdf#page=15)）
```

- 已有笔记 → **直接打开续写**（光标定位文件末尾）；不存在 → 创建（frontmatter 预填来源信息）。
- 创建/打开笔记时：在当前窗口以 `ViewColumn.Beside` 分屏打开（`sidePanelWidth`，默认 45%），不替换当前编辑器内容。
- 回链：`[来源中定位](vscode://file/....pdf#page=N)` 点击跳转；笔记间 `[[标题]]` 双链由 Agent 整理时维护。
- `edit_note` 用于用户显式要求的整理/改写；日常新增一律 `append_note`。

### 7.3 附件（图片）

- Provider `capabilities.supportsImages === true`：按多模态消息发送（data URL）。
- 否则（DeepSeek 现状）：降级为「文件引用 + 本地提示」——插入 `[图片: 路径](vscode://file/...)` 并告知模型该图为本地文件不可见；后续若接入支持视觉的模型自动切换。
- 附件文件：读取文本类文件内容（截断到配置上限）注入上下文；二进制文件仅插入引用。

### 7.4 单词本（`wordbook.ts`）

`<notesRoot>/单词本.md`，追加式，多文档集成：

```markdown
## agent
- 翻译：代理（执行任务的智能体）
- 来源：2-Agent八股2️⃣.pdf · 2026-09-30
- 例句：An agent can use tools to complete a task.
- 标签：AI
```

提供命令「复习单词本」：随机/按来源抽取，先显示词后翻面显示释义。单词本解析与追加逻辑独立成模块（可单测）。

## 8. 网页搜索（`core/search/`）

```ts
interface WebSearchProvider { id; displayName; search(query: string, signal: AbortSignal): Promise<WebResult[]> }
```

- 默认 `tavily.ts`（Tavily 兼容 API，配置 baseUrl+apiKey）；`bocha.ts`（博查，国内直连、中文友好）；设置切换。
- 供 `web_search` 工具与 research 模式使用；结果带来源 URL，可一键加入笔记。
- `search_local` 用 `vscode.workspace.findFiles` + ripgrep 全量扫笔记库与工作区，结果按相关度截断；预留索引接口。

## 9. PDF 阅读器（`pdf/`）

- 自注册 Custom Editor（`aiStudy.pdfEditor`，`priority: default`，`*.pdf`），PDF.js 渲染（沿用 pico-reading-vscode 已验证的 vendor 与集成方式）。
- 功能：连续滚动、缩放、页码跳转、全文搜索、文字选择、阅读位置记忆（按文件记录上次页码于 `globalStorage`）。
- **内嵌划词浮动工具栏**（跟随选区的豆包式悬浮条）：
  `[翻译] [解释] [AI 搜索] [复制] [加笔记] [加单词本]`
  - 翻译/解释 → 页内 popover 展示（不打断阅读），popover 内含「加笔记/加单词本」；
  - AI 搜索 → 携带选中文本自动新建/复用 research 会话；
  - 加笔记/加单词本 → 走 §7 流水线；
  - 复制 → 写入剪贴板。
- 工具栏在选中文本变化时显示/隐藏，选区清空自动收起；按钮为图标+文字，支持键盘快捷键（Esc 关闭）。
- 无文字层（扫描版）：页内提示「无文本层」，提供「手动添加笔记」入口；本期不做 OCR。

## 10. 编辑器划词兼容（`selection/`）

VS Code 原生编辑器无法注入浮动 UI，选中文本通过以下方式触发（与 PDF 内工具栏动作一致）：

- 右键菜单（`editorHasSelection`）：`翻译选中内容` / `解释选中内容` / `复制` / `添加笔记` / `添加单词本`
- 命令面板同组命令。

## 11. Harness UI（`ui/`）

- Activity Bar 容器「学习」+ 两个 Webview view：
  - **会话列表**（`sessionView.ts`）：`+ 新对话`（可下拉选模式）、历史会话（标题/时间/模式徽章）、删除/重命名。
  - **对话面板**（`chatView.ts`）：
    - 顶部：会话标题 + 模式切换（chat/research/quiz）；
    - 消息流：用户/助手气泡；工具调用卡（可折叠）；reasoner 推理内容折叠；翻译对照卡、解释卡、搜索结果卡、笔记草稿卡（可直接「应用为笔记」）、工作区写确认卡（§6.4）；
    - 底部输入：多行文本框 + 模型选择器（`aiStudy.models` + 自定义）+ Skill chips（多选，实时生效）+ 附件按钮（图片/文件/当前选区/当前 PDF 页）+ 发送；
- 与划词联动：划词「AI 搜索」自动携带选中文本；「解释」默认走页内 popover，可配置为发送到对话。
- Webview 与 Extension Host 通过 `postMessage` 协议通信（消息类型定义于 `ui/protocol.ts`，实现时补充）。

## 12. 安全模型

- API Key 仅存 SecretStorage；日志不输出 Key。
- 笔记库写工具：路径白名单 + 规范化校验（拒绝 `..`、符号链接逃逸）。
- 工作区写工具：默认开启但强制确认流；`enableWorkspaceWrite=false` 时工具不可见。
- 受限工作区（untrusted）：只读工具 + 笔记库写（报告 `restrictedConfigurations`）。
- 网页搜索仅发送查询词与上下文片段，不发送笔记全文（research 模式下发送摘要）。

## 13. 错误处理

- 各处失败均产出内联错误卡：无 Key（引导配置）、网络（提供重试）、429（自动重试一次后提示）、上下文超长（提示精简/新会话）、模型不支持图片（降级提示）。
- PDF 加载失败：错误占位页 + 重新加载按钮。

## 14. 测试策略

- 运行器：`node:test` + tsc（沿用 pico-reading-vscode 模式），`npm run check` = compile + test。
- 单测覆盖（核心层纯逻辑，mock LLM/VS Code 接口）：
  - `agent/loop.ts`：工具循环、maxSteps 截断、确认挂起/恢复、中止；
  - `notes/`：续写（已存在/不存在）、frontmatter 往返、归档布局、路径白名单（`..` 穿越）、单词本追加与解析；
  - `llm/`：流式解析（mock SSE）、工具调用解析、错误映射；
  - `search/`：provider 选择与结果规范化。
- 手工 E2E：F5 开发宿主跑通 读 PDF → 划词 → 加笔记 → 分屏续写 → Harness 对话/研究模式 → 工作区写确认流。

## 15. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 脚手架 + 配置 + DeepSeek 流式/工具客户端 | 能流式对话、能调函数 |
| M1 | PDF 阅读器（PDF.js + 选区提取 + 位置记忆） | 打开 PDF、翻页、选中文本 |
| M2 | 划词/右键动作：翻译、解释、复制 + 页内 popover | 选中→翻译→弹层展示 |
| M3 | 笔记系统（续写式 + 分屏 + 回链）+ 单词本 | 加笔记→分屏续写；加词→单词本 |
| M4 | Harness（会话/模式/模型/Skill/附件） | 新会话/历史/三种模式/附件 |
| M5 | 研究模式（web 搜索 + 本地检索 + 生成为笔记） | 搜索→来源→一键笔记 |
| M6 | 工作区写确认流 + 错误处理打磨 + 打包 vsix | 确认卡流；`npm run package` 产出 vsix |

## 16. 开放问题（不阻塞实现）

1. 笔记库默认路径最终是否用 `~/Documents/StudyNotes`（首次启动提供快速选择器）。
2. 单词本复习交互（翻卡片 vs 列表）在 M3 实现时按体验微调。
3. 模型候选列表随 DeepSeek 新模型发布更新（配置可覆盖）。