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
  // 真实路径二次校验（防符号链接逃逸）：root 与文件路径都经 realpath 解析后
  // 再比较边界（处理 macOS /var → /private/var 这类 tmpdir 符号链接场景）
  const realRoot = await fs.promises.realpath(absRoot).catch(() => absRoot);
  const real = await fs.promises.realpath(abs).catch(() => undefined);
  if (!real || !(real === realRoot || real.startsWith(realRoot + path.sep))) {
    throw new ToolError(`路径越界（符号链接逃逸）: ${rel}`);
  }
  const buf = await fs.promises.readFile(real).catch(() => {
    throw new ToolError(`文件不存在或不可读: ${rel}`);
  });
  const maxBytes = asNum(args, 'maxBytes') ?? DEFAULT_READ_MAX_BYTES;
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
  const limit = asNum(args, 'limit');
  const hits = await ctx.searchLocal(query, limit);
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
  const text = await ctx.readPdfPage(page);
  if (!text) {
    return '（当前无打开或可读的 PDF 页）';
  }
  return text;
}

/** list_notes：笔记库清单，`标题 (路径)` 逐行，无笔记返回占位文案 */
async function execListNotes(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const notes = await ctx.listNotes();
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
