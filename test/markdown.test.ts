import { test } from 'node:test';
import assert from 'node:assert';
import { renderSimpleMarkdown } from '../src/util/markdown';

test('renderSimpleMarkdown 转义 HTML 特殊字符', () => {
  assert.strictEqual(
    renderSimpleMarkdown('<script>alert(1)</script>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
});

test('renderSimpleMarkdown 双换行分段', () => {
  assert.strictEqual(renderSimpleMarkdown('a\n\nb'), '<p>a</p>\n<p>b</p>');
  assert.strictEqual(renderSimpleMarkdown('  \n\n  '), '');
});

test('renderSimpleMarkdown 行内三件套：加粗/行内代码/链接', () => {
  assert.strictEqual(renderSimpleMarkdown('**b**'), '<p><strong>b</strong></p>');
  assert.strictEqual(renderSimpleMarkdown('`code`'), '<p><code>code</code></p>');
  assert.strictEqual(renderSimpleMarkdown('[t](https://a.b)'), '<p><a href="https://a.b">t</a></p>');
});

test('renderSimpleMarkdown 不安全协议不生成链接', () => {
  assert.strictEqual(
    renderSimpleMarkdown('[x](javascript:alert(1))'),
    '<p>[x](javascript:alert(1))</p>',
  );
});

test('renderSimpleMarkdown 单换行转 <br>', () => {
  assert.strictEqual(renderSimpleMarkdown('a\nb'), '<p>a<br>b</p>');
});

test('renderSimpleMarkdown 代码块内的星号不再二次解析', () => {
  assert.strictEqual(renderSimpleMarkdown('`**x**`'), '<p><code>**x**</code></p>');
});