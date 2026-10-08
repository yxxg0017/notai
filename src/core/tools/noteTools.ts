/**
 * 笔记库写工具集（create_note / append_note / edit_note / move_note / update_frontmatter）。
 *
 * 安全约束：所有笔记路径（相对 note 参数、Inbox 兜底、来源镜像派生、move 目标）
 * 统一经 isInsideVault 白名单校验，`..` 穿越与外部绝对路径一律 ToolError 拒绝。
 * 工具内部错误统一抛 ToolError，由执行层捕获回填为 tool 消息，不中断 LLM 循环。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NoteService, SourceInfo } from '../../notes/noteService';
import { isInsideVault } from '../../notes/vault';
import { parseFrontmatter, stringifyFrontmatter } from '../../notes/frontmatter';
import { ToolContext, ToolError, ToolHandler } from './context';

/** source 缺省时的 Inbox 兜底目录 */
const INBOX_DIR = 'Inbox';
/** source 缺省且未传 title 时的默认标题 */
const DEFAULT_TITLE = '无标题';
/** create_note / append_note 未指定 heading 时的默认段标题 */
const DEFAULT_HEADING = 'AI 总结';

function asStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 由来源文件绝对路径构造 SourceInfo（类型按扩展名粗略推断） */
function sourceInfoFromPath(source: string): SourceInfo {
  return {
    displayName: path.basename(source),
    sourcePath: source,
    sourceType: source.toLowerCase().endsWith('.pdf') ? 'pdf' : 'editor',
  };
}

/**
 * frontmatter 键值解析：'[a, b]' 内联数组形式解析为 string[]（避免 stringify 时被当
 * 普通字符串加引号），其余保留原字符串。
 */
function parseFrontmatterValue(value: string): unknown {
  const s = value.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return inner.split(',').map((part) => part.trim());
  }
  return s;
}

/**
 * 笔记路径白名单：相对 notesRoot 解析后必须位于 notesRoot 内；
 * `..` 穿越与外部绝对路径抛 ToolError。
 */
function resolveNotePath(notesRoot: string, note: string): string {
  if (!note) {
    throw new ToolError('缺少 note 参数');
  }
  const abs = path.resolve(notesRoot, note);
  if (!isInsideVault(notesRoot, abs)) {
    throw new ToolError(`笔记路径越界（白名单拒绝）: ${note}`);
  }
  return abs;
}

/** create_note：来源文件建笔记（缺省落 Inbox），content 非空再追加一段 */
async function execCreateNote(
  noteService: NoteService,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const source = asStr(args, 'source');
  const title = asStr(args, 'title');
  const content = asStr(args, 'content');
  const heading = asStr(args, 'heading') || DEFAULT_HEADING;
  const headings = content ? [{ heading, body: content }] : [];

  if (source) {
    const { notePath, created } = await noteService.openOrCreate(
      sourceInfoFromPath(source),
      { headings, titleOverride: title || undefined }
    );
    return `已写入 ${notePath}${created ? '（新建）' : '（已存在，续写）'}`;
  }

  // source 缺省 → Inbox：直接定位 Inbox/<title>.md，白名单校验后按 openOrCreate 同款流程处理
  const safeTitle = (title || DEFAULT_TITLE).replace(/[\\/]/g, '-').trim() || DEFAULT_TITLE;
  const notePath = path.join(ctx.notesRoot, INBOX_DIR, `${safeTitle}.md`);
  if (!isInsideVault(ctx.notesRoot, notePath)) {
    throw new ToolError(`笔记路径越界（白名单拒绝）: ${notePath}`);
  }
  let created = false;
  if (!fs.existsSync(notePath)) {
    await fs.promises.mkdir(path.dirname(notePath), { recursive: true });
    const now = new Date().toISOString();
    const frontmatter: Record<string, unknown> = {
      title: title || DEFAULT_TITLE,
      source: 'Inbox',
      sourceType: 'none',
      sourceLink: '',
      tags: [],
      created: now,
      updated: now,
    };
    await fs.promises.writeFile(notePath, `${stringifyFrontmatter(frontmatter)}\n`, 'utf8');
    created = true;
  }
  if (headings.length > 0) {
    await noteService.appendTo(notePath, headings);
  }
  return `已写入 ${notePath}${created ? '（新建）' : '（已存在，续写）'}`;
}

