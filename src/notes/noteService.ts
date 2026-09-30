/**
 * 一文档一笔记、续写式笔记服务（纯逻辑，可注入任意 notesRoot 进行测试）。
 * 注意：本模块禁止 import 'vscode'；vscode.Uri 的打开与分屏由调用方（Task 6）负责。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter';
import { notePathForSource } from './vault';

export interface SourceInfo {
  displayName: string;
  sourcePath: string;
  sourceType: 'pdf' | 'editor' | 'none';
  page?: number;
  quote?: string;
}

export interface NoteHeading {
  heading: string;
  body: string;
}

/** 引用块标题行（spec §7.2）：`> 📎 原文引用（第 N 页）` */
export const NOTE_QUOTE_LINE = (page?: number): string =>
  `> 📎 原文引用${page !== undefined ? `（第 ${page} 页）` : ''}`;

/** 回链行（spec §7.2）：`[返回来源](vscode://file/...#page=N)` */
export const NOTE_BACKLINK = (sourceLink: string): string => `[返回来源](${sourceLink})`;

export class NoteService {
  constructor(private readonly notesRoot: string) {}

  /** 来源文件对应的笔记路径（镜像目录 + 同名 .md） */
  notePathFor(source: SourceInfo): string {
    return notePathForSource(this.notesRoot, source.sourcePath);
  }

  /**
   * 幂等续写入口：笔记已存在 → `created:false` 并追加；不存在 → 先创建
   * （frontmatter 预填 title/source/sourceType/sourceLink/tags/created/updated，
   * quote 非空时作为首段引用块 + 回链行），再追加 headings。
   */
  async openOrCreate(
    source: SourceInfo,
    opts: { headings?: NoteHeading[]; titleOverride?: string } = {}
  ): Promise<{ notePath: string; created: boolean }> {
    const notePath = this.notePathFor(source);
    const headings = opts.headings ?? [];
    if (fs.existsSync(notePath)) {
      if (headings.length > 0) {
        await this.appendTo(notePath, headings);
      }
      return { notePath, created: false };
    }
    await fs.promises.mkdir(path.dirname(notePath), { recursive: true });
    const now = new Date().toISOString();
    const sourceLink = this.sourceLinkFor(source);
    const frontmatter: Record<string, unknown> = {
      // 标题输入值生效（controller 裁定 spec §7.2「输入标题 → 创建文件」）：
      // titleOverride 非空写入 title，空字符串回退来源名；文件名仍由来源派生（一文档一笔记）
      title: opts?.titleOverride?.trim() || this.titleFor(source),
      source: source.displayName,
      sourceType: source.sourceType,
      sourceLink,
      tags: [],
      created: now,
      updated: now,
    };
    let content = stringifyFrontmatter(frontmatter) + '\n';
    if (source.quote) {
      content += `\n${this.quoteBlock(source)}\n`;
    }
    await fs.promises.writeFile(notePath, content, 'utf8');
    if (headings.length > 0) {
      await this.appendTo(notePath, headings);
    }
    return { notePath, created: true };
  }

  /** 追加每个 heading 的 `## 标题 + 正文` 块，并回写更新的 `updated` 时间戳 */
  async appendTo(notePath: string, headings: NoteHeading[]): Promise<void> {
    const block = headings.map((h) => `\n\n## ${h.heading}\n\n${h.body}\n`).join('');
    const text = await fs.promises.readFile(notePath, 'utf8');
    const { data, body } = parseFrontmatter(text);
    if (Object.keys(data).length === 0) {
      // 无 frontmatter 的旧文件：不重写头，仅追加
      await fs.promises.appendFile(notePath, block, 'utf8');
      return;
    }
    data.updated = new Date().toISOString();
    await fs.promises.writeFile(notePath, `${stringifyFrontmatter(data)}\n${body}${block}`, 'utf8');
  }

  private sourceLinkFor(source: SourceInfo): string {
    const base = `vscode://file${source.sourcePath}`;
    if (source.sourceType === 'pdf' && source.page !== undefined) {
      return `${base}#page=${source.page}`;
    }
    return base;
  }

  private titleFor(source: SourceInfo): string {
    return path.parse(source.displayName).name || source.displayName;
  }

  /** 首段引用块（spec §7.2）：引用行 + 逐行 `>` + 回链行 */
  private quoteBlock(source: SourceInfo): string {
    const lines = [NOTE_QUOTE_LINE(source.page)];
    for (const line of String(source.quote ?? '').split('\n')) {
      lines.push(`> ${line}`);
    }
    lines.push('', NOTE_BACKLINK(this.sourceLinkFor(source)));
    return lines.join('\n');
  }
}