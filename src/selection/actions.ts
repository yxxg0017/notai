/**
 * 划词动作编排：翻译 / 解释 / 复制 + 错误卡与重试。
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