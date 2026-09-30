import { test } from 'node:test';
import assert from 'node:assert';
import { expandHome, DEFAULT_NOTES_ROOT } from '../src/util/paths';

test('expandHome 展开 ~ 为 home 目录', () => {
  assert.strictEqual(expandHome('~/x'), `${process.env.HOME}/x`);
  assert.strictEqual(expandHome('/abs/x'), '/abs/x');
});
test('默认笔记库为 ~/Documents/StudyNotes', () => {
  assert.strictEqual(DEFAULT_NOTES_ROOT, '~/Documents/StudyNotes');
});
