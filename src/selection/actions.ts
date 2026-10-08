/**
 * 划词动作编排：翻译 / 解释 / 复制 + 加笔记 / 加单词本 + 错误卡与重试。
 *
 * 本文件允许 `import 'vscode'`（错误码用原生提示走 VS Code UI）；纯逻辑
 * （选区校验、提示词、Markdown 渲染）分别下沉到 ./prompts 与 ../util/markdown。
 */
import * as vscode from 'vscode';
import { LLMError } from '../core/llm/types';
import type { LLMProvider } from '../core/llm/types';
import type { AppConfig } from '../config';
import { requireSelection, buildTranslatePrompt, buildExplainPrompt } from './prompts';
import { renderSimpleMarkdown } from '../util/markdown';
import { NoteService } from '../notes/noteService';
import type { SourceInfo } from '../notes/noteService';
import { WordBook } from '../notes/wordbook';

/** 结果来源（当前为 PDF 选区；编辑器场景不设置） */
export interface SelectionSource {
  uri: string;
  page: number;
}

/** onShowResult 渲染回调负载（由扩展宿主注入：编辑器开结果面板，PDF postMessage 到 viewer popover） */
export interface ShowResultPayload {
  kind: 'translate' | 'explain';
  /** 源文本（重试时重新使用） */
  text: string;
  /** renderSimpleMarkdown 输出（流式时是当前累积全文；错误卡时为错误文案） */
  markdown: string;
  /** 原始 LLM 输出（未渲染 markdown；「加笔记/加单词本」当次结果上下文，0.3 修复） */
  content?: string;
  source?: SelectionSource;
  page?: number;
  /** 重新执行本动作（错误卡「重试」按钮/提示使用；无参调用，重新流式渲染） */
  retry: () => void;
  /** 错误卡：原始错误信息（供原生提示）；缺省表示正常流式内容 */
  error?: string;
}

export interface SelectionActionsDeps {
  provider: LLMProvider;
  config: AppConfig;
  /** 当前 PDF 选区（无则返回 undefined） */
  getPdfSelection: () => { uri: string; page: number; text: string } | undefined;
  onShowResult: (payload: ShowResultPayload) => void;
  /** 笔记服务（一文档一笔记续写；Task 6 接线） */
  noteService: NoteService;
  /** 全局唯一单词本（Task 6 接线） */
  wordBook: WordBook;
}

/** rateLimit 自动重试的退避时长（毫秒） */
const RATE_LIMIT_BACKOFF_MS = 1000;
/** 自动重试次数上限（rateLimit 只自动重试一次） */
const RATE_LIMIT_MAX_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const KIND_LABEL: Record<'translate' | 'explain', string> = {
  translate: '翻译',
  explain: '解释',
};

export class SelectionActions {
  constructor(private readonly deps: SelectionActionsDeps) {}

  /** 翻译选中文本：流式结果经 onShowResult 逐段上屏，返回全文 */
  translate(text: string): Promise<string> {
    return this.run('translate', text);
  }

  /** 解释选中文本：流式结果经 onShowResult 逐段上屏，返回全文 */
  explain(text: string): Promise<string> {
    return this.run('explain', text);
  }

