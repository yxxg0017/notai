/**
 * 极简 YAML 子集序列化（手写，不引入 yaml 依赖）。
 * 支持：`key: value`、`[a, b]` 内联数组、字符串（可带引号）、数字、布尔。
 * 注意：本模块禁止 import 'vscode'，供 node:test 在无 VS Code 环境下直接测试。
 */

/**
 * 解析 frontmatter 块（首行 `---` 起、到下一个 `---` 行止）。
 * 无 frontmatter 时返回 `{ data: {}, body: text }`。
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: text };
  }
  const data: Record<string, unknown> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    if (!key) {
      continue;
    }
    data[key] = parseScalar(line.slice(idx + 1).trim());
  }
  const body = lines.slice(end + 1).join('\n');
  return { data, body };
}

/**
 * 序列化为完整 frontmatter 块（含首尾 `---` 定界行）。
 * 支持 string、string[]、number、boolean；数组以 `[a, b]` 内联。
 */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join('\n')}\n---`;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '') {
    return '';
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return inner.split(',').map((part) => parseScalar(part.trim()));
  }
  if (s === 'true') {
    return true;
  }
  if (s === 'false') {
    return false;
  }
  if (s === 'null' || s === '~') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return unquote(s);
  }
  return s;
}

function unquote(s: string): string {
  if (s.startsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s.slice(1, -1).replace(/''/g, "'");
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map((x) => formatScalar(x)).join(', ')}]`;
  }
  return formatScalar(v);
}

function formatScalar(v: unknown): string {
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    return String(v);
  }
  if (v === null || v === undefined) {
    return '""';
  }
  const s = String(v);
  if (needsQuote(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** 需要加引号才能保证往返一致的值（会被误解析为布尔/数字、或含 YAML 特殊结构） */
function needsQuote(s: string): boolean {
  if (s === '') {
    return true;
  }
  if (/^(true|false|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    return true;
  }
  if (s.startsWith('"') || s.startsWith("'") || s.endsWith('"') || s.endsWith("'")) {
    return true;
  }
  if (s !== s.trim() || s.includes(': ') || s.includes(' #') || /[[\]{},]/.test(s)) {
    return true;
  }
  return false;
}