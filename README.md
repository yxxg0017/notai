# Nota - AI 学习助手（nota-vscode）

「读 PDF → 划词学习 → 记笔记」的 VS Code 学习辅助扩展：

- 内置 PDF 阅读器（PDF.js 渲染，连续滚动 / 缩放 / 页码跳转 / 阅读位置记忆）
- 划词浮动工具栏：翻译、解释、复制、加笔记、加单词本、**AI 搜索**（编辑器内以右键菜单 / 命令面板兼容）
- **Harness 对话侧边栏**（活动栏「学习」）：会话列表 + 对话面板，三种模式（自由对话 / 研究 / 出题自测）、模型选择、Skill chips、附件
- **研究模式**：Tavily / 博查 web 搜索 + 本地笔记检索 + 来源卡 + 一键生成为笔记；无 Key 优雅降级
- **工作区写确认流**：AI 草稿 → 确认卡（Diff 两栏）→ 应用 / 拒绝
- **续写式笔记**：一个来源文档对应唯一一份 `.md` 笔记（按来源镜像目录），多次「加笔记」始终追加到同一文件并分屏打开续写；笔记含来源回链（点击跳回 PDF 对应页）
- **全局单词本**：`<notesRoot>/单词本.md`，多文档统一收集生词（词条 / 翻译 / 来源 / 日期）

## 安装

```bash
npm install        # 安装依赖
npm run check      # 编译 + 单测（87 个用例）
npm run package    # 产出 nota-vscode-0.1.0.vsix
code --install-extension nota-vscode-0.1.0.vsix
```

也可以直接用 VS Code 打开本目录按 `F5` 启动扩展开发宿主调试。

## 配置

- **DeepSeek API Key**：命令面板执行 `AI 学习: 设置 API Key`（`aiStudy.setApiKey`），输入后保存到 `SecretStorage`（不落盘明文、不写入日志）。
- **网页搜索 API Key**（Tavily / 博查）：经 `SecretStorage` 按 `aiStudy.webSearch.apiKey` 键存储；当前**无 GUI 入口**（仅保留配置项与存储位，见「已知限制」）。
- 其余配置（设置 → 搜索 `aiStudy`）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `aiStudy.notesRoot` | `~/Documents/StudyNotes` | 笔记库根目录（`~` 会展开） |
| `aiStudy.provider` / `baseUrl` / `model` / `models` | `deepseek` 等 | LLM 提供商与模型（OpenAI 兼容） |
| `aiStudy.maxSteps` | `8` | 每轮最多工具调用次数（预留） |
| `aiStudy.sidePanelWidth` | `45` | 笔记分屏宽度（%），**预留暂不生效**（见已知限制） |
| `aiStudy.explainTarget` | `popover` | 「解释」结果展示位置：`popover`（页内弹层）/ `conversation`（发送到 Harness 对话） |
| `aiStudy.webSearch.provider` | `tavily` | 网页搜索提供商：`tavily` / `bocha` / `none`（`none` 时不注册 web 搜索） |
| `aiStudy.webSearch.apiKey` | `""` | 网页搜索 API Key（`scope: machine` / `restricted`；实际值存 SecretStorage，见上） |
| `aiStudy.enableWorkspaceWrite` | `true` | 是否启用工作区写工具（`edit_workspace_file`，始终走确认流；与未信任工作区共同门控） |

## 功能

### PDF 阅读

打开任意 `.pdf`（资源管理器右键 `AI 学习: 打开 PDF`，或命令 `aiStudy.openPdf`），使用自带的 `aiStudy.pdfEditor` 阅读器打开：连续滚动、缩放（含「适配宽度」）、页码跳转、关闭重开自动回到上次阅读页。

### 划词工具栏

在 PDF 文本上选中内容 → 跟随选区的浮动工具栏：

- **翻译 / 解释**：页内 popover 流式展示结果（不打断阅读），popover 内可直接「加笔记 / 加单词本」；`aiStudy.explainTarget=conversation` 时「解释」改走 Harness 对话（复用 / 新建 chat 会话并发送）
- **复制**：写入系统剪贴板
- **加笔记 / 加单词本**：见下
- **AI 搜索**：将选中内容交给**研究模式**会话（复用最近未完成的 research 会话，否则新建），聚焦对话面板（见「研究模式」）

编辑器（`.md` / 代码等）内选中文本 → 右键菜单或命令面板：`翻译 / 解释 / 复制 / 添加笔记 / 添加单词本 / AI 搜索`（兼容入口，选区优先级见「已知限制」）。

