/**
 * 笔记库路径工具（vault 白名单）。
 * 注意：本模块禁止 import 'vscode'，供 node:test 在无 VS Code 环境下直接测试。
 */
import * as path from 'node:path';

/**
 * 来源文件 → 笔记路径：镜像来源目录 + 同名 `.md`。
 * 目录镜像规则（测试锁定）：来源目录去掉「根 + 第一个目录段」后平铺于 notesRoot 下，
 * 即首个目录段视为来源根标签、不参与镜像；无目录（根级文件）时平铺于 notesRoot 根。
 * `stem` 为空（如 `.pdf` 这类无主名文件）时回退为 `_note`。
 */
export function notePathForSource(notesRoot: string, sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const stem = path.parse(sourcePath).name || '_note';
  const parts = dir.split(path.sep).filter((p) => p.length > 0);
  const rel = parts.slice(1).join(path.sep);
  return path.join(notesRoot, rel, `${stem}.md`);
}

/**
 * 路径白名单：target 经 `path.resolve` 规范化后必须位于 notesRoot 之内。
 * 拒绝 `..` 穿越与外部绝对路径（符号链接解析后逃逸由 resolve 语义结构化覆盖）。
 */
export function isInsideVault(notesRoot: string, target: string): boolean {
  const root = path.resolve(notesRoot);
  const abs = path.resolve(target);
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}