/** append_note：向指定笔记追加一段；笔记不存在 → 先 openOrCreate 再追加 */
async function execAppendNote(
  noteService: NoteService,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const note = asStr(args, 'note');
  const source = asStr(args, 'source');
  const heading = asStr(args, 'heading') || DEFAULT_HEADING;
  const content = asStr(args, 'content');
  if (!content) {
    throw new ToolError('append_note 缺少 content 参数');
  }
  const headings = [{ heading, body: content }];

  let notePath: string;
  if (note) {
    notePath = resolveNotePath(ctx.notesRoot, note);
  } else if (source) {
    notePath = noteService.notePathFor(sourceInfoFromPath(source));
    if (!isInsideVault(ctx.notesRoot, notePath)) {
      throw new ToolError(`笔记路径越界（白名单拒绝）: ${notePath}`);
    }
  } else {
    throw new ToolError('append_note 需要 note 或 source 参数之一');
  }

  if (fs.existsSync(notePath)) {
    await noteService.appendTo(notePath, headings);
    return `已写入 ${notePath}`;
  }
  // 笔记不存在 → 先 openOrCreate 再追加（有 source 时按来源派生路径）
  if (source) {
    const { notePath: createdPath } = await noteService.openOrCreate(
      sourceInfoFromPath(source),
      { headings }
    );
    return `已写入 ${createdPath}（新建）`;
  }
  // 无 source：按 note 相对路径最小创建（openOrCreate 同款 frontmatter），再追加
  await fs.promises.mkdir(path.dirname(notePath), { recursive: true });
  const now = new Date().toISOString();
  const frontmatter: Record<string, unknown> = {
    title: path.parse(notePath).name,
    source: '',
    sourceType: 'none',
    sourceLink: '',
    tags: [],
    created: now,
    updated: now,
  };
  await fs.promises.writeFile(notePath, `${stringifyFrontmatter(frontmatter)}\n`, 'utf8');
  await noteService.appendTo(notePath, headings);
  return `已写入 ${notePath}（新建）`;
}

/** edit_note：整文件覆盖（frontmatter 保留：parseFrontmatter 后重组） */
async function execEditNote(
  noteService: NoteService,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const note = asStr(args, 'note');
  const content = asStr(args, 'content');
  if (!note) {
    throw new ToolError('edit_note 缺少 note 参数');
  }
  if (!content) {
    throw new ToolError('edit_note 缺少 content 参数');
  }
  const notePath = resolveNotePath(ctx.notesRoot, note);
  if (!fs.existsSync(notePath)) {
    throw new ToolError(`笔记不存在: ${note}`);
  }
  const text = await fs.promises.readFile(notePath, 'utf8');
  const { data } = parseFrontmatter(text);
  const newText =
    Object.keys(data).length > 0
      ? `${stringifyFrontmatter(data)}\n${content}\n`
      : `${content}\n`;
  await fs.promises.writeFile(notePath, newText, 'utf8');
  return `已写入 ${notePath}`;
}

/** move_note：重命名/移动，to 同样白名单校验 */
async function execMoveNote(
  _noteService: NoteService,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const from = asStr(args, 'from');
  const to = asStr(args, 'to');
  if (!from) {
    throw new ToolError('move_note 缺少 from 参数');
  }
  if (!to) {
    throw new ToolError('move_note 缺少 to 参数');
  }
  const fromPath = resolveNotePath(ctx.notesRoot, from);
  const toPath = resolveNotePath(ctx.notesRoot, to);
  if (!fs.existsSync(fromPath)) {
    throw new ToolError(`笔记不存在: ${from}`);
  }
  if (fs.existsSync(toPath)) {
    throw new ToolError(`目标已存在: ${to}`);
  }
  await fs.promises.mkdir(path.dirname(toPath), { recursive: true });
  await fs.promises.rename(fromPath, toPath);
  return `已移动 ${from} -> ${to}`;
}