### 续写式笔记（一文档一笔记）

- 「加笔记」→ 输入标题（预填来源名，取消即中止）→ 笔记不存在则创建（frontmatter 预填 `title/source/sourceType/sourceLink/tags/created/updated`，原文作为首段引用块 + 回链行），已存在则直接追加 `## 手动笔记` 块
- 笔记以 `ViewColumn.Beside` 分屏打开，**光标自动置于文件末尾**继续书写
- 笔记路径：来源文件**所在文件夹名**镜像到 `notesRoot` 下 + 同名 `.md`（如 `/docs/pico.pdf` → `<notesRoot>/docs/pico.md`；根级 `/2.pdf` → `<notesRoot>/2.md`）
- 回链：笔记内 `[返回来源](vscode://file/....pdf#page=N)` 可跳回 PDF 对应页

### 单词本

- 「加单词本」→ 输入翻译（允许留空，取消即中止）→ 追加到全局唯一 `<notesRoot>/单词本.md`（不自动去重，保留每次记录）
- 词条格式：`## 词` + `- 翻译 / - 来源 / - 日期`（例句 / 标签为预留字段）

### Harness 对话（活动栏「学习」）

活动栏出现「学习」容器，含两个 Webview 视图：

- **会话列表**（`aiStudy.sessionList`）：新建 / 打开历史 / 重命名 / 删除会话；会话按更新时间排序
- **对话面板**（`aiStudy.chatPanel`）：流式渲染（含 reasoning 折叠）、工具调用生命周期展示、中止、错误卡

对话面板能力：

- **三种模式**：`chat`（自由对话，默认开启翻译 / 解释 / 总结 / 出题 / 知识搜索等 Skill）、`research`（研究模式，固定启用「知识搜索」Skill）、`quiz`（出题自测，固定启用「出题自测」Skill）；模式可随时切换
- **模型选择**：`aiStudy.models` 候选列表，随会话记忆
- **Skill chips**：7 个内置 Skill（翻译对照 / 通俗解释 / 总结提炼 / 出题自测 / 笔记助手 / 知识搜索 / 代码考据）可切换开启；`code` / `note` 默认关闭，需显式开启
- **附件**：输入框可附加文件 / 文本 / 图片 / 选区 / PDF 页（`pickAttachment`）。图片按**降级规则**处理（见「已知限制」），文本类内容按字节截断到 8KB 后拼入
- **无 Key 降级**：未配置 DeepSeek API Key 时发送 → 错误卡（`noApiKey`）提示「去配置」或运行 `AI 学习: 设置 API Key`；不会静默失败

### 研究模式

- **web 搜索**：`aiStudy.webSearch.provider` 选择 Tavily / 博查（`none` 或未配置 Key 时不注册 `web_search`，研究模式退化为**仅本地检索**），与本地笔记检索（`search_local`）共同作为「知识搜索」Skill 的工具
- **来源卡**：回答按「结论 — 依据 — 来源」结构整理，来源链接以卡片形式呈现，可点击查证
- **一键生成为笔记**：对话内「生成为笔记」→ 保存到笔记库（有来源时按来源镜像；无来源 / Inbox 场景落 `<notesRoot>/Inbox/`），完成后提供「打开笔记」
- **无 Key 降级**：web 搜索未配置 Key 时，前端自动关闭 `search` Skill 的默认开启（`webSearchAvailable=false`），本地检索仍可用

### 工作区写确认流

- AI 可通过 `edit_workspace_file` 工具**起草**工作区文件修改（不会直接落盘）：草稿生成后前端弹出**确认卡**，展示修改文件的 **Diff 两栏**视图
- 用户「应用」才真正写入；「拒绝」则放弃。每个确认请求挂起等待用户决定（同一时刻仅一个挂起确认）
- **门控**（三重，取交集）：`aiStudy.enableWorkspaceWrite=true` 且存在工作区文件夹（`workspaceFolders`）且**工作区受信任**（`isTrusted`）；任一不满足则不注册该工具
- **未信任工作区**：仅提供只读工具与笔记库写入（`capabilities.untrustedWorkspaces` = limited）；前端输入区上方显示「受限工作区」提示条

### 错误处理

