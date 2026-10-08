/**
 * 用户消息附件组装（纯函数，供 node:test 直接测试；禁止 import 'vscode'）。
 *
 * 拼装规则（Task 7 简报）：
 * - 图片：当前模型为纯文本，无法识别图片内容 → 降级为「引用提示」占位
 * - 文本类（text/file/selection/pdfPage）：内容按字节截断到 8KB 后拼入
 * - 空/纯空白输入：整体忽略，返回空串
 */
import type { UiAttachment } from './protocol';

/** 单个文本附件的最大字节数（UTF-8） */
export const MAX_ATTACHMENT_BYTES = 8 * 1024;

/** 文本类附件 kind（image 单独降级处理） */
const TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'file', 'selection', 'pdfPage']);

/**
 * 按字节截断 UTF-8 文本：截断点落在多字节字符中间时去掉尾部替换符（U+FFFD），
 * 避免把劈开的半个字符拼进消息；截断发生时追加提示行。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return text;
  }
  let sliced = buf.subarray(0, maxBytes).toString('utf8');
  sliced = sliced.replace(/\uFFFD+$/, '');
  return `${sliced}\n[附件内容过长，已截断至 ${Math.floor(maxBytes / 1024)}KB]`;
}

/**
 * 组装附件文本块：多个附件以空行分隔；无有效附件时返回 `{ text: '' }`（调用方据此忽略）。
 * 图片不投喂内容，仅保留名称占位；文本类内容超 8KB 截断。
 */
export function formatAttachments(attachments?: UiAttachment[]): { text: string } {
  if (!attachments || attachments.length === 0) {
    return { text: '' };
  }
  const parts: string[] = [];
  for (const att of attachments) {
    if (!att) {
      continue;
    }
    if (att.kind === 'image') {
      parts.push(`[图片附件：${att.name || '图片'}（暂不支持识别图片内容，已降级为引用）]`);
      continue;
    }
    if (!TEXT_KINDS.has(att.kind)) {
      continue;
    }
    const content = (att.content ?? '').trim();
    if (!content) {
      continue;
    }
    parts.push(`[附件：${att.name || att.kind}]\n${truncateUtf8(content, MAX_ATTACHMENT_BYTES)}`);
  }
  return { text: parts.join('\n\n') };
}
