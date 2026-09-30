/**
 * 划词动作的提示词与选区校验（纯模块，禁止 `import 'vscode'`，供 node:test 直接测试）。
 *
 * 全局约束：本文件与 src/core/llm/ 相同，必须能在无 VS Code 运行时下加载。
 */

/** 校验并规整选区文本：trim 后为空（或 undefined）即抛错，由调用方捕获并提示 */
export function requireSelection(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') {
    throw new Error('请先选中文本');
  }
  return trimmed;
}

/** 翻译提示词：要求输出「译文 + 术语表」结构 */
export function buildTranslatePrompt(text: string): { system: string; user: string } {
  return {
    system: '你是一个翻译引擎。将用户文本翻译成中文；术语保留英文并给出释义。输出格式：译文 + 术语表。',
    user: `翻译：${text}`,
  };
}

/** 解释提示词：要求「先结论、再分点、最后例子」的导师式结构 */
export function buildExplainPrompt(text: string): { system: string; user: string } {
  return {
    system: '你是一位导师。用通俗语言解释用户文本，先给结论，再分点展开，最后给一个例子。',
    user: `解释：${text}`,
  };
}