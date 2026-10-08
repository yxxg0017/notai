#!/usr/bin/env node
/**
 * 将 src/ui/media/ 的 Harness 静态资源（chat.html/css/js）复制到 out/ui/media/。
 * 幂等：重复运行会覆盖旧文件。
 *
 * 背景：.vscodeignore 排除 src/**（vsix 不含源码），但保留 out/** —— 故编译期把
 * 资源复制到 out/ui/media/ 才能随 vsix 打包；chatView.ts 的 HARNESS_MEDIA_DIR
 * 指向 out/ui/media（见 src/ui/chatView.ts）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src', 'ui', 'media');
const destDir = path.join(root, 'out', 'ui', 'media');

if (!fs.existsSync(srcDir)) {
  throw new Error(`copy-chat-assets: 源目录不存在: ${srcDir}（请先 npm install / 确认源码完整）`);
}
fs.mkdirSync(destDir, { recursive: true });
fs.cpSync(srcDir, destDir, { recursive: true });
console.log(`copy-chat-assets: ${path.relative(root, srcDir)} -> ${path.relative(root, destDir)}`);

console.log('copy-chat-assets: 完成');