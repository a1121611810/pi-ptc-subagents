/**
 * Source masking for source-scan fixtures — one pass, two variants, same length as the input.
 *
 * Why this is a helper and not a regex: a scanner that has to decide "is this occurrence real code"
 * is doing lexical analysis, and the three regexes this replaced each got a different case wrong.
 * `tests/extension.test.ts`'s own first version stripped only whole-line comments, so a trailing
 * `// TODO: getOptInBindings` satisfied a guard that exists to prove the option was passed. The
 * original lived in `tests/config-read-points.test.ts`; when a second scanner needed it, the honest
 * move was to share the one implementation that was already right rather than to re-derive a weaker
 * second copy — two hand-rolled strippers drift apart, and the weaker one becomes the one under test.
 *
 * Two variants, because the two consumers need different things and picking one for both is how a
 * scanner starts lying:
 *
 * - `code` — comments blanked, **string contents kept**. For matching identifiers: `config["foo"]`
 *   is a consumption shape, and a scanner that blanks strings cannot see it.
 * - `structural` — comments blanked **and** string contents blanked. For counting arguments and
 *   balancing brackets: a comma inside `"read, bash"` is not an argument separator, and a paren
 *   inside a string is not a paren. Getting this wrong is not a cosmetic error — an over-count turns
 *   a "too few arguments" defect into a silent pass.
 *
 * Both variants are character-for-character the same length as the input, so a line number found in
 * either maps straight back to the source.
 */

/** `string` covers `'`, `"` and `` ` ``; escaping is handled inside each. */
export type SourceMode = "code" | "line-comment" | "block-comment" | "string";

export interface MaskedSource {
  /** 注释已屏蔽、字符串字面量内容保留 —— 用于匹配标识符。 */
  readonly code: string;
  /** 注释与字符串字面量内容都屏蔽 —— 用于括号配平与参数切分。 */
  readonly structural: string;
}

/**
 * 单趟扫描同时产出两种掩码，行数与原文件严格一致（命中行号才对得上）。
 *
 * 已知局限：模板字符串里的 `${ ... }` 插值不再做嵌套词法分析，插值内部的引号 / 括号会被当作
 * 字面量内容处理。本仓用到的声明体（`DEFAULT_CONFIG` / `WORKER_ENV_ALLOW_LIST` /
 * `BUILTIN_BINDING_NAMES` / `ptc-mode.ts` 的绑定清单调用）都不含带括号的插值，所以不影响声明区间
 * 定位与参数计数。`structural` 变体对插值里的括号按字面量处理，插值里若出现顶层逗号会被少计——
 * 与本仓现状一致，属已知而非静默。
 */
export function maskSource(source: string): MaskedSource {
  let code = "";
  let structural = "";
  let mode: SourceMode = "code";
  let closingQuote = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line-comment";
        code += "  ";
        structural += "  ";
        i++;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block-comment";
        code += "  ";
        structural += "  ";
        i++;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        mode = "string";
        closingQuote = char;
        code += char;
        structural += char;
        continue;
      }
      code += char;
      structural += char;
      continue;
    }
    if (mode === "line-comment") {
      const kept = char === "\n" ? "\n" : " ";
      code += kept;
      structural += kept;
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        code += "  ";
        structural += "  ";
        i++;
        continue;
      }
      const kept = char === "\n" ? "\n" : " ";
      code += kept;
      structural += kept;
      continue;
    }
    if (char === "\\") {
      code += char + next;
      structural += "  ";
      i++;
      continue;
    }
    if (char === closingQuote) {
      mode = "code";
      code += char;
      structural += char;
      continue;
    }
    // 字符串字面量内容在 code 变体里保留（config["foo"] 也是一种消费形态），
    // 在 structural 变体里屏蔽（引号内的逗号不该算参数分隔符，括号不该参与配平）。
    // 两个变体都与原文逐字符等长，命中行号才对得上。
    code += char;
    structural += char === "\n" ? "\n" : " ";
  }
  return { code, structural };
}
