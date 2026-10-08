/**
 * Harness 控制器：webview 消息 ↔ ConversationStore / runAgentLoop / 工具集 的装配层。
 *
 * 职责：
 * - 会话 CRUD 与模式/模型/Skill 切换（改后 save 并广播 init 刷新会话列表）
 * - send：无 Key 预检 → 附件拼装（formatAttachments）→ runAgentLoop（工具按模式装配，
 *   signal 存 activeAbort）→ store.save → delta/toolLifecycle/finalize/error 推送
 * - createToolContext：ToolContext 的 VS Code 实现（readFile/searchLocal/readPdfPage/listNotes）
 * - buildTools：按模式装配工具集（research 强制 web_search+search_local；web 本任务缺席）
 *
 * 本文件允许 import 'vscode'（readFile/searchLocal/pickAttachment 需要工作区 API）。
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationStore, deriveTitle } from '../core/agent/store';
import { runAgentLoop } from '../core/agent/loop';
import type {
  AgentMessage,
  Conversation,
  ConversationMeta,
  ConversationMode,
} from '../core/agent/types';
import { builtinSkills, defaultSkillIds } from '../core/skills/builtin';
import { readTools, resolveWithin, ToolError } from '../core/tools/readTools';
import { noteTools } from '../core/tools/noteTools';
import { webSearchTool } from '../core/tools/webSearchTool';
import { TavilyProvider } from '../core/search/tavily';
import { BochaProvider } from '../core/search/bocha';
import type { LocalHit, ToolContext, ToolHandler } from '../core/tools/context';
import { parseFrontmatter } from '../notes/frontmatter';
import type { NoteService, SourceInfo } from '../notes/noteService';
import type { AppConfig } from '../config';
import type { LLMProvider } from '../core/llm/types';
import type { PdfSelection } from '../pdf/pdfEditor';
import { formatAttachments } from './attachment';
import { renderSimpleMarkdown } from '../util/markdown';
import type { UiAttachment, UiIn, UiOut, SessionMeta } from './protocol';

/** ChatController 依赖注入（签名与 Task 7 简报一致） */
export interface ChatControllerDeps {
  store: ConversationStore;
  provider: LLMProvider;
  config: AppConfig;
  notes: NoteService;
  /** API Key 读取（webSearchKey 为 Task 8 web_search 预留） */
  getSecrets: () => Promise<{ apiKey: string; webSearchKey: string }>;
  /** 推送 UiOut 到 Harness 视图：init 由 Sink 多播到 session+chat（会话列表即时刷新）；
   *  其余消息仅投 chat 视图（未 resolve 时由 Sink 缓冲） */
  postToChat: (msg: UiOut) => void;
  focusChat: () => void;
  readPdfSelection: () => PdfSelection | undefined;
  readPdfPageText: (page?: number) => Promise<string | undefined>;
  workspace: { cwd?: string; untrusted: boolean; enabled: boolean };
}

/** createToolContext 依赖（notesRoot 必须与 NoteService 构造参数同源） */
export interface ToolContextDeps {
  config: AppConfig;
  notes: NoteService;
  readPdfPageText: (page?: number) => Promise<string | undefined>;
  workspace: { cwd?: string; untrusted: boolean; enabled: boolean };
}

const READ_DEFAULT_MAX_BYTES = 16384;
/** searchLocal 单文件读取头部字节数 */
const SEARCH_HEAD_BYTES = 64 * 1024;
/** searchLocal 每个根目录最多枚举的文件数 */
const SEARCH_MAX_FILES = 200;
/** 附件拾取单个文件读取上限（超出部分丢弃，formatAttachments 还会再截断到 8KB） */
const ATTACHMENT_READ_MAX_BYTES = 256 * 1024;
/** 无来源的会话另存为笔记时落地的 Inbox 目录名（与 noteTools 的 INBOX_DIR 一致） */
const CHAT_NOTE_INBOX = 'Inbox';

/**
 * 按会话模式装配工具集：
 * - chat/quiz：只读工具 + 笔记库写工具
 * - research：额外强制 web_search（deps.web 存在时；Task 8 交付前为 undefined）——
 *   search_local 已包含在 read 工具集中
 * - workspace 工具由调用方按门控（enableWorkspaceWrite && cwd && !untrusted）决定传入
 *   与否（Task 10/11 交付写工具前恒为空数组）
 */
