/**
 * PDF 阅读器纯函数工具（不 import `vscode`，供 node:test 直接测试）。
 */

/** 阅读位置在 Memento 中的键：`pdf.lastPage.<fileUri>` */
export function pageStateKey(fileUri: string): string {
  return `pdf.lastPage.${fileUri}`;
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
