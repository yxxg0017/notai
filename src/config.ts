import * as vscode from 'vscode';
import { DEFAULT_NOTES_ROOT, expandHome } from './util/paths';

export type WebSearchProvider = 'tavily' | 'bocha' | 'none';

export interface AppConfig {
  /** 笔记库根目录（`~` 已展开） */
  notesRoot: string;
  provider: string;
  baseUrl: string;
  model: string;
  models: string[];
  maxSteps: number;
  sidePanelWidth: number;
  enableWorkspaceWrite: boolean;
  explainTarget: 'popover' | 'conversation';
  /** Tavily/博查为计划 2 预留给值 */
  webSearchProvider: WebSearchProvider;
}

/** 同步读取 `aiStudy.*` 配置，默认值逐字取自设计中 `contributes.configuration` */
export function loadConfig(): AppConfig {
  const cfg = vscode.workspace.getConfiguration('aiStudy');
  const notesRoot = expandHome(cfg.get<string>('notesRoot', DEFAULT_NOTES_ROOT));
  return {
    notesRoot,
    provider: cfg.get<string>('provider', 'deepseek'),
    baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com/v1'),
    model: cfg.get<string>('model', 'deepseek-chat'),
    models: cfg.get<string[]>('models', ['deepseek-chat', 'deepseek-reasoner']),
    maxSteps: cfg.get<number>('maxSteps', 8),
    sidePanelWidth: cfg.get<number>('sidePanelWidth', 45),
    enableWorkspaceWrite: cfg.get<boolean>('enableWorkspaceWrite', true),
    explainTarget: cfg.get<'popover' | 'conversation'>('explainTarget', 'popover'),
    webSearchProvider: cfg.get<WebSearchProvider>('webSearch.provider', 'tavily'),
  };
}

/** API Key 存取封装：仅存 SecretStorage，绝不写入日志或配置导出 */
export class SecretStore {
  private static readonly KEY = 'aiStudy.apiKey';
  private static readonly WEB_KEY = 'aiStudy.webSearch.apiKey';

  constructor(private readonly storage: vscode.SecretStorage) {}

  async getApiKey(): Promise<string> {
    return (await this.storage.get(SecretStore.KEY)) ?? '';
  }

  async setApiKey(v: string): Promise<void> {
    await this.storage.store(SecretStore.KEY, v);
  }

  /** 网页搜索 API Key（Tavily/博查），与 getApiKey 同模式：缺省空串 */
  async getWebSearchKey(): Promise<string> {
    return (await this.storage.get(SecretStore.WEB_KEY)) ?? '';
  }
}
