# PDF 阅读器问题排查与待修复文档

> 日期：2026-09-30 ｜ 对应模块：M0-M3 PDF 阅读器（Custom Text Editor + PDF.js webview）
> 本文档汇总近期「PDF 打不开 / 串文档 / 弹二进制错误框」问题的根因、已做的修复、涉及实现区域与待办项。
> 现状结论：**扩展侧能修的已修完；剩余「binary 弹窗」是 VS Code 内部恢复路径行为，已配置缓解项，待重启验证后决定是否走方案 A 彻底重构。**

---

## 1. 问题总览

| # | 现象 | 根因 | 状态 |
|---|------|------|------|
| 1 | 多个 PDF 标签页都指向同一篇文档（CoT 文章），或打开后无内容 | 预览式标签页复用自定义编辑器面板，未重新 `resolve` | ✅ 已修复（`preview: false`） |
| 2 | 「File seems to be binary and cannot be opened as text」/「The editor could not be opened due to an unexpected error」 | VS Code 会话恢复 `tryRevive` 将二进制 PDF 当文本模型读取 → `FileBinaryError`（扩展无法拦截） | ❌ 缓解项已证伪（`restoreWindows: "none"` 实测无效），**待修复：走方案 A**（§2.4） |
| 3 | 「Invalid PDF structure」 | 文件本身下载截断（无 `%%EOF`/`startxref`/trailer），非扩展 bug | ✅ 定位清楚；已提供 `scripts/pdf-recover.mjs` 抢救；扩展内友好提示为待办 |
| 4 | 偶发「No GlobalWorkerOptions.workerSrc」+ 首开 12s 卡死 | `setupPdfWorker()` 异步与 `getDocument` 竞态；回退链 import 被 CSP 拦截的 blob URL | ✅ 已修复（`workerPort` + 同步回退） |
| 5 | 首开慢（主线程解析期） | 修复 #4 时回退到主线程解析 | ✅ 已修复（`workerPort` 恢复 worker 解析，01 实测 1.4s/31 页） |

---

## 2. 问题 2 详述（本批排查重点）

### 2.1 现象

- 触发场景：**重载窗口（Reload Window）或重启 VS Code 后会话恢复**时，对已打开过的 PDF 标签页（含 02/06/32 等文件）弹错误框；相同文件**全新打开正常**（如 32_clam 实测 17 页、06 实测 27 页，与系统预览一致）。
- 错误框两种形态：
  - `Unable to open '<file>.pdf' — File seems to be binary and cannot be opened as text`（附件截图即此形态）
  - `The editor could not be opened due to an unexpected error`
- 用户曾反馈「关闭所有标签页再重载仍复现」——因为关闭标签页只是关闭了编辑器，**工作区布局（打开的编辑器集合）仍被会话记录**，重载后恢复路径依旧尝试复活该自定义编辑器。

### 2.2 根因链（VS Code 内部，非扩展代码）

```
workbench 恢复会话
  └→ WebviewEditorService.tryRevive()                 ← 复活自定义编辑器 webview
       └→ createModelReference(uri)                   ← 为文件创建 TextDocument
            └→ textFileService 读取 + 二进制检测
                 └→ 检测到 NUL/二进制内容
                      └→ 抛 FileBinaryError          ← “binary” 弹窗来源
```

- `CustomTextEditorProvider` 的 API 契约是 `vscode.TextDocument`（见 `resolveCustomTextEditor(document: TextDocument, ...)`），VS Code 内部为自定义编辑器维护文本模型；**恢复路径会急切地走文本模型创建 + 二进制检测**，而 PDF 是二进制文件，故必然被拒。
- 该路径在 `workbench` 内部完成，**不经过扩展任何钩子**（无法用 `onDidOpenCustomEditor` 等 API 拦截），扩展侧没有合法挂钩点。
- 实测对比：`vscode.openWith` 全新打开走的是另一条（宽容的）路径，所以「首次打开」全部正常。

