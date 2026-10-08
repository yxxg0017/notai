/**
 * 会话持久化存储（纯 fs 操作，无 VS Code 依赖）。
 *
 * 目录布局：
 *   <dir>/<id>.json      —— 每个会话一个文件（完整 Conversation JSON）
 *   <dir>/index.json     —— 索引：{ conversations: ConversationMeta[] }，按 updatedAt 降序
 *
 * 容错策略：
 *   - index.json 缺失/损坏/形状不对（conversations 非数组）时，save/remove/list()
 *     扫描 <dir>/*.json 逐个解析重建并回写
 *   - 单个会话文件损坏或形状不对 → get() 返回 undefined，不抛异常
 *   - save/remove 经实例级 Promise 队列串行化，避免并发读改写丢失索引条目
 *   - id 仅允许 [A-Za-z0-9_-] 且不为 "index"，防路径穿越与索引文件冲突
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Conversation, ConversationMeta } from './types';

const INDEX_NAME = 'index.json';
const TITLE_MAX_LEN = 30;
const DEFAULT_TITLE = '新对话';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 取首个非空行、去首尾空白、截 30 字符（不劈开代理对）；空输入返回 '新对话' */
export function deriveTitle(text: string): string {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t !== '') {
      if (t.length <= TITLE_MAX_LEN) {
        return t;
      }
      const cut = t.slice(0, TITLE_MAX_LEN);
      // 截断点落在高代理上 → 回退一位，避免把 emoji 等代理对劈成半个字符
      if (cut.charCodeAt(cut.length - 1) >= 0xd800 && cut.charCodeAt(cut.length - 1) <= 0xdbff) {
        return cut.slice(0, -1);
      }
      return cut;
    }
  }
  return DEFAULT_TITLE;
}

export class ConversationStore {
  /** 实例级变更队列：串行化 save/remove，避免并发读改写丢失索引条目 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    // 队列吞掉 rejection，避免一次失败阻塞后续变更；错误仍通过返回值抛给调用方
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** id 仅允许 [A-Za-z0-9_-]，且不能为 "index"（防路径穿越、防与索引文件冲突） */
  private isValidId(id: string): boolean {
    return typeof id === 'string' && ID_PATTERN.test(id) && id !== 'index';
  }

  private indexPath(): string {
    return path.join(this.dir, INDEX_NAME);
  }

  private convPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
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

  /** 读取会话；文件缺失、JSON 损坏或形状不对 → undefined，不抛 */
  async get(id: string): Promise<Conversation | undefined> {
    if (!this.isValidId(id)) {
      return undefined;
    }
    const raw = await fs.promises.readFile(this.convPath(id), 'utf8').catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Conversation;
      // 形状校验：必须是对象且 messages 为数组，否则按损坏处理
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
        return parsed;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 写 <id>.json 并更新 index.json（经队列串行化；索引缺失/损坏/形状不对时先全量重建再合并） */
  async save(conv: Conversation): Promise<void> {
    if (!conv || !this.isValidId(conv.id)) {
      throw new Error(`ConversationStore: invalid conversation id: ${conv?.id}`);
    }
    return this.enqueue(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(this.convPath(conv.id), JSON.stringify(conv, null, 2), 'utf8');
      const meta = this.metaOf(conv);
      const metas = await this.readIndexMetas();
      const next = metas.filter((m) => m.id !== meta.id);
      next.push(meta);
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      await this.writeIndex(next);
    });
  }

  /** 按 updatedAt 降序返回会话元数据；索引缺失/损坏/形状不对时扫描 <dir>/*.json 重建并回写 */
  async list(): Promise<ConversationMeta[]> {
    const raw = await fs.promises.readFile(this.indexPath(), 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      try {
        const index = JSON.parse(raw) as { conversations?: ConversationMeta[] };
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

  /** 删除 <id>.json 并从索引中移除（经队列串行化） */
  async remove(id: string): Promise<void> {
    if (!this.isValidId(id)) {
      throw new Error(`ConversationStore: invalid conversation id: ${id}`);
    }
    return this.enqueue(async () => {
      await fs.promises.rm(this.convPath(id), { force: true });
      const metas = await this.readIndexMetas();
      await this.writeIndex(metas.filter((m) => m.id !== id));
    });
  }

  /**
   * 读取索引元数据：JSON 合法且 conversations 为数组时返回之；
   * 缺失/损坏/形状不对（conversations 非数组）时扫描 <dir>/*.json 全量重建，与 list() 行为对齐
   */
  private async readIndexMetas(): Promise<ConversationMeta[]> {
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf8');
      const index = JSON.parse(raw) as { conversations?: ConversationMeta[] };
      if (Array.isArray(index.conversations)) {
        return index.conversations;
      }
    } catch {
      // 索引缺失/损坏 → 落入重建
    }
    return this.rebuildMetas();
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
      try {
        const conv = await this.get(name.slice(0, -'.json'.length));
        if (conv) {
          metas.push(this.metaOf(conv));
        }
      } catch {
        // 跳过异常文件
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }
}
