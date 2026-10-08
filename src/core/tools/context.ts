/**
 * Agent 工具框架类型定义（纯逻辑，无 VS Code 依赖）。
 *
 * 全局约束：本目录（src/core/tools/）禁止 `import 'vscode'` —— 这些模块需要在
 * node:test 环境下直接运行（无 VS Code 运行时），只允许 node 内建模块与全局 fetch。
 */
import { ToolDefinition } from '../llm/types';

/** 工具访问级别：read=只读上下文；notes=笔记库；workspace=工作区写（需确认） */
export type ToolAccess = 'read' | 'notes' | 'workspace';

/** 本地搜索单条命中 */
export interface LocalHit {
  path: string;
  line: number;
  text: string;
}

/** 工作区写提案（写类工具在真正落盘前需经 confirmWorkspaceWrite 确认） */
export interface WorkspaceProposal {
  path: string;
  summary: string;
  currentContent: string;
  newContent: string;
}

/** 工具执行上下文：由 VS Code 侧 harness 注入的真实能力回调 */
export interface ToolContext {
  notesRoot: string;
  cwd?: string;
  readFile(rel: string, maxBytes?: number): Promise<string>;
  searchLocal(query: string, limit?: number): Promise<LocalHit[]>;
  readPdfPage?: (page?: number) => Promise<string | undefined>;
  listNotes(): Promise<{ path: string; title: string }[]>;
  confirmWorkspaceWrite?: (proposal: WorkspaceProposal) => Promise<boolean>;
  signal?: AbortSignal;
}

/** 单个工具：定义（JSON Schema）+ 访问级别 + 执行体 */
export interface ToolHandler {
  definition: ToolDefinition;
  access: ToolAccess;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** 工具内部错误（执行层捕获回填为 tool 消息，不中断 LLM 循环） */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
