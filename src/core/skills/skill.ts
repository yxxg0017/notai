/**
 * Skill 类型定义（纯数据层）。
 *
 * 全局约束：本目录（src/core/skills/）禁止 `import * as vscode` —— 这些模块需要在
 * node:test 环境下直接运行（无 VS Code 运行时）。
 *
 * 工具定义不在此处：Skill 只声明工具白名单（ToolId[]），
 * 具体工具的 JSON Schema 定义随请求动态下发。
 */

/** 合法工具 id 全集（与工具注册表保持一致） */
export type ToolId =
  | 'read_file'
  | 'search_local'
  | 'read_pdf_page'
  | 'list_notes'
  | 'create_note'
  | 'append_note'
  | 'edit_note'
  | 'move_note'
  | 'update_frontmatter'
  | 'web_search'
  | 'edit_workspace_file';

/**
 * Skill：面向学习场景的预置提示词模板 + 工具白名单。
 *
 * systemPrompt 为中文、可直接注入系统提示的段落（不含工具说明）；
 * tools 为该 Skill 允许使用的工具白名单；defaultOn 决定 chat 模式下是否默认启用。
 */
export interface Skill {
  /** 唯一标识，如 'translate' */
  id: string;
  /** 展示名（中文） */
  displayName: string;
  /** 可选图标（emoji 或图标名） */
  icon?: string;
  /** 一句话描述（用于技能选择列表） */
  description: string;
  /** 注入系统提示的段落 */
  systemPrompt: string;
  /** 允许使用的工具白名单 */
  tools: ToolId[];
  /** chat 模式下是否默认开启 */
  defaultOn: boolean;
}
