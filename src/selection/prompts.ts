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

/**
 * 翻译提示词：强制「译文 + 术语表」固定双段格式（0.3 规范输出格式，
 * 前端 parseTranslateResult 按此格式正则提取；禁止模型自行发挥格式）。
 */
export function buildTranslatePrompt(text: string): { system: string; user: string } {
  return {
    system:
      '你是一个翻译引擎。将用户文本翻译成中文；术语保留英文并给出中文释义。\n' +
      '严格按以下固定格式输出，不要输出任何其他内容（不要加粗、不要编号、不要多余段落）：\n' +
      '译文：<中文译文>\n' +
      '术语表：\n' +
      '- <英文术语>：<中文释义>\n' +
      '若没有需要解释的术语，「术语表：」后不输出任何行。',
    user: `翻译：${text}`,
  };
}

/** 翻译结果解析：按固定格式「译文：…」+「术语表：…」正则提取（纯函数，供 node:test 测试） */
export interface TranslateResult {
  /** 「译文：」行内容（无该行时回退整段原文，保证非空） */
  translation: string;
  /** 术语表段落（「术语表：」标题之后的行，原样拼接；无则空串） */
  glossary: string;
}

export function parseTranslateResult(raw: string): TranslateResult {
  const text = String(raw ?? '').trim();
  let translation = '';
  let glossary = '';
  let inGlossary = false;
  for (const line of text.split(/\r?\n/)) {
    // 归一化：去首部列表/加粗装饰（`- `、`**`）与尾部 `**`，兼容模型未遵守固定格式的变体
    const t = line.trim().replace(/^[-*]+\s*/, '').replace(/\s*\*+$/, '');
    const tm = t.match(/^译文\s*\**\s*[：:]\s*\**\s*(.*)$/);
    const gm = t.match(/^术语表\s*\**\s*[：:]\s*\**\s*$/);
    if (tm) {
      translation += (translation ? '\n' : '') + tm[1].trim();
      continue;
    }
    if (gm) {
      inGlossary = true;
      continue;
    }
    if (inGlossary && t) {
      glossary += (glossary ? '\n' : '') + t;
    }
  }
  return { translation: translation || text, glossary };
}

/** 解释提示词：要求「先结论、再分点、最后例子」的导师式结构 */
export function buildExplainPrompt(text: string): { system: string; user: string } {
  return {
    system: '你是一位导师。用通俗语言解释用户文本，先给结论，再分点展开，最后给一个例子。',
    user: `解释：${text}`,
  };
}