### 2.3 已尝试的缓解项（已证伪）

~~`window.restoreWindows: "none"`~~（已回退）：2026-09-30 实测**无效**——即使不恢复窗口，重载/重启后打开 PDF 仍弹 binary 错误框。说明 `tryRevive` 并非只在会话恢复路径触发，`workbench.editorAssociations` 关联的自定义编辑器在重载时仍会走文本模型创建 + 二进制检测。**该设置已从用户 settings.json 移除。**

- 由于该路不可绕行，问题 2 的修复只能靠**方案 A**（自管 `WebviewPanel`，§2.4），已列入**计划 2（M4-M6）完成之后的 backlog**（见 §5 待修复清单）。
- 若实现方案 A 前仍需排查，可从 Output 面板「AI 学习助手」/ `nota-trace.log` 确认弹窗时刻的调用栈（曾出现 `KHe.resolveWebview`），定位是否还有独立于恢复的触发路径。

### 2.4 彻底修复的可选方案（计划 2 之后，backlog）

> **状态（2026-10-08）**：计划 2（M4-M6）已交付完成，本方案 A 为**计划 2 之后的 backlog 项**（用户已确认「整个项目完成后再细改」），当前不再继续排查该问题。

- **方案 A（推荐，改动适中）**：废弃 Custom Text Editor，改为扩展自管 `WebviewPanel` + `WebviewPanelSerializer`：
  - 自己创建/恢复 panel，完全不经过文本模型与二进制检测，问题 2 与 editorAssociations 路径彻底解耦；
  - 代价：失去 `workbench.editorAssociations`（双击 .pdf 自动打开）、自定义文件图标、标签页原生行为，需要自己实现「文件→面板」映射与恢复；
  - 注意：`pdf:open` / 阅读位置记忆 / 注记消息协议可整体复用，viewer 侧改动小。
- **方案 B（最小改动）**：维持现状（custom editor + `restoreWindows: "none"`），在 README/发布说明中明示「重启后需手动重新打开 PDF」。
- **可选增强**：检测到 `%%EOF` 缺失时在 viewer 内提示「文件可能下载不完整」，并引导使用 `scripts/pdf-recover.mjs`（见问题 3）。

---

## 3. 问题 3 详述（截断文件，非扩展 bug）

- 特征：整份文件 **0 个 `%%EOF`、0 个 `startxref`、无 trailer**，尾部停在某个对象（04 为图像流、05 为 Form 流）中段；对象表本身完整（04 有 788 个、05 有 623 个对象）。
- `file` 命令仅看头部，故误报「15/10 页」；macOS Preview（PDFKit）可全文件扫描重建索引并跳过损坏尾部对象，因此能打开；pdf.js 4.10 严格校验 + 恢复模式也定位不到 Root，故报 `Invalid PDF structure`。
- 已处理：`scripts/pdf-recover.mjs`（qpdf `--recover` 同款：扫描对象 → 重建 xref → 补 trailer），对 04/05 恢复出 **27/31 页**且逐页文本提取成功（仅尾部被截断的图像对象被跳过）。
- 用法：`node scripts/pdf-recover.mjs 输入.pdf 输出.pdf`。

---

## 4. PDF 阅读器实现区域（文件地图）

### 4.1 扩展侧

| 文件 | 职责 | 关键位置 |
|------|------|----------|
| `src/extension.ts` | 注册 `PdfEditorProvider`（无 `retainContextWhenHidden`）；`aiStudy.openPdf` 命令 → `vscode.openWith(..., { preview: false })` | 注册：L24-30；openPdf：L251-270 |
| `src/pdf/pdfEditor.ts` | **核心**：`PdfEditorProvider`（CustomTextEditorProvider）。resolve（阅读位置/资源根/消息监听/`pdf:open` 下发，L148-240）；HTML+CSP 注入（L344-366，含 `worker-src blob:`）；消息路由 `handleViewerMessage`（L257-342）；`trace()` 诊断（L136-146）；面板→URI 映射 `panelsByUri`、`lastPageByUri` | 见左 |
| `src/pdf/helpers.ts` | `pageStateKey` / `pageFromFragment` / `clampPage` / `classifyPageText`（扫描页分类） | — |
| `package.json` | `customEditorProviders` 注册 `aiStudy.pdfEditor`；命令/菜单 | — |

