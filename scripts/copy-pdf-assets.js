#!/usr/bin/env node
/**
 * 将 pdfjs-dist 的构建产物复制到 media/pdf/（vscode webview 可加载的位置）。
 * 幂等：重复运行会覆盖旧文件。media/pdf/ 中的 viewer.html/js/css 为源文件，本脚本不触碰。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'node_modules', 'pdfjs-dist');
const destDir = path.join(root, 'media', 'pdf');

const targets = [
  { from: path.join(srcDir, 'build', 'pdf.min.mjs'), to: path.join(destDir, 'pdf.min.mjs') },
  { from: path.join(srcDir, 'build', 'pdf.worker.min.mjs'), to: path.join(destDir, 'pdf.worker.min.mjs') },
  { from: path.join(srcDir, 'cmaps'), to: path.join(destDir, 'cmaps') },
];

for (const { from, to } of targets) {
  if (!fs.existsSync(from)) {
    throw new Error(`copy-pdf-assets: 源文件不存在: ${from}（请先 npm install）`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copy-pdf-assets: ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

console.log('copy-pdf-assets: 完成');
