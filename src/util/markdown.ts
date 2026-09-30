/**
 * 简易 Markdown 渲染器（纯模块，禁止 `import 'vscode'`，供 node:test 直接测试）。
 *
 * 支持子集：HTML 转义 + `\n\n` 分段 + 行内 `**b**` / `` `code` `` / `[t](url)`。
 * 输出为安全 HTML 片段（所有输入先转义），可直接注入 webview。
 * 不引入额外依赖；如需完整 Markdown（表格/列表/代码块），后续换用 marked 等并保留本模块签名。
 */

/** HTML 特殊字符转义（先转义再做行内解析，保证输出无未转义标签） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 行内三件套（在已转义文本上做单遍替换，避免嵌套二次解析）：
 * - `` `code` `` → <code>…</code>
 * - `**b**` → <strong>…</strong>
 * - `[t](url)` → <a href="url">…</a>（仅 http/https/mailto，其余按纯文本原样输出）
 */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(s: string): string {
  return s.replace(INLINE, (match, code, bold, linkText, linkUrl) => {
    if (code !== undefined) {
      return `<code>${code}</code>`;
    }
    if (bold !== undefined) {
      return `<strong>${bold}</strong>`;
    }
    // linkUrl 已转义（&quot; 等）；仅放行安全协议
    if (/^(https?:|mailto:)/i.test(linkUrl)) {
      return `<a href="${linkUrl}">${linkText}</a>`;
    }
    return match;
  });
}

/** 将简单 Markdown 渲染为安全 HTML 片段：转义 → \n\n 分段 → 行内三件套 */
export function renderSimpleMarkdown(md: string): string {
  const safe = escapeHtml(md);
  return safe
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const withBr = block.replace(/\n/g, '<br>');
      return `<p>${renderInline(withBr)}</p>`;
    })
    .join('\n');
}