  /** 复制选中文本到剪贴板 */
  async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }

  /**
   * 加笔记：确认标题（预填来源名，取消则中止）→ 一文档一笔记续写（`## 手动笔记` 块，
   * 有本次翻译结果时正文 = 原文 + 译文全文）→ `ViewColumn.Beside` 分屏打开
   * → 光标置于文件末尾续写区 → 提示。
   *
   * @param content 本次动作的原始 LLM 输出（翻译结果；缺省回退仅原文）
   * @returns true = 已打开笔记；false = 用户取消标题输入
   */
  async addNote(text: string, source: SourceInfo, content?: string): Promise<boolean> {
    const title = await vscode.window.showInputBox({
      prompt: '笔记标题',
      value: source.displayName,
    });
    if (title === undefined) {
      return false; // 用户取消
    }
    const body = content ? `**原文**：${text}\n\n${content}` : text;
    const { noteService } = this.deps;
    const { notePath } = await noteService.openOrCreate(source, {
      // 输入框编辑值生效：写入 frontmatter title（空串/纯空白回退来源名；文件名仍由来源派生）
      titleOverride: title,
      headings: [{ heading: '手动笔记', body }],
    });
    const doc = await vscode.window.showTextDocument(vscode.Uri.file(notePath), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    // 光标置于文件末尾续写区（showTextDocument resolve 后再设置选区并滚动定位）
    const end = doc.document.positionAt(doc.document.getText().length);
    doc.selection = new vscode.Selection(end, end);
    doc.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
    void vscode.window.showInformationMessage('已打开笔记，可直接续写');
    return true;
  }

  /**
   * 加单词本：输入翻译（预填本次翻译结果的「译文」行，可编辑，取消则中止）
   * → 追加到全局唯一单词本（word = 文本首词，整段截断 50 字；source = 来源名；date = 今日）→ 提示。
   *
   * @param content 本次动作的原始 LLM 输出（提取「译文」行预填；0.3 修复：此前只能加单词没翻译）
   * @returns true = 已加入单词本；false = 用户取消翻译输入
   */
  async addToWordBook(text: string, source: SourceInfo, content?: string): Promise<boolean> {
    const translation = await vscode.window.showInputBox({
      prompt: '翻译',
      value: content ? extractTranslation(content) : '',
    });
    if (translation === undefined) {
      return false; // 用户取消
    }
    await this.deps.wordBook.addEntry({
      word: firstToken(text, 50),
      translation: translation.trim(),
      source: source.displayName,
      date: localDateString(),
    });
    void vscode.window.showInformationMessage('已加入单词本');
    return true;
  }

  private async run(
    kind: 'translate' | 'explain',
    text: string,
    retriesLeft = RATE_LIMIT_MAX_RETRIES,
  ): Promise<string> {
    const { provider, config, getPdfSelection, onShowResult } = this.deps;
    // 防御性校验：空选区直接抛「请先选中文本」（命令层已校验，此处兜底）
    const safe = requireSelection(text);
    const { system, user } =
      kind === 'translate' ? buildTranslatePrompt(safe) : buildExplainPrompt(safe);

    const src = getPdfSelection();
    const source: SelectionSource | undefined = src ? { uri: src.uri, page: src.page } : undefined;
    const retry = (): void => {
      // 错误已通过错误卡展示，重试失败不再向上抛（避免二次提示）
      void this.run(kind, safe).catch(() => {
        /* 静默：错误卡已展示 */
      });
    };
    const emit = (markdown: string, error?: string): void =>
      onShowResult({
        kind,
        text: safe,
        markdown,
        // 原始 LLM 输出随渲染一并上送（「加笔记/加单词本」上下文；流式时是当前累积）
        content: accumulated,
        source,
        page: source?.page,
        retry,
        ...(error !== undefined ? { error } : {}),
      });

    let accumulated = '';
    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        model: config.model,
        // 本动作不传 tools（纯文本任务）
        onDelta: (d) => {
          if (d.type !== 'text') {
            return; // reasoning/toolCall 不上屏（预备 future use）
          }
          accumulated += d.text;
          emit(renderSimpleMarkdown(accumulated));
        },
      });
      // 非流式兜底：个别 provider 可能不回调 onDelta
      if (accumulated.length === 0 && result.content.length > 0) {
        accumulated = result.content;
        emit(renderSimpleMarkdown(accumulated));
      }
      return accumulated;
    } catch (err) {
      // 用户中止：静默（保留已上屏内容）
      if (err instanceof Error && err.name === 'AbortError') {
        return accumulated;
      }
      if (err instanceof LLMError) {
        if (err.kind === 'noApiKey') {
          void this.promptForApiKey();
          emit(renderSimpleMarkdown(`**未配置 API Key**\n\n${err.message}`), err.message);
          return '';
        }
        if (err.kind === 'rateLimit' && retriesLeft > 0) {
          await sleep(RATE_LIMIT_BACKOFF_MS);
          return this.run(kind, safe, retriesLeft - 1);
        }
        emit(
          renderSimpleMarkdown(`**${KIND_LABEL[kind]}请求失败**\n\n${err.message}`),
          err.message,
        );
        return '';
      }
      const message = err instanceof Error ? err.message : String(err);
      emit(renderSimpleMarkdown(`**${KIND_LABEL[kind]}出错了**\n\n${message}`), message);
      return '';
    }
  }

  /** 无 API Key：原生提示并引导运行 aiStudy.setApiKey */
  private async promptForApiKey(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      '未配置 DeepSeek API Key，请先设置。',
      '去设置',
    );
    if (pick === '去设置') {
      void vscode.commands.executeCommand('aiStudy.setApiKey');
    }
  }
}

/** 文本首词（空白分隔第一段），超长截断到 max 字符（单词本词条用） */
function firstToken(text: string, max: number): string {
  return (text.trim().split(/\s+/)[0] ?? '').slice(0, max);
}

/**
 * 从翻译结果原文提取「译文：…」行内容（加单词本预填用）。
 * 兼容 `**译文：** xxx`（markdown 源）与 `译文：xxx` 两种形态；提取失败回退整段。
 */
function extractTranslation(raw: string): string {
  const m = String(raw ?? '').match(/译文\s*[：:]\s*([^\n*]+)/);
  return m ? m[1].trim() : String(raw ?? '').trim();
}

/** 今日本地日期字符串（YYYY-MM-DD；用本地时区而非 toISOString 的 UTC） */
function localDateString(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}