export function buildTools(
  mode: ConversationMode,
  deps: { read: ToolHandler[]; notes: ToolHandler[]; web: ToolHandler | undefined; workspace: ToolHandler[] },
): ToolHandler[] {
  const tools: ToolHandler[] = [...deps.read, ...deps.notes];
  if (mode === 'research' && deps.web) {
    tools.push(deps.web);
  }
  tools.push(...deps.workspace);
  return tools;
}

/**
 * ToolContext 的 VS Code 实现。
 * readFile 与 readTools.execReadFile 同语义：resolveWithin 段级校验 + realpath
 * 二次校验（防符号链接逃逸）+ 超限按字节截断。
 * confirmWorkspaceWrite 刻意缺省（undefined）：工作区写确认在 Task 10 接入，
 * 本任务不注册 workspace 工具（buildTools 的 workspace 恒为空）。
 */
export function createToolContext(deps: ToolContextDeps): ToolContext {
  const notesRoot = deps.config.notesRoot;
  const cwd = deps.workspace.cwd;

  const readFile = async (rel: string, maxBytes?: number): Promise<string> => {
    const root = cwd ?? notesRoot;
    const abs = resolveWithin(root, rel);
    if (!abs) {
      throw new ToolError(`路径越界: ${rel}`);
    }
    // realpath 二次校验：root 与目标都解析后再比较边界（macOS /var → /private/var 等）
    const realRoot = await fs.promises.realpath(root).catch(() => root);
    let real: string | undefined;
    try {
      real = await fs.promises.realpath(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        real = undefined; // 目标不存在，非逃逸
      } else {
        throw new ToolError(`路径越界（符号链接逃逸）: ${rel}`);
      }
    }
    if (real !== undefined && real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ToolError(`路径越界（符号链接逃逸）: ${rel}`);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(real ?? abs)));
    } catch {
      throw new ToolError(`文件不存在或不可读: ${rel}`);
    }
    const limit =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : READ_DEFAULT_MAX_BYTES;
    if (buf.length > limit) {
      return `${buf.subarray(0, limit).toString('utf8')}\n[已截断，共 ${buf.length} 字节]`;
    }
    return buf.toString('utf8');
  };

  const searchLocal = async (query: string, limit?: number): Promise<LocalHit[]> => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    const cap =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
    const roots = [...new Set([cwd, notesRoot].filter((r): r is string => !!r))];
    const seen = new Set<string>();
    const hits: LocalHit[] = [];
    for (const root of roots) {
      if (hits.length >= cap) {
        break;
      }
      let uris: vscode.Uri[];
      try {
        uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(vscode.Uri.file(root), '**/*.{md,txt}'),
          '**/.git/**',
          SEARCH_MAX_FILES,
        );
      } catch {
        continue;
      }
      for (const uri of uris) {
        if (hits.length >= cap) {
          break;
        }
        const fsPath = uri.fsPath;
        if (seen.has(fsPath)) {
          continue;
        }
        seen.add(fsPath);
        let buf: Buffer;
        try {
          buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
        } catch {
          continue; // 单文件读取失败跳过，不中断搜索
        }
        const head = buf.subarray(0, SEARCH_HEAD_BYTES).toString('utf8');
        const display = displayPath(fsPath, roots);
        const lines = head.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            hits.push({ path: display, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      }
    }
    return hits;
  };

  const listNotes = async (): Promise<{ path: string; title: string }[]> => {
    if (!fs.existsSync(notesRoot)) {
      return [];
    }
    const out: { path: string; title: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue; // 跳过隐藏目录（.git/.obsidian 等）
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }
        out.push({ path: path.relative(notesRoot, full), title: await noteTitle(full) });
      }
    };
    await walk(notesRoot);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  };

  return {
    notesRoot,
    cwd,
    readFile,
    searchLocal,
    readPdfPage: (page) => deps.readPdfPageText(page),
    listNotes,
  };
}

/** 显示路径：相对任一搜索根，否则绝对路径 */
function displayPath(fsPath: string, roots: string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, fsPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel;
    }
  }
  return fsPath;
}

