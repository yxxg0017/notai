#!/usr/bin/env node
// One-off PDF recovery: rebuild xref/trailer for truncated PDFs (like qpdf --recover).
// Usage: node pdf-recover.mjs <input.pdf> <output.pdf>
import { readFileSync, writeFileSync } from 'fs';

const [input, output] = process.argv.slice(2);
const buf = readFileSync(input);

// --- 1. Scan all "N G obj" object headers, build offset table.
//     NOTE: decode as latin1 so string indices == byte offsets (binary font data
//     breaks UTF-8 index alignment). Only match at line start to avoid stream content. ---
const text = buf.toString('latin1');
const objRe = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj/g;
const entries = []; // array of {num, gen, offset}
let m;
while ((m = objRe.exec(text)) !== null) {
  const at = m.index;
  const prev = at === 0 ? '' : text[at - 1];
  if (prev === '' || prev === '\n' || prev === '\r') {
    entries.push({ num: +m[1], gen: +m[2], offset: at });
  }
}
if (entries.length === 0) {
  console.error('no objects found');
  process.exit(1);
}
entries.sort((a, b) => a.num - b.num);
const maxNum = Math.max(...entries.map(e => e.num));
console.log(`objects: ${entries.length}, max num: ${maxNum}`);

// --- 2. Find catalog (should be object 1 / Type /Catalog) ---
const catalog = entries.find(e => {
  const end = text.indexOf('endobj', e.offset);
  const slice = text.slice(e.offset, end === -1 ? e.offset + 512 : end);
  return /\/Type\s*\/?Catalog/.test(slice);
});
if (!catalog) {
  console.error('catalog not found');
  process.exit(1);
}
console.log(`catalog: object ${catalog.num} ${catalog.gen} @ ${catalog.offset}`);

// --- 3. Build a new xref table (classic format) covering objects 0..maxNum ---
const byNum = new Map(entries.map(e => [e.num, e]));
const xrefChunks = ['xref', `0 ${maxNum + 1}`];
const p10 = n => String(n).padStart(10, '0');
let xref = 'xref\n' + `0 ${maxNum + 1}\n` + '0000000000 65535 f \n';
for (let n = 1; n <= maxNum; n++) {
  const e = byNum.get(n);
  if (e) xref += `${p10(e.offset)} 00000 n \n`;
  else xref += '0000000000 65535 f \n';
}

// --- 4. Assemble: original bytes + new xref + trailer ---
const trailer = `trailer\n<< /Size ${maxNum + 1} /Root ${catalog.num} ${catalog.gen} R >>\nstartxref\n${buf.length}\n%%EOF\n`;
const out = Buffer.concat([buf, Buffer.from(xref + trailer, 'latin1')]);
writeFileSync(output, out);
console.log(`written: ${output} (${out.length} bytes)`);