### 4.2 Webview 侧（`media/pdf/`）

| 文件 | 职责 | 关键位置 |
|------|------|----------|
| `media/pdf/viewer.js` | PDF.js 加载与渲染、文本层选择、浮动工具栏、popover、与扩展的消息协议 | `setupPdfWorker`（L41-59，workerPort + 主线程回退）；`openPdf`（L108-166，fetch → `getDocument`）；`diag`（L13）；`window.onerror` / `unhandledrejection`（L21-25） |
| `media/pdf/viewer.html` | 页面骨架；`{{CSP}}`/`{{VIEWER_CSS}}`/`{{VIEWER_JS}}` 注入点 | — |
| `media/pdf/viewer.css` | 阅读器/工具栏/popover 样式 | — |
| `media/pdf/pdf.min.mjs`、`pdf.worker.min.mjs`、`cmaps/` | vendor 资源（`scripts/copy-pdf-assets.js` 从 `node_modules/pdfjs-dist` 复制，不提交 node_modules） | — |

### 4.3 诊断与工具

- 诊断日志（两级）：
  - Output 面板「AI 学习助手」：`[pdf]` / `[trace]` 前缀；
  - 文件日志：`<globalStorage>/pico-local.nota-vscode/nota-trace.log`（追加式，含 panel id、open/loaded/error 时间线，排查「打不开/串文档」用）。
- `scripts/copy-pdf-assets.js`：vendor 资源复制（打包前运行）。
- `scripts/pdf-recover.mjs`：截断 PDF 抢救工具（§3）。
- 消息协议（viewer ⇄ extension）：`ready` / `pdf:open` / `pdf:loaded` / `pdf-selection` / `toolbar-action` / `note-action` / `page-change` / `pdf:error` / `viewer-diag` / `result`（定义见 `src/pdf/pdfEditor.ts` L19-73）。

---

## 5. 待修复清单（按优先级）

- [ ] **[backlog · 计划 2 之后]（方案 A）自管 WebviewPanel + `WebviewPanelSerializer`** 替换 Custom Text Editor，从根上消除文本模型/二进制检测依赖（§2.4，含收益与代价分析）——`restoreWindows: "none"` 已证伪；**计划 2（M4-M6）已完成，此项转入计划 2 之后的 backlog**（用户已确认「整个项目完成后再细改」）。
- [ ] **截断文件友好提示**：viewer 侧检测 `%%EOF` 缺失时提示「文件可能下载不完整」，引导 `pdf-recover.mjs` 或重新下载（§3）。
- [ ] **诊断降噪**：`nota-trace.log` 增加开关/轮转，避免长期运行膨胀；`viewer-diag` 只保留错误级。
- [ ] **回归**：`preview: false` 后多文档独立性与阅读位置回写（`#page=N` 回链、关闭回写）再走一遍手测（01/03/04/19/32 + 两篇 recovered）。

## 6. 复现与验证速查

- 复现 binary 弹窗：打开任一 PDF → 命令面板 Reload Window → 观察弹窗（修复前必现）。
- 验证多文档独立：`aiStudy.openPdf` 连续打开 2 个不同 PDF，确认各自内容与页码互不串扰。
- 验证加载性能：看 `nota-trace.log` 中 `openPdf entry` → `fetched N bytes` → `loaded pages=N` 的时间差（01 基线：~1.4s / 31 页，worker 解析）。