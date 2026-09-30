# AI 学习助手（ai-study-helper）

「读 PDF → 划词学习 → 记笔记」的 VS Code 学习辅助扩展：

- 内置 PDF 阅读器（PDF.js 渲染，连续滚动 / 缩放 / 页码跳转 / 阅读位置记忆）
- 划词浮动工具栏：翻译、解释、复制、加笔记、加单词本（编辑器内以右键菜单 / 命令面板兼容）
- **续写式笔记**：一个来源文档对应唯一一份 `.md` 笔记（按来源镜像目录），多次「加笔记」始终追加到同一文件并分屏打开续写；笔记含来源回链（点击跳回 PDF 对应页）
- **全局单词本**：`<notesRoot>/单词本.md`，多文档统一收集生词（词条 / 翻译 / 来源 / 日期）

## 安装

```bash
npm install        # 安装依赖
npm run check      # 编译 + 单测（35 个用例）
npm run package    # 产出 ai-study-helper-0.1.0.vsix
code --install-extension ai-study-helper-0.1.0.vsix
```

也可以直接用 VS Code 打开本目录按 `F5` 启动扩展开发宿主调试。

## 配置

- **DeepSeek API Key**：命令面板执行 `AI 学习: 设置 API Key`（`aiStudy.setApiKey`），输入后保存到 `SecretStorage`（不落盘明文、不写入日志）。
- 其余配置（设置 → 搜索 `aiStudy`）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `aiStudy.notesRoot` | `~/Documents/StudyNotes` | 笔记库根目录（`~` 会展开） |
| `aiStudy.provider` / `baseUrl` / `model` / `models` | `deepseek` 等 | LLM 提供商与模型（OpenAI 兼容） |
| `aiStudy.maxSteps` | `8` | 每轮最多工具调用次数（预留） |
| `aiStudy.sidePanelWidth` | `45` | 笔记分屏宽度（%），**预留暂不生效**（见已知限制） |
| `aiStudy.explainTarget` | `popover` | 「解释」结果展示位置（预留） |

## 功能

### PDF 阅读

打开任意 `.pdf`（资源管理器右键 `AI 学习: 打开 PDF`，或命令 `aiStudy.openPdf`），使用自带的 `aiStudy.pdfEditor` 阅读器打开：连续滚动、缩放（含「适配宽度」）、页码跳转、关闭重开自动回到上次阅读页。

### 划词工具栏

在 PDF 文本上选中内容 → 跟随选区的浮动工具栏：

- **翻译 / 解释**：页内 popover 流式展示结果（不打断阅读），popover 内可直接「加笔记 / 加单词本」
- **复制**：写入系统剪贴板
- **加笔记 / 加单词本**：见下

编辑器（`.md` / 代码等）内选中文本 → 右键菜单或命令面板：`翻译 / 解释 / 复制 / 添加笔记 / 添加单词本`（兼容入口）。

### 续写式笔记（一文档一笔记）

- 「加笔记」→ 输入标题（预填来源名，取消即中止）→ 笔记不存在则创建（frontmatter 预填 `title/source/sourceType/sourceLink/tags/created/updated`，原文作为首段引用块 + 回链行），已存在则直接追加 `## 手动笔记` 块
- 笔记以 `ViewColumn.Beside` 分屏打开，**光标自动置于文件末尾**继续书写
- 笔记路径：来源文件**所在文件夹名**镜像到 `notesRoot` 下 + 同名 `.md`（如 `/docs/pico.pdf` → `<notesRoot>/docs/pico.md`；根级 `/2.pdf` → `<notesRoot>/2.md`）
- 回链：笔记内 `[返回来源](vscode://file/....pdf#page=N)` 可跳回 PDF 对应页

### 单词本

- 「加单词本」→ 输入翻译（允许留空，取消即中止）→ 追加到全局唯一 `<notesRoot>/单词本.md`（不自动去重，保留每次记录）
- 词条格式：`## 词` + `- 翻译 / - 来源 / - 日期`（例句 / 标签为预留字段）

## 已知限制

1. **分屏宽度无公开 API**：VS Code 不提供精确控制编辑器分屏宽度的公开 API，笔记以 `ViewColumn.Beside` 打开（约 50% 宽度）；`aiStudy.sidePanelWidth` 配置键**保留但暂不生效**。
2. **扫描版 PDF 需手动笔记**：无文字层的扫描页无法划词（不做 OCR），页内提供「手动添加笔记」入口，按页码生成笔记而不携带原文引用。
3. **无源场景**：Harness 对话等无来源的笔记入口（`sourceType: none`）在计划 2 实现。
4. **多面板选区**：PDF 阅读器同时打开多个文件时，划词来源取最近一次选区（既有全局选区语义）。

## 开发

```bash
npm run check    # = npm run compile && npm test（node:test，无需 VS Code 宿主）
npm test         # 仅测试
npm run package  # 打包 vsix
```

- 核心层（`src/llm`、`src/notes`、`src/selection/prompts`、`src/util`）为纯 TS 模块（不 `import 'vscode'`），由 `node:test` 直接单测
- `media/pdf/` 下 `pdf.min.mjs / pdf.worker.min.mjs / cmaps/` 为 `npm run compile` 时从 `pdfjs-dist` 复制的构建产物（不入库）