/**
 * 笔记库路径工具（vault 白名单）。
 * 注意：本模块禁止 import 'vscode'，供 node:test 在无 VS Code 环境下直接测试。
 */
import * as path from 'node:path';

/**
 * 来源文件 → 笔记路径：仅镜像来源「所在文件夹名」（路径最后一段）+ 同名 `.md`，
 * 即 `notesRoot/<来源文件夹名>/<来源名>.md`（spec §7.1 示例：`Notes/后端agent开发资料/2-Agent八股2️⃣.md`）。
 * 无所在文件夹（dirname 为根，如根级文件 `/2.pdf`）时平铺于 notesRoot 根，即 `notesRoot/<来源名>.md`。
 * `stem` 为空（如 `.pdf` 这类无主名文件）时回退为 `_note`。
 */
export function notePathForSource(notesRoot: string, sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const stem = path.parse(sourcePath).name || '_note';
  const folder = path.basename(dir);
  return folder && folder !== '/'
    ? path.join(notesRoot, folder, `${stem}.md`)
    : path.join(notesRoot, `${stem}.md`);
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