/**
 * 工作区写工具集（edit_workspace_file：草稿 → 确认卡 → 应用）。
 *
 * 安全约束：path 必须落在工作区根内 —— resolveWithin 段级校验 + fs.realpath
 * 二次校验（防符号链接逃逸，含符号链接父目录写出）。工具内部错误统一抛
 * ToolError，由执行层捕获回填为 tool 消息，不中断 LLM 循环。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolContext, ToolError, ToolHandler } from './context';
import { resolveWithin } from './readTools';

function asStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 工作区路径写前二次校验：root 与目标都经 realpath 解析后比较边界（防符号链接
 * 逃逸）。目标不存在（新建，ENOENT）时校验最近已存在的祖先目录，防止
 * `link-out/new.txt` 这类符号链接父目录写出。
 * 返回用于读写文件系统的真实路径（目标不存在时返回原绝对路径）。
 */
async function ensureWithinWorkspace(absRoot: string, abs: string): Promise<string> {
  const realRoot = await fs.promises.realpath(absRoot).catch(() => absRoot);
  let real: string | undefined;
  try {
    real = await fs.promises.realpath(abs);
  } catch (err) {
    // ENOENT = 目标不存在（非逃逸）→ 交由祖先目录校验；其他错误（如 ELOOP）按逃逸处理
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new ToolError('路径不在工作区内');
    }
  }
  if (real !== undefined) {
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ToolError('路径不在工作区内');
    }
    return real;
  }
  // 目标不存在：向上找到最近已存在的祖先目录，校验其真实路径未逃逸
  let ancestor = path.dirname(abs);
  while (!fs.existsSync(ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) {
      break;
    }
    ancestor = next;
  }
  const realAncestor = await fs.promises.realpath(ancestor).catch(() => ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new ToolError('路径不在工作区内');
  }
  return abs;
}

/**
 * edit_workspace_file：路径校验 → 未启用检查 → 读当前内容 → 挂起确认 → 写入/拒绝。
 * 执行语义（与计划逐字一致）：
 * 1. ctx.cwd 未配置 → ToolError('未打开工作区')
 * 2. resolveWithin + realpath 二次校验失败 → ToolError('路径不在工作区内')
 * 3. ctx.confirmWorkspaceWrite 未提供 → ToolError('工作区写入未启用（aiStudy.enableWorkspaceWrite）')
 * 4. 读 currentContent（文件不存在 → 空串，视为新建）
 * 5. 挂起 await ctx.confirmWorkspaceWrite({ path, summary, currentContent, newContent: content })
 * 6. true → mkdir 父目录 + writeFile → `已写入 <path>（<summary>）`；
 *    false/undefined → `用户已拒绝写入 <path>`
 * 7. 挂起期间 abort/remove → confirmWorkspaceWrite reject（ToolError('已取消')）驱动抛出
 */
async function execEditWorkspaceFile(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const rel = asStr(args, 'path');
  const summary = asStr(args, 'summary');
  const contentRaw = args['content'];
  if (!rel) {
    throw new ToolError('edit_workspace_file 缺少 path 参数');
  }
  if (typeof contentRaw !== 'string') {
    throw new ToolError('edit_workspace_file 缺少 content 参数');
  }
  const content = contentRaw; // 文件内容原样写入，不 trim
  if (!ctx.cwd) {
    throw new ToolError('未打开工作区');
  }
  const absRoot = path.resolve(ctx.cwd);
  const abs = resolveWithin(ctx.cwd, rel);
  if (!abs) {
    throw new ToolError('路径不在工作区内');
  }
  const target = await ensureWithinWorkspace(absRoot, abs);
  if (!ctx.confirmWorkspaceWrite) {
    throw new ToolError('工作区写入未启用（aiStudy.enableWorkspaceWrite）');
  }
  // 读当前内容（不存在 → 空串，视为新建；文件系统真实路径由 ensureWithinWorkspace 决定）
  let currentContent = '';
  try {
    currentContent = await fs.promises.readFile(target, 'utf8');
  } catch (err) {
    // Task 10 minor ⑤：仅 ENOENT（目标不存在，新建）置空；其余读取错误（权限/目录等）
    // 如实上抛为 ToolError，避免「读不到却显示为空」的确认卡误导整文件覆盖
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new ToolError(`读取 ${rel} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const accepted = await ctx.confirmWorkspaceWrite({
    path: rel,
    summary,
    currentContent,
    newContent: content,
  });
  if (accepted === true) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content, 'utf8');
    return `已写入 ${rel}（${summary}）`;
  }
  return `用户已拒绝写入 ${rel}`;
}

/** 工作区写工具集：edit_workspace_file（始终走确认流：草稿 → 确认卡 → 应用） */
export function workspaceTools(): ToolHandler[] {
  return [
    {
      definition: {
        name: 'edit_workspace_file',
        description:
          '写入或覆盖工作区内文件（整文件覆盖）。path 为相对工作区根的路径；content 为完整新内容；summary 为本次修改摘要（确认卡展示）。落盘前需用户在确认卡点击「应用」。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区根的路径' },
            content: { type: 'string', description: '写入的完整新内容（整文件覆盖）' },
            summary: { type: 'string', description: '修改摘要（确认卡展示，如「修复拼写错误」）' },
          },
          required: ['path', 'content'],
        },
      },
      access: 'workspace',
      execute: execEditWorkspaceFile,
    },
  ];
}