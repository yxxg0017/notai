/**
 * PDF 阅读器纯函数工具（不 import `vscode`，供 node:test 直接测试）。
 */

/**
 * 阅读位置在 Memento 中的键：`pdf.lastPage.<fileUri>`。
 * 注意：调用方须传入**去掉 fragment 后的文件 URI**（见 pdfEditor 的
 * `uri.with({ fragment: '' })`），保证回链 `#page=N` 与正常打开共用同一键。
 */
export function pageStateKey(fileUri: string): string {
  return `pdf.lastPage.${fileUri}`;
}

/**
 * 从 URI fragment（不含 `#`，如 `page=12`）解析回链页码。
 * 匹配 `page=<数字>` 返回数字；无匹配（空 fragment / 非数字 / 缺 page 键）返回 undefined。
 */
export function pageFromFragment(fragment: string): number | undefined {
  const m = /page=(\d+)/.exec(fragment);
  return m ? Number(m[1]) : undefined;
}

/** 将页码夹取到 1..total（含边界；非法输入回退到 1） */
export function clampPage(page: number, total: number): number {
  const t = Math.max(1, Math.floor(total));
  const p = Math.floor(page);
  if (!Number.isFinite(p)) {
    return 1;
  }
  return Math.min(Math.max(1, p), t);
}

/** 根据页面文本内容判断是否为可划词的有文字层页面（trim 后为空 → 扫描页） */
export function classifyPageText(text: string): 'hasText' | 'scanned' {
  return text.trim() === '' ? 'scanned' : 'hasText';
}