- **429 限流**：所有 LLM 调用（Harness 与划词翻译 / 解释）统一走指数退避重试（`1000ms`、`2000ms` 两档），重试耗尽才向用户报错
- **错误卡分类**：`noApiKey` / `network` / `rateLimit` / `contextLength` / `auth` / `unknown` / `maxSteps`；可安全重试的错误卡提供「重试」按钮（重发最近一次输入）
- **PDF 加载失败**：viewer 内错误提示 + 「重新加载」按钮（重发最近一次 `pdf:open`）；加载失败不阻塞其他面板

### 划词联动（选定内容 ↔ Harness）

- **「AI 搜索」**：PDF 浮动工具栏「AI 搜索」/ 编辑器命令 `AI 学习: AI 搜索选中内容` → 发送到**研究模式**会话（复用最近未完成的 research 会话或新建），并聚焦对话面板；划词来源记录为 `researchSource`，供一键生成为笔记回填
- **`explainTarget=conversation`**：划词「解释」不再弹 popover，而是发送到 Harness 对话（复用 / 新建 chat 会话），适用于希望把解释沉淀到会话历史的场景

## 已知限制

1. **分屏宽度无公开 API**：VS Code 不提供精确控制编辑器分屏宽度的公开 API，笔记以 `ViewColumn.Beside` 打开（约 50% 宽度）；`aiStudy.sidePanelWidth` 配置键**保留但暂不生效**。
2. **扫描版 PDF 需手动笔记**：无文字层的扫描页无法划词（不做 OCR），页内提供「手动添加笔记」入口，按页码生成笔记而不携带原文引用。
3. **多面板选区**：PDF 阅读器同时打开多个文件时，划词来源取最近一次选区（既有全局选区语义）。
4. **来源同名文件夹碰撞**：笔记按来源「所在文件夹名」镜像（一文档一笔记），不同根下的同名文件夹会共享同一笔记文件，如 `/a/docs/x.pdf` 与 `/b/docs/x.pdf` 均映射到 `<notesRoot>/docs/x.md`（两份来源续写同一份笔记；spec §7.1 的镜像规则如此设计，已知限制）。
5. **取源优先级**：编辑器命令（翻译/解释/复制/添加笔记/添加单词本/AI 搜索）在编辑器存在**非空选区**时优先取编辑器选区（`sourceType: editor`），其次才取当前 PDF 选区；即编辑器非空选区优先于 PDF 当前选区。
6. **附件降级规则**：当前模型为纯文本，**图片附件降级为「引用提示」占位**（仅保留文件名，不识别图片内容）；文本类附件（text/file/selection/pdfPage）按 **UTF-8 字节截断到 8KB**（截断点避开多字节字符边界，并追加截断提示行）；空 / 纯空白附件整体忽略。
7. **PDF 会话恢复**：重载窗口 / 重启后，`window.restoreWindows: "none"` 方案已**验证无效并弃用**（`tryRevive` 仍会对已打开的 PDF 走文本模型 + 二进制检测而弹错误框）；彻底修复需走「方案 A：自管 `WebviewPanel` + `WebviewPanelSerializer`」，已列为**计划 2 之后的 backlog 项**（见 `docs/2026-09-30-pdf-reader-known-issues.md`）。
8. **网页搜索 Key 无 GUI 入口**：`aiStudy.webSearch.apiKey` 仅保留配置项声明与 `SecretStorage` 存储位（`scope: machine` / `restricted`），当前**没有**对应的设置命令或界面入口；未配置时研究模式自动降级为仅本地检索。

## 开发

```bash
npm run check    # = npm run compile && npm test（node:test，无需 VS Code 宿主）
npm test         # 仅测试
npm run package  # 打包 vsix
```

- 核心层（`src/llm`、`src/notes`、`src/selection/prompts`、`src/util`）为纯 TS 模块（不 `import 'vscode'`），由 `node:test` 直接单测
- `media/pdf/` 下 `pdf.min.mjs / pdf.worker.min.mjs / cmaps/` 为 `npm run compile` 时从 `pdfjs-dist` 复制的构建产物（不入库）
- `out/ui/media/`（`chat.html/css/js`）为 `npm run compile` 时由 `scripts/copy-chat-assets.js` 从 `src/ui/media/` 复制的构建产物（不入库）：`.vscodeignore` 排除 `src/**`（vsix 不含源码），而 `out/**` 会随 vsix 打包，故 Harness 静态资源需在编译期复制（见 `src/ui/chatView.ts` 的 `HARNESS_MEDIA_DIR`）