/** update_frontmatter：更新单个键（值支持内联数组形式） */
async function execUpdateFrontmatter(
  _noteService: NoteService,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const note = asStr(args, 'note');
  const key = asStr(args, 'key');
  const value = asStr(args, 'value');
  if (!note) {
    throw new ToolError('update_frontmatter 缺少 note 参数');
  }
  if (!key) {
    throw new ToolError('update_frontmatter 缺少 key 参数');
  }
  if (!value) {
    throw new ToolError('update_frontmatter 缺少 value 参数');
  }
  const notePath = resolveNotePath(ctx.notesRoot, note);
  if (!fs.existsSync(notePath)) {
    throw new ToolError(`笔记不存在: ${note}`);
  }
  const text = await fs.promises.readFile(notePath, 'utf8');
  const { data, body } = parseFrontmatter(text);
  data[key] = parseFrontmatterValue(value);
  await fs.promises.writeFile(notePath, `${stringifyFrontmatter(data)}\n${body}`, 'utf8');
  return `已写入 ${notePath}（更新 ${key}）`;
}

/** 笔记库写工具集：create_note / append_note / edit_note / move_note / update_frontmatter */
export function noteTools(noteService: NoteService): ToolHandler[] {
  const withService = (
    exec: (noteService: NoteService, args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
  ) =>
    (args: Record<string, unknown>, ctx: ToolContext): Promise<string> =>
      exec(noteService, args, ctx);

  return [
    {
      definition: {
        name: 'create_note',
        description:
          '创建或续写一篇学习笔记。source 为来源文件绝对路径（缺省落 Inbox）；title 覆盖笔记标题；content 非空时追加一个 heading 小节。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '来源文件绝对路径（缺省落 Inbox）' },
            title: { type: 'string', description: '笔记标题（frontmatter title，文件名仍按来源派生）' },
            content: { type: 'string', description: '要追加的正文内容' },
            heading: { type: 'string', description: '追加小节的标题，默认 "AI 总结"' },
          },
          required: ['content'],
        },
      },
      access: 'notes',
      execute: (args, ctx) => execCreateNote(noteService, args, ctx),
    },
    {
      definition: {
        name: 'append_note',
        description:
          '向指定笔记追加一个 heading 小节。note 为相对 notesRoot 的路径；也可改传 source（来源文件绝对路径）自动定位对应笔记；笔记不存在 → 先 openOrCreate 再追加。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '相对 notesRoot 的笔记路径' },
            source: { type: 'string', description: '来源文件绝对路径（自动派生对应笔记）' },
            heading: { type: 'string', description: '追加小节的标题' },
            content: { type: 'string', description: '追加的正文内容' },
          },
          required: ['heading', 'content'],
        },
      },
      access: 'notes',
      execute: (args, ctx) => execAppendNote(noteService, args, ctx),
    },
    {
      definition: {
        name: 'edit_note',
        description:
          '整体覆盖指定笔记的正文内容（frontmatter 保留）。note 为相对 notesRoot 的路径。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '相对 notesRoot 的笔记路径' },
            content: { type: 'string', description: '覆盖后的完整正文内容' },
          },
          required: ['note', 'content'],
        },
      },
      access: 'notes',
      execute: (args, ctx) => execEditNote(noteService, args, ctx),
    },
    {
      definition: {
        name: 'move_note',
        description:
          '重命名/移动笔记（相对 notesRoot 路径），目标路径同样经白名单校验。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '原笔记相对路径' },
            to: { type: 'string', description: '新笔记相对路径' },
          },
          required: ['from', 'to'],
        },
      },
      access: 'notes',
      execute: (args, ctx) => execMoveNote(noteService, args, ctx),
    },
    {
      definition: {
        name: 'update_frontmatter',
        description:
          '更新指定笔记 frontmatter 的单个键值（value 支持内联数组形式，如 [agent]）。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '相对 notesRoot 的笔记路径' },
            key: { type: 'string', description: 'frontmatter 键名' },
            value: { type: 'string', description: '键值（支持内联数组形式，如 [agent]）' },
          },
          required: ['note', 'key', 'value'],
        },
      },
      access: 'notes',
      execute: (args, ctx) => execUpdateFrontmatter(noteService, args, ctx),
    },
  ];
}
