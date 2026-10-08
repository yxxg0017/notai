/**
 * 网页搜索 Provider 抽象（纯逻辑，无 VS Code 依赖）。
 *
 * 全局约束：本目录（src/core/search/）禁止 `import 'vscode'` —— 这些模块需要在
 * node:test 环境下直接运行（无 VS Code 运行时），只允许 node 内建模块与全局 fetch。
 */

/** 单条网页搜索结果：标题 / 链接 / 摘要 */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** 网页搜索厂商抽象：Tavily / 博查各自实现相同接口，可被 web_search 工具消费 */
export interface WebSearchProvider {
  id: string;
  displayName: string;
  search(query: string, signal?: AbortSignal): Promise<WebResult[]>;
}