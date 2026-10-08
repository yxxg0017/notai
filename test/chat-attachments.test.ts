import { test } from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { formatAttachments, MAX_ATTACHMENT_BYTES } from '../src/ui/attachment';
import type { UiAttachment } from '../src/ui/protocol';

test('formatAttachments 图片降级为引用占位，不投喂内容', () => {
  const { text } = formatAttachments([
    { kind: 'image', name: '截图.png', content: 'R0lGODlh-binary-ish' },
  ]);
  assert.ok(text.includes('截图.png'), '应包含附件名');
  assert.ok(text.includes('图片附件'), '应说明已降级');
  assert.ok(!text.includes('R0lGODlh'), '不应投喂图片内容');
});

test('formatAttachments 文本附件截断到 8KB 且不劈开多字节字符', () => {
  const ascii = { kind: 'file' as const, name: 'a.txt', content: 'a'.repeat(20000) };
  const asciiOut = formatAttachments([ascii]).text;
  assert.ok(asciiOut.includes('[附件：a.txt]'), '应包含附件名标头');
  assert.ok(asciiOut.includes('已截断至 8KB'), '应包含截断提示');
  const body = asciiOut.split('\n')[1];
  assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_ATTACHMENT_BYTES, '正文不超过 8KB');

  // 截断点落在多字节字符中间：8192 字节处会劈开一个 3 字节汉字
  const cjk = { kind: 'text' as const, name: 'cjk.txt', content: '好'.repeat(5000) };
  const cjkOut = formatAttachments([cjk]).text;
  assert.ok(!cjkOut.includes('\uFFFD'), '不应出现 UTF-8 替换符');
  const cjkBody = cjkOut.split('\n')[1];
  assert.ok(Buffer.byteLength(cjkBody, 'utf8') <= MAX_ATTACHMENT_BYTES, '正文不超过 8KB');
});

test('formatAttachments 空输入忽略', () => {
  assert.strictEqual(formatAttachments(undefined).text, '');
  assert.strictEqual(formatAttachments([]).text, '');
  assert.strictEqual(formatAttachments([{ kind: 'text', name: '空.txt', content: '   ' }]).text, '');
});
