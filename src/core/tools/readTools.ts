/**
 * 只读工具集（read_file / search_local / read_pdf_page / list_notes）。
 *
 * 安全约束：read_file 的 path 必须落在工作区根内 —— resolveWithin 段级校验 +
 * fs.realpath 二次校验（防符号链接逃逸）。工具内部错误统一抛 ToolError，
 * 由执行层捕获回填为 tool 消息，不中断 LLM 循环。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalHit, ToolContext, ToolError, ToolHandler } from './context';

// re-export：外部（含测试）统一从 readTools 引入 ToolError
export { ToolError };

const DEFAULT_READ_MAX_BYTES = 16384;
const DEFAULT_HIT_LIMIT = 5;

/**
 * 路径白名单（纯函数）：p 相对 root 解析，规范化后必须等于 root
 * 或以 `root + path.sep` 开头；`..` 逃逸与外部绝对路径返回 undefined。
 */
export function resolveWithin(root: string, p: string): string | undefined {
  if (!root || !p) {
    return undefined;
  }
  const absRoot = path.resolve(root);
  const abs = path.resolve(root, p);
  if (abs === absRoot || abs.startsWith(absRoot + path.sep)) {
    return abs;
  }
  return undefined;
}

/** 搜索命中 → `路径:行号: 文本` 逐行，最多 limit（默认 5）条 */
export function localHitToString(hits: LocalHit[], limit = 5): string {
  const lines = hits.slice(0, limit).map((h) => `${h.path}:${h.line}: ${h.text}`);
  return lines.join('\n');
}

function asStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function asNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

/** 数值参数钳制：非有限数值或 <=0 回落 fallback（避免 0/负数导致空读取或异常切片） */
function positiveInt(v: number | undefined, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN;
  return n >= 1 ? n : fallback;
}

/** 将 ctx 回调异常包装为 ToolError（保留原错误信息），避免原生 Error 直接冒泡中断循环 */
function wrapErr(prefix: string, err: unknown): ToolError {
  return new ToolError(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

/** read_file：resolveWithin 校验 → realpath 二次校验（防符号链接逃逸）→ 读文件 → 超限按字节截断 */
async function execReadFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rel = asStr(args, 'path');
  if (!rel) {
    throw new ToolError('read_file 缺少 path 参数');
  }
  const root = ctx.cwd ?? ctx.notesRoot;
  const absRoot = path.resolve(root);
  const abs = resolveWithin(root, rel);
  if (!abs) {
    throw new ToolError(`路径越界: ${rel}`);
  }
  // 真实路径二次校验（防符号链接逃逸）：root 与目标都经 realpath 解析后再比较边界
  // （处理 macOS /var → /private/var 这类 tmpdir 符号链接场景）。
  // realpath 失败需区分：ENOENT = 目标不存在（非逃逸）→ 置空，交由下方 readFile
  // 统一报「文件不存在或不可读」；其他错误（如 ELOOP）才按符号链接逃逸处理。
  const realRoot = await fs.promises.realpath(absRoot).catch(() => absRoot);
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
  if (real !== undefined && !(real === realRoot || real.startsWith(realRoot + path.sep))) {
    throw new ToolError(`路径越界（符号链接逃逸）: ${rel}`);
  }
  const buf = await fs.promises.readFile(real ?? abs).catch(() => {
    throw new ToolError(`文件不存在或不可读: ${rel}`);
  });
  // maxBytes 钳制为正整数：非有限数值或 <=0 回落默认 16384（避免 0/负数导致空读取）
  const maxBytes = positiveInt(asNum(args, 'maxBytes'), DEFAULT_READ_MAX_BYTES);
  if (buf.length > maxBytes) {
    const head = buf.subarray(0, maxBytes).toString('utf8');
    return `${head}\n[已截断，共 ${buf.length} 字节]`;
  }
  return buf.toString('utf8');
}

/** search_local：调注入的本地全文搜索，无命中返回占位文案 */
async function execSearchLocal(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = asStr(args, 'query');
  if (!query) {
    throw new ToolError('search_local 缺少 query 参数');
  }
  // limit 钳制为正整数：非有限数值或 <=0 回落默认 5（避免 0/负数导致异常切片）
  const limit = positiveInt(asNum(args, 'limit'), DEFAULT_HIT_LIMIT);
  const hits = await ctx.searchLocal(query, limit).catch((err: unknown) => {
    throw wrapErr('search_local 失败', err);
  });
  if (!hits || hits.length === 0) {
    return '（无匹配）';
  }
  return localHitToString(hits, limit);
}

/** read_pdf_page：读当前打开 PDF 的指定页文本，无可用 PDF/内容时返回占位文案 */
async function execReadPdfPage(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!ctx.readPdfPage) {
    return '（当前无打开或可读的 PDF 页）';
  }
  const page = asNum(args, 'page');
  const text = await ctx.readPdfPage(page).catch((err: unknown) => {
    throw wrapErr('read_pdf_page 失败', err);
  });
  if (!text) {
    return '（当前无打开或可读的 PDF 页）';
  }
  return text;
}

/** list_notes：笔记库清单，`标题 (路径)` 逐行，无笔记返回占位文案 */
async function execListNotes(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const notes = await ctx.listNotes().catch((err: unknown) => {
    throw wrapErr('list_notes 失败', err);
  });
  if (!notes || notes.length === 0) {
    return '（暂无笔记）';
  }
  return notes.map((n) => `${n.title} (${n.path})`).join('\n');
}

/** 只读工具集：read_file / search_local / read_pdf_page / list_notes */
export function readTools(): ToolHandler[] {
  return [
    {
      definition: {
        name: 'read_file',
        description:
          '读取工作区内指定文件的内容。path 为相对工作区根的路径；默认最大读取 16384 字节，超限截断并标注总字节数。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区根的路径' },
            maxBytes: { type: 'number', description: '最大读取字节数，默认 16384' },
          },
          required: ['path'],
        },
      },
      access: 'read',
      execute: execReadFile,
    },
    {
      definition: {
        name: 'search_local',
        description: '在本地全文搜索并返回命中片段（路径:行号: 文本），无匹配返回占位文案。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            limit: { type: 'number', description: '返回命中条数上限，默认 5' },
          },
          required: ['query'],
        },
      },
      access: 'read',
      execute: execSearchLocal,
    },
    {
      definition: {
        name: 'read_pdf_page',
        description: '读取当前打开 PDF 的指定页文本；不传 page 时读当前页。无打开 PDF 时返回占位文案。',
        parameters: {
          type: 'object',
          properties: {
            page: { type: 'number', description: 'PDF 页码（不传时读当前页）' },
          },
        },
      },
      access: 'read',
      execute: execReadPdfPage,
    },
    {
      definition: {
        name: 'list_notes',
        description: '列出笔记库中的全部笔记，返回 `标题 (路径)` 逐行清单。',
        parameters: { type: 'object', properties: {} },
      },
      access: 'read',
      execute: execListNotes,
    },
  ];
}