/** 读笔记文件头部解析 frontmatter title，失败回落文件名 */
async function noteTitle(fsPath: string): Promise<string> {
  try {
    const buf = await fs.promises.readFile(fsPath);
    const { data } = parseFrontmatter(buf.subarray(0, 4 * 1024).toString('utf8'));
    if (typeof data.title === 'string' && data.title.trim()) {
      return data.title.trim();
    }
  } catch {
    // 解析失败回落文件名
  }
  return path.parse(fsPath).name;
}

/** 去掉历史中「未获得 tool 回应」的 assistant toolCalls（Task 4 收尾遗留的兜底），
 * 避免 DeepSeek API 对带未回应 toolCalls 的历史报 400。 */
function stripUnansweredToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      answered.add(m.toolCallId);
    }
  }
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) {
      return m;
    }
    const answeredCalls = m.toolCalls.filter((c) => answered.has(c.id));
    if (answeredCalls.length === m.toolCalls.length) {
      return m;
    }
    const rest = { role: m.role, content: m.content, ts: m.ts } as AgentMessage;
    if (m.reasoning !== undefined) {
      (rest as { reasoning?: string }).reasoning = m.reasoning;
    }
    if (answeredCalls.length > 0) {
      (rest as { toolCalls?: typeof m.toolCalls }).toolCalls = answeredCalls;
    }
    return rest;
  });
}

function lastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return messages[i];
    }
  }
  return undefined;
}

export class ChatController {
  private readonly toolContext: ToolContext;
  private readonly readHandlers: ToolHandler[];
  private readonly noteHandlers: ToolHandler[];
  /** 会话 id → 进行中请求的中止控制器 */
  private readonly activeAbort = new Map<string, AbortController>();
  /** 会话 id → 工作区写确认的 resolve（confirmWorkspaceWrite 于 Task 10 接入后使用） */
  private readonly pendingConfirms = new Map<string, (accept: boolean) => void>();
  /** 会话 id → 最近一次用户输入（retry 重发用；仅内存，重启后回落到历史消息） */
  private readonly lastInputs = new Map<string, { text: string; attachments: UiAttachment[] }>();
  /** 「解释到会话」复用的 chat 会话 id */
  private explainConvId: string | undefined;

  constructor(private readonly deps: ChatControllerDeps) {
    this.toolContext = createToolContext({
      config: deps.config,
      notes: deps.notes,
      readPdfPageText: deps.readPdfPageText,
      workspace: deps.workspace,
    });
    this.readHandlers = readTools();
    this.noteHandlers = noteTools(deps.notes);
  }

  // ---- 会话管理 ----

  async listSessions(): Promise<ConversationMeta[]> {
    return this.deps.store.list();
  }

