import { test } from 'node:test';
import assert from 'node:assert';
import { clampPage, classifyPageText, pageStateKey, pageFromFragment } from '../src/pdf/helpers';

test('clampPage 夹取范围', () => {
  assert.strictEqual(clampPage(0, 10), 1);
  assert.strictEqual(clampPage(5, 10), 5);
  assert.strictEqual(clampPage(11, 10), 10);
});
test('classifyPageText 区分有文字层与扫描页', () => {
  assert.strictEqual(classifyPageText('  \n '), 'scanned');
  assert.strictEqual(classifyPageText('hello 世界'), 'hasText');
});
test('pageStateKey 以文件为键', () => {
  assert.strictEqual(pageStateKey('/a/b.pdf'), 'pdf.lastPage./a/b.pdf');
});
test('pageFromFragment 解析回链页码', () => {
  assert.strictEqual(pageFromFragment('page=12'), 12);
  assert.strictEqual(pageFromFragment(''), undefined);        // 无 fragment（正常打开）
  assert.strictEqual(pageFromFragment('page=abc'), undefined); // 非数字
  assert.strictEqual(pageFromFragment('foo=1&page=7'), 7);     // 键值对中匹配 page=
});
