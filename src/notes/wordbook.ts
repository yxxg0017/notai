/**
 * 全局唯一单词本（<notesRoot>/单词本.md）：追加式写入，可解析回 WordEntry[]。
 * 注意：本模块禁止 import 'vscode'，供 node:test 在无 VS Code 环境下直接测试。
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { isInsideVault } from './vault';

export interface WordEntry {
  word: string;
  translation: string;
  source: string;
  sentence?: string;
  tags?: string[];
  date: string;
}

export class WordBook {
  constructor(private readonly notesRoot: string) {}

  /** 单词本文件路径：<notesRoot>/单词本.md */
  path(): string {
    return join(this.notesRoot, '单词本.md');
  }

  /** 追加一条词条；文件不存在时先创建 `# 单词本` 头。空字段省略。 */
  async addEntry(e: WordEntry): Promise<void> {
    const p = this.path();
    // 第二道白名单防线：写入前校验（Global Constraint）
    if (!isInsideVault(this.notesRoot, p)) {
      throw new Error(`单词本路径逃逸笔记库: ${p}`);
    }
    if (!fs.existsSync(p)) {
      await fs.promises.mkdir(this.notesRoot, { recursive: true });
      await fs.promises.writeFile(p, '# 单词本\n', 'utf8');
    }
    const lines = [`## ${e.word}`, `- 翻译：${e.translation}`, `- 来源：${e.source}`];
    if (e.sentence) {
      lines.push(`- 例句：${e.sentence}`);
    }
    if (e.tags && e.tags.length > 0) {
      lines.push(`- 标签：${e.tags.join('、')}`);
    }
    lines.push(`- 日期：${e.date}`, '');
    await fs.promises.appendFile(p, `\n${lines.join('\n')}`, 'utf8');
  }

  /** 解析 `## 词` + `- 键：值` 行，还原为 WordEntry[]（缺失字段以空串/空数组兜底） */
  parseAll(text: string): WordEntry[] {
    const entries: WordEntry[] = [];
    let cur: Partial<WordEntry> | null = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      const h = line.match(/^##\s+(.+)$/);
      if (h) {
        if (cur) {
          entries.push(toEntry(cur));
        }
        cur = { word: h[1].trim() };
        continue;
      }
      if (!cur) {
        continue;
      }
      const kv = line.match(/^-\s*([^：]+)：(.*)$/);
      if (!kv) {
        continue;
      }
      const key = kv[1].trim();
      const val = kv[2].trim();
      switch (key) {
        case '翻译':
          cur.translation = val;
          break;
        case '来源':
          cur.source = val;
          break;
        case '例句':
          cur.sentence = val;
          break;
        case '标签':
          cur.tags = val.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
          break;
        case '日期':
          cur.date = val;
          break;
      }
    }
    if (cur) {
      entries.push(toEntry(cur));
    }
    return entries;
  }
}

function toEntry(cur: Partial<WordEntry>): WordEntry {
  return {
    word: cur.word ?? '',
    translation: cur.translation ?? '',
    source: cur.source ?? '',
    ...(cur.sentence !== undefined ? { sentence: cur.sentence } : {}),
    ...(cur.tags !== undefined ? { tags: cur.tags } : {}),
    date: cur.date ?? '',
  };
}