  async newConversation(
    mode: ConversationMode,
    model?: string,
    skillIds?: string[],
  ): Promise<Conversation> {
    const now = Date.now();
    const conv: Conversation = {
      id: randomUUID().replace(/-/g, ''),
      title: '新对话',
      mode,
      model: model || this.deps.config.model,
      provider: this.deps.provider.name,
      skillIds: skillIds && skillIds.length > 0 ? [...skillIds] : defaultSkillIds(mode),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.save(conv);
    return conv;
  }

  async open(id: string): Promise<Conversation | undefined> {
    const conv = await this.deps.store.get(id);
    if (conv) {
      // 会话消息仅 view==='chat' 时渲染（Task 6 评审）：视图切换由 focusChat 负责，
      // 这里补发 conversation，chat 视图据此整体渲染
      this.deps.postToChat({ type: 'conversation', conv });
    }
    return conv;
  }

  async rename(id: string, title: string): Promise<void> {
    const conv = await this.deps.store.get(id);
    const trimmed = (title ?? '').trim();
    if (!conv || !trimmed) {
      return;
    }
    conv.title = trimmed;
    conv.updatedAt = Date.now();
    await this.deps.store.save(conv);
    await this.refreshSessions();
  }

  async remove(id: string): Promise<void> {
    this.activeAbort.get(id)?.abort();
    this.activeAbort.delete(id);
    this.lastInputs.delete(id);
    this.pendingConfirms.delete(id);
    await this.deps.store.remove(id);
    await this.refreshSessions();
  }

  async setMode(conversationId: string, mode: ConversationMode): Promise<void> {
    const conv = await this.deps.store.get(conversationId);
    if (!conv || conv.mode === mode) {
      return;
    }
    conv.mode = mode;
    // 与前端 defaultSkillIds(mode) 对齐：切模式后重置会话 skills，避免状态漂移（Task 6 评审）
    conv.skillIds = defaultSkillIds(mode);
    conv.updatedAt = Date.now();
    await this.deps.store.save(conv);
    await this.refreshSessions();
  }

  async setModel(conversationId: string, model: string): Promise<void> {
    const conv = await this.deps.store.get(conversationId);
    if (!conv || !model || conv.model === model) {
      return;
    }
    conv.model = model;
    conv.updatedAt = Date.now();
    await this.deps.store.save(conv);
    await this.refreshSessions();
  }

  toggleSkill(conversationId: string, skillId: string): void {
    void (async () => {
      const conv = await this.deps.store.get(conversationId);
      if (!conv) {
        return;
      }
      conv.skillIds = conv.skillIds.includes(skillId)
        ? conv.skillIds.filter((s) => s !== skillId)
        : [...conv.skillIds, skillId];
      conv.updatedAt = Date.now();
      await this.deps.store.save(conv);
    })();
  }

  /** resolve 挂起的工作区写确认（confirmWorkspaceWrite 于 Task 10 接入，本任务无挂起项） */
  handleConfirm(conversationId: string, accept: boolean): void {
    const resolve = this.pendingConfirms.get(conversationId);
    if (!resolve) {
      return;
    }
    this.pendingConfirms.delete(conversationId);
    resolve(accept);
  }

  // ---- 发送与循环 ----

  /**
   * 发送用户消息并驱动 agent 循环。
   * 空/纯空白且无有效附件时忽略；`announce` 为 true 时（扩展侧发起：
   * ensureResearchSession/explainToConversation）在追加用户消息后先补发
   * conversation 让 chat 视图整体渲染，再开始流式。
   */
  async send(
    conversationId: string,
    text: string,
    attachments: UiAttachment[] = [],
    opts: { announce?: boolean } = {},
  ): Promise<void> {
    const trimmed = (text ?? '').trim();
    const formatted = formatAttachments(attachments);
    if (!trimmed && !formatted.text) {
      return; // 空/纯空白忽略
    }
    const conv = await this.deps.store.get(conversationId);
    if (!conv) {
      return;
    }
    if (this.activeAbort.has(conversationId)) {
      return; // 上一轮仍在进行，忽略重复发送
    }

    if (conv.messages.length === 0) {
      conv.title = deriveTitle(trimmed || attachments.find((a) => a.name)?.name || '');
    }
    const userText = [trimmed, formatted.text].filter(Boolean).join('\n\n');
    conv.messages.push({ role: 'user', content: userText, ts: Date.now() });
    conv.updatedAt = Date.now();
    await this.deps.store.save(conv);
    this.lastInputs.set(conversationId, { text: trimmed, attachments });

    if (opts.announce) {
      this.deps.postToChat({ type: 'conversation', conv: { ...conv } });
    }
    await this.runTurn(conv);
  }

  abort(conversationId: string): void {
    this.activeAbort.get(conversationId)?.abort();
  }

  /** 重发最后一条 user 消息：截断其后的历史（含该消息）后按原输入重发 */
  retry(conversationId: string): void {
    void (async () => {
      const conv = await this.deps.store.get(conversationId);
      if (!conv || this.activeAbort.has(conversationId)) {
        return;
      }
      let index = -1;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === 'user') {
          index = i;
          break;
        }
      }
      if (index < 0) {
        return;
      }
      const lastInput = this.lastInputs.get(conversationId);
      const text = lastInput ? lastInput.text : conv.messages[index].content;
      const attachments = lastInput ? lastInput.attachments : [];
      conv.messages = conv.messages.slice(0, index);
      await this.deps.store.save(conv);
      await this.send(conversationId, text, attachments);
    })();
  }

  /** 划词「解释」路由到会话（explainTarget=conversation）：复用最近的 chat 会话或新建 */
  async explainToConversation(text: string, source?: SourceInfo): Promise<void> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      return;
    }
    const conv = await this.reuseOrCreateChat();
    const sourceLine = source
      ? `【来源：${source.displayName}${source.page ? ` 第 ${source.page} 页` : ''}】\n\n`
      : '';
    const { user } = buildExplainPrompt(trimmed);
    this.deps.focusChat();
    await this.send(conv.id, `${sourceLine}${user}`, [], { announce: true });
  }

  /**
   * 「AI 搜索」划词：复用最近未完成的 research 会话或新建（无会话状态字段，
   * 取 updatedAt 最近research 会话），发送文本并聚焦 chat 视图。
   */
  async ensureResearchSession(text: string): Promise<void> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      return;
    }
    const metas = await this.deps.store.list();
    const meta = metas.find((m) => m.mode === 'research');
    let conv = meta ? await this.deps.store.get(meta.id) : undefined;
    if (!conv || conv.mode !== 'research') {
      conv = await this.newConversation('research');
    }
    // 记录划词来源（researchSource 为 Task 9 一键笔记预留）
    const sel = this.deps.readPdfSelection();
    if (sel && !conv.researchSource) {
      conv.researchSource = vscode.Uri.parse(sel.uri).fsPath;
    }
    conv.updatedAt = Date.now();
    await this.deps.store.save(conv);
    this.deps.focusChat();
    await this.send(conv.id, trimmed, [], { announce: true });
  }

  /** 会话另存为笔记：openOrCreate + appendTo，完成后 postToChat(noteSaved) */
  async saveAsNote(conversationId: string, text: string, source?: string): Promise<void> {
    const content = (text ?? '').trim();
    if (!content) {
      return;
    }
    const conv = await this.deps.store.get(conversationId);
    // 来源回退：未显式传 source 时优先本会话 researchSource（「AI 搜索」划词来源；
    // 一键笔记优先写入该来源笔记），否则落 Inbox
    if (!source && conv?.researchSource) {
      source = conv.researchSource;
    }
    const sourceInfo = this.sourceInfoFor(source, conv?.title);
    const { notePath, created } = await this.deps.notes.openOrCreate(sourceInfo, {
      headings: [{ heading: '会话摘录', body: content }],
    });
    this.deps.postToChat({ type: 'noteSaved', path: notePath, created });
  }

  /** webview 请求当前 PDF 页文本（挂为待发送附件） */
  async requestPageText(): Promise<void> {
    const text = await this.deps.readPdfPageText().catch(() => undefined);
    this.deps.postToChat({ type: 'pageText', text: text ?? '' });
  }

  /** webview「去配置」按钮 → 打开 API Key 设置命令 */
  openSettings(): void {
    void vscode.commands.executeCommand('aiStudy.setApiKey');
  }

  /** 附件拾取：文件选择器 → 读取内容（图片仅取名字）→ attachmentPicked 回传 */
  async pickAttachment(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { '文本 / Markdown': ['txt', 'md'], '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    });
    if (!picks || picks.length === 0) {
      return;
    }
    for (const uri of picks) {
      const name = path.basename(uri.fsPath);
      const ext = path.extname(name).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        // 图片：不读内容，chat 端以降级引用占位
        this.deps.postToChat({ type: 'attachmentPicked', attachment: { kind: 'image', name } });
        continue;
      }
      try {
        const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const content = buf.subarray(0, ATTACHMENT_READ_MAX_BYTES).toString('utf8');
        this.deps.postToChat({ type: 'attachmentPicked', attachment: { kind: 'file', name, content } });
      } catch {
        // 读取失败忽略该附件
      }
    }
  }

  /** init 载荷：会话列表（meta 补 model 字段供前端精确回显）+ 模型/skill 目录 + 能力开关 */
  async buildInitPayload(): Promise<UiOut> {
    const metas = await this.deps.store.list();
    const sessions: SessionMeta[] = await Promise.all(
      metas.map(async (m) => ({ ...m, model: (await this.deps.store.get(m.id))?.model ?? '' })),
    );
    const webSearchAvailable = !!(await this.webHandler());
    return {
      type: 'init',
      sessions,
      models: this.deps.config.models,
      // web 工具未注册时把 search skill 的 defaultOn 置 false（Task 7 评审 minor ⑦）：
      // 避免 chat 模式默认启用 search skill 却无工具可调用
      skills: builtinSkills.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        description: s.description,
        defaultOn: webSearchAvailable || s.id !== 'search' ? s.defaultOn : false,
        ...(s.icon ? { icon: s.icon } : {}),
      })),
      webSearchAvailable,
      workspaceWriteEnabled:
        this.deps.workspace.enabled && !!this.deps.workspace.cwd && !this.deps.workspace.untrusted,
    };
  }

  /** webview UiIn 消息统一入口（session/chat 两个视图共用） */
  async handleUiIn(msg: UiIn): Promise<void> {
    switch (msg.type) {
      case 'ready':
        break; // init 已在视图 resolve 时主动推送（ready 保留协议不强求）
      case 'newConversation': {
        const conv = await this.newConversation(msg.mode, msg.model, msg.skillIds);
        this.deps.focusChat();
        this.deps.postToChat({ type: 'conversation', conv });
        await this.refreshSessions();
        break;
      }
      case 'openConversation': {
        this.deps.focusChat();
        const conv = await this.open(msg.id);
        if (!conv) {
          await this.refreshSessions();
        }
        break;
      }
      case 'deleteConversation':
        await this.remove(msg.id);
        break;
      case 'renameConversation':
        await this.rename(msg.id, msg.title);
        break;
      case 'setMode':
        await this.setMode(msg.conversationId, msg.mode);
        break;
      case 'setModel':
        await this.setModel(msg.conversationId, msg.model);
        break;
      case 'toggleSkill':
        this.toggleSkill(msg.conversationId, msg.skillId);
        break;
      case 'confirmWorkspace':
        this.handleConfirm(msg.conversationId, msg.accept);
        break;
      case 'send':
        await this.send(msg.conversationId, msg.text, msg.attachments ?? []);
        break;
      case 'retry':
        this.retry(msg.conversationId);
        break;
      case 'saveAsNote':
        await this.saveAsNote(msg.conversationId, msg.text, msg.source);
        break;
      case 'pickAttachment':
        await this.pickAttachment();
        break;
      case 'requestPageText':
        await this.requestPageText();
        break;
      case 'openSettings':
        this.openSettings();
        break;
      case 'openNote': {
        // 「打开笔记」：文件不存在或读取失败时提示，不抛未捕获异常
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
          await vscode.window.showTextDocument(doc);
        } catch {
          void vscode.window.showErrorMessage(`无法打开笔记: ${msg.path}`);
        }
        break;
      }
    }
  }

  // ---- 内部 ----

  /**
   * 网页搜索工具装配：`webSearchProvider === 'none'` 或无 Key 时返回 undefined
   * （不注册 web_search；research 模式退化为仅本地检索），否则按配置选
   * Tavily/博查 Provider 并包装为 web_search 工具。
   */
  private async webHandler(): Promise<ToolHandler | undefined> {
    const { webSearchKey } = await this.deps.getSecrets();
    if (this.deps.config.webSearchProvider === 'none' || !webSearchKey.trim()) {
      return undefined;
    }
    const getKey = (): Promise<string> => Promise.resolve(webSearchKey);
    const provider =
      this.deps.config.webSearchProvider === 'bocha'
        ? new BochaProvider(getKey)
        : new TavilyProvider(getKey);
    return webSearchTool(provider);
  }

  /** 驱动一轮 agent 循环：工具装配 → 流式推送 → 落盘 → 收尾消息 */
  private async runTurn(conv: Conversation): Promise<void> {
    const abort = new AbortController();
    this.activeAbort.set(conv.id, abort);
    try {
      // 无 Key 预检：直接错误卡（前端「去配置」按钮已接线 openSettings）
      const { apiKey } = await this.deps.getSecrets();
      if (!apiKey.trim()) {
        this.postError(conv.id, 'noApiKey', '未配置 DeepSeek API Key，请点击「去配置」或运行命令「AI 学习: 设置 API Key」。');
        return;
      }
      const toolNameById = new Map<string, string>();
      const result = await runAgentLoop({
        provider: this.deps.provider,
        model: conv.model,
        mode: conv.mode,
        skills: builtinSkills.filter((s) => conv.skillIds.includes(s.id)),
        // 兜底：剥掉历史中未获得 tool 回应的 toolCalls（Task 4 收尾遗留），避免 API 400
        history: stripUnansweredToolCalls(conv.messages),
        tools: buildTools(conv.mode, {
          read: this.readHandlers,
          notes: this.noteHandlers,
          // web_search 按配置/Key 装配：provider 为 none 或无 Key 时不注册（research 模式仅本地检索）
          web: await this.webHandler(),
          workspace: [], // Task 10/11 门控点：enableWorkspaceWrite && cwd && !untrusted 时并入
        }),
        ctx: { ...this.toolContext, signal: abort.signal },
        maxSteps: this.deps.config.maxSteps,
        signal: abort.signal,
        hooks: {
          onDelta: (delta) => {
            this.deps.postToChat({ type: 'delta', conversationId: conv.id, delta });
          },
          onToolCall: (call) => {
            toolNameById.set(call.id, call.name);
            this.deps.postToChat({
              type: 'toolLifecycle',
              conversationId: conv.id,
              callId: call.id,
              name: call.name,
              status: 'running',
            });
          },
          onToolResult: (callId, toolResult, ok) => {
            this.deps.postToChat({
              type: 'toolLifecycle',
              conversationId: conv.id,
              callId,
              name: toolNameById.get(callId) ?? callId,
              status: ok ? 'done' : 'error',
              result: toolResult,
            });
          },
        },
      });
      conv.messages.push(...result.messages);
      if (result.error) {
        this.postError(conv.id, result.error.kind, result.error.message, result.error.retryable);
      } else if (result.truncated) {
        this.postError(conv.id, 'maxSteps', '已达单轮最大工具调用次数，回复可能不完整。', true);
      } else if (result.aborted) {
        // 用户中止：保留已上屏内容，以 finalize 收尾流式气泡
        const last = lastAssistant(result.messages);
        if (last && last.content.trim()) {
          this.postFinalize(conv.id, last);
        }
      } else {
        const last = lastAssistant(result.messages);
        if (last) {
          this.postFinalize(conv.id, last);
        }
      }
    } finally {
      this.activeAbort.delete(conv.id);
      conv.updatedAt = Date.now();
      await this.deps.store.save(conv);
      await this.refreshSessions();
    }
  }

  private postFinalize(conversationId: string, message: AgentMessage): void {
    this.deps.postToChat({
      type: 'finalize',
      conversationId,
      messageId: `${conversationId}:${message.ts}`,
      html: renderSimpleMarkdown(message.content),
    });
  }

  private postError(conversationId: string, kind: string, message: string, retryable = false): void {
    this.deps.postToChat({ type: 'error', conversationId, kind, message, retryable });
  }

  private async refreshSessions(): Promise<void> {
    this.deps.postToChat(await this.buildInitPayload());
  }

  private async reuseOrCreateChat(): Promise<Conversation> {
    if (this.explainConvId) {
      const cached = await this.deps.store.get(this.explainConvId);
      if (cached && cached.mode === 'chat') {
        return cached;
      }
    }
    const metas = await this.deps.store.list();
    const meta = metas.find((m) => m.mode === 'chat');
    const existing = meta ? await this.deps.store.get(meta.id) : undefined;
    if (existing && existing.mode === 'chat') {
      this.explainConvId = existing.id;
      return existing;
    }
    const created = await this.newConversation('chat');
    this.explainConvId = created.id;
    return created;
  }

  /** 无来源 → Inbox/<会话标题>.md（notePathForSource 镜像规则自然落地 Inbox） */
  private sourceInfoFor(source: string | undefined, fallbackTitle?: string): SourceInfo {
    if (source) {
      return {
        displayName: path.basename(source),
        sourcePath: source,
        sourceType: source.toLowerCase().endsWith('.pdf') ? 'pdf' : 'editor',
      };
    }
    const title = (fallbackTitle || '会话笔记').replace(/[\\/]/g, '-').trim() || '会话笔记';
    return {
      displayName: title,
      sourcePath: path.join(this.deps.config.notesRoot, CHAT_NOTE_INBOX, `${title}.md`),
      sourceType: 'none',
    };
  }
}

// buildExplainPrompt 延迟到这里 import 会形成循环依赖风险，实际无循环：
import { buildExplainPrompt } from '../selection/prompts';
