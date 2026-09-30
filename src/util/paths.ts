/**
 * 纯路径工具模块。
 * 注意：本模块禁止 import 'vscode'，供 node:test 在无 VS Code 环境下直接测试。
 */
import * as os from 'node:os';

/** 默认笔记库根目录（含 `~` 前缀，使用前经 expandHome 展开） */
export const DEFAULT_NOTES_ROOT = '~/Documents/StudyNotes';

/** 将 `~` 前缀展开为当前用户主目录；其余路径原样返回 */
export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}
