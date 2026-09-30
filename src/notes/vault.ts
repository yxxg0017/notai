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
 *
 * 白名单（Global Constraint：任何写路径前必须可被 isInsideVault 命中的路径）——
 * 来源含 `..` / `.` 段（如 `/n/../x.pdf` 的 dirname `/n/..`）或异常分隔符时，镜像目录名
 * 会退化为 `..`/`.` 导致 `join(notesRoot, '..', 'x.md')` 逃逸；此时**降级为平铺**
 * （`notesRoot/<stem>.md`），不镜像、不逃逸（调用方传入的均为真实打开文档的 fsPath，
 * 此处为纵深防御）。
 */
export function notePathForSource(notesRoot: string, sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const stem = path.parse(sourcePath).name || '_note';
  const folder = path.basename(dir);
  // 退化目录名（.. / . / 含分隔符）→ 回退平铺，避免 join 逃逸
  if (folder === '..' || folder === '.' || folder.includes(path.sep)) {
    return path.join(notesRoot, `${stem}.md`);
  }
  return folder && folder !== '/'
    ? path.join(notesRoot, folder, `${stem}.md`)
    : path.join(notesRoot, `${stem}.md`);
}

/**
 * 路径白名单：target 经 `path.resolve` 段规范化（`.`/`..`）后检查是否位于 notesRoot 边界之内。
 * 拒绝 `..` 穿越与外部绝对路径；`path.resolve` **不解析符号链接**，故仅作段级边界检查，
 * 若目标为到达外部路径的符号链接需调用方自行规避（当前来源均为真实打开文档的 fsPath）。
 */
export function isInsideVault(notesRoot: string, target: string): boolean {
  const root = path.resolve(notesRoot);
  const abs = path.resolve(target);
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}