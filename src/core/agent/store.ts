/**
 * 会话持久化存储（纯 fs 操作，无 VS Code 依赖）。
 *
 * 目录布局：
 *   <dir>/<id>.json      —— 每个会话一个文件（完整 Conversation JSON）
 *   <dir>/index.json     —— 索引：{ conversations: ConversationMeta[] }，按 updatedAt 降序
 *
 * 容错策略：
 *   - index.json 缺失/损坏时，list() 扫描 <dir>/*.json 逐个解析重建并回写索引
 *   - 单个会话文件损坏 → get() 返回 undefined，不抛异常
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Conversation, ConversationMeta } from './types';

const INDEX_NAME = 'index.json';
const TITLE_MAX_LEN = 30;
const DEFAULT_TITLE = '新对话';

/** 取首个非空行、去首尾空白、截 30 字符；空输入返回 '新对话' */
export function deriveTitle(text: string): string {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t !== '') {
      return t.length > TITLE_MAX_LEN ? t.slice(0, TITLE_MAX_LEN) : t;
    }
  }
  return DEFAULT_TITLE;
}

export class ConversationStore {
  constructor(private readonly dir: string) {}

  private convPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private indexPath(): string {
    return path.join(this.dir, INDEX_NAME);
  }

  private metaOf(conv: Conversation): ConversationMeta {
    return {
      id: conv.id,
      title: conv.title,
      mode: conv.mode,
      updatedAt: conv.updatedAt,
      messageCount: conv.messages.length,
    };
  }

  private async writeIndex(metas: ConversationMeta[]): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(
      this.indexPath(),
      JSON.stringify({ conversations: metas }, null, 2),
      'utf8'
    );
  }

  /** 读取会话；文件缺失或 JSON 损坏 → undefined，不抛 */
  async get(id: string): Promise<Conversation | undefined> {
    const raw = await fs.promises.readFile(this.convPath(id), 'utf8').catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as Conversation;
    } catch {
      return undefined;
    }
  }

  /** 写 <id>.json 并更新 index.json（索引缺失/损坏时先全量重建再合并） */
  async save(conv: Conversation): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.convPath(conv.id), JSON.stringify(conv, null, 2), 'utf8');
    const meta = this.metaOf(conv);
    let metas: ConversationMeta[];
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf8');
      const index = JSON.parse(raw) as { conversations?: ConversationMeta[] };
      metas = Array.isArray(index.conversations) ? index.conversations : [];
    } catch {
      metas = await this.rebuildMetas();
    }
    const next = metas.filter((m) => m.id !== meta.id);
    next.push(meta);
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.writeIndex(next);
  }

  /** 按 updatedAt 降序返回会话元数据；索引缺失/损坏时扫描 <dir>/*.json 重建并回写 */
  async list(): Promise<ConversationMeta[]> {
    const raw = await fs.promises.readFile(this.indexPath(), 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      try {
        const index = JSON.parse(raw ?? '') as { conversations?: ConversationMeta[] };
        if (Array.isArray(index.conversations)) {
          return index.conversations;
        }
      } catch {
        // 索引损坏 → 落入重建
      }
    }
    const metas = await this.rebuildMetas();
    await this.writeIndex(metas);
    return metas;
  }

  /** 删除 <id>.json 并从索引中移除 */
  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.convPath(id), { force: true });
    const raw = await fs.promises.readFile(this.indexPath(), 'utf8').catch(() => undefined);
    let metas: ConversationMeta[];
    try {
      const index = JSON.parse(raw ?? '') as { conversations?: ConversationMeta[] };
      metas = Array.isArray(index.conversations) ? index.conversations : [];
    } catch {
      metas = await this.rebuildMetas();
    }
    await this.writeIndex(metas.filter((m) => m.id !== id));
  }

  /** 扫描 <dir>/*.json（跳过 index.json），逐个解析生成元数据，按 updatedAt 降序 */
  private async rebuildMetas(): Promise<ConversationMeta[]> {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const metas: ConversationMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === INDEX_NAME) {
        continue;
      }
      const conv = await this.get(name.slice(0, -'.json'.length));
      if (conv) {
        metas.push(this.metaOf(conv));
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }
}
