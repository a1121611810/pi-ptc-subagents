/**
 * 渲染/截断上限常量的登记守卫。
 *
 * 要挡的失败模式是「规则自称覆盖、表格实际零覆盖」：
 * .opencodereview/rules/ptc-render-bounds.md 开头写着「以及 src/tools/text.ts 的部分函数」，
 * 可它的硬约束表里四个上限全是 render.ts 的契约（4 / 6 / 120 / 50 KiB + 2000 lines），
 * 而 text.ts 自己的两套上限 MAX_LINE_CHARS=200 与 INLINE_MAX_CHARS=100 一个字都没提。
 * 这类漏 diff 评审看不出来（规则文件没被改、rule.json 锚点也没变），也不会让任何既有测试
 * 变红，所以必须用机器守卫钉住。
 *
 * 断言方向是单向的：源码里的每一个上限常量都必须在规则文件里被登记；反之不要求
 * ——规则可以写得比常量更细，那不是缺陷。
 *
 * 期望值来源：不是从实现反推，而是「源码声明」与「规则文档」这一对独立文件之间的差分，
 * 外加 docs/testing-constraints.md 的不变量：一个自称覆盖某文件的规则，不能对该文件
 * 声明过的上限零覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RULE_DOC = join(REPO_ROOT, ".opencodereview/rules/ptc-render-bounds.md");

/** 规则自称登记渲染/截断上限的文件。 */
/**
 * 规则自称登记渲染/截断上限的文件。
 *
 * `task-panel-render.ts` 是第三个: `.opencodereview/rule.json` 早就把它锚到本规则,
 * 但它有 5 个 `MAX_*` 上限(48 / 120 / 160 / 6 / 32)一个都没登记——锚点比规则宽。
 * 它的 `AGE_TICK_MS = 1000` 是重绘节拍不是截断上限,名字不含 MAX,按口径天然排除(这正是
 * 把扫描面交给口径而不是手挑文件的原因)。
 *
 * `shimmer.ts` 同样被 rule.json 锚到本规则,但它的 `DEFAULT_SHIMMER_INTERVAL_MS = 150` 是
 * 节拍间隔;等将来那个文件真出现渲染上限时再加进来。
 */
const SCANNED_FILES: readonly string[] = [
  "src/tools/render.ts",
  "src/tools/text.ts",
  "src/tools/task-panel-render.ts",
];

/**
 * 「上限型常量」的判定口径：名字里出现 MAX，或以 _CHARS / _BYTES / _LINES 收尾。
 *
 * 为什么不能用 MAX_ 前缀这一条：render.ts 的 TREE_VALUE_MAX_DEPTH 与 text.ts 的
 * INLINE_MAX_CHARS 都是 _MAX_ 中缀形态，前缀口径会漏掉它们，而 INLINE_MAX_CHARS 恰好就是
 * 本轮漏登记的那个常量。取 MAX 子串同时覆盖前缀与中缀。
 * 为什么补 _CHARS / _BYTES / _LINES：留给将来不以 MAX 命名、但同样是上限的常量
 * （例如某个 SUMMARY_HINT_CHARS），这类名字在前缀口径下会整个漏掉。
 *
 * 明确排除的非上限：render.ts 的 LABEL_WIDTH(8)、TREE_INDENT、TREE_ROOT，text.ts 的 INDENT。
 * 它们是排版宽度、缩进与连接符，改它们不改变任何内容被丢弃多少，登记进来是噪声。
 */
const CAP_NAME = /MAX|_(?:CHARS|BYTES|LINES)/;

/**
 * 模块级数值常量声明，export 与非 export 两种形态都收。
 *
 * 只匹配行首的 const：这两个文件里的上限常量都是模块级的，函数体内的局部 const 不属于
 * 「这个文件对外承诺的渲染上限」。这里的 \s* 允许换行，免得将来有人把 = 与数值拆成两行时
 * 静默漏扫——抽取器漏扫一个上限，等于给那个上限开了一扇不用登记的门。
 */
const CAP_DECLARATION =
  /^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=]*?)?=\s*(-?\d+)\s*(?:as\s+const\s*)?;/gm;

/**
 * 抽取器的哨兵名单：截至写这份测试时这两个文件里真实存在的全部上限常量，
 * 逐个对照 src/tools/render.ts:78-85、305-307 与 src/tools/text.ts:25,28 抄得。
 *
 * 这份名单存在的意义是「抽取器失效时必须红」：哪天 CAP_NAME 或 CAP_DECLARATION 改坏了、
 * 把结果扫成空表，下面那条包含性断言会立刻红，而不是让登记断言变成永远通过的空转
 * （docs/testing-constraints.md 约束 #5，以及 ptc-config-wiring 模板 B 的同款教训）。
 */
const SENTINEL_CAPS: readonly string[] = [
  // render.ts：折叠态各分块的上限
  "MAX_CODE_LINES_EXPANDED",
  "MAX_CODE_LINE_CHARS",
  "MAX_LOG_LINES_EXPANDED",
  "MAX_PHASES_EXPANDED",
  "MAX_WARNINGS_EXPANDED",
  "MAX_RESULT_HINT_CHARS",
  "MAX_ERROR_CHARS",
  "MAX_SUBCALL_PREVIEW_CHARS",
  // render.ts：树形 completion value 的三个上限（_MAX_ 中缀命名）
  "TREE_VALUE_MAX_DEPTH",
  "TREE_VALUE_MAX_CHILDREN",
  "TREE_VALUE_MAX_LINE_CHARS",
  // text.ts：与上面那个 120 无关的两套行宽/形态判定上限
  "MAX_LINE_CHARS",
  "INLINE_MAX_CHARS",
  // task-panel-render.ts：任务面板自己的五个上限。注意 MAX_ERROR_CHARS 与 render.ts 那个同名同值（都是 120），是两个独立常量；守卫分不开它们，此处的绿是巧合不是证据。
  "MAX_LABEL_CHARS",
  "MAX_ERROR_CHARS",
  "MAX_OUTPUT_LINE_CHARS",
  "MAX_OUTPUT_PREVIEW_LINES",
  "MAX_TASK_PANEL_ROWS",
];

interface CapConstant {
  readonly name: string;
  /** 源码里的字面量数值。期望值来源就是这条声明本身，不是从实现反推的期望。 */
  readonly value: number;
  readonly file: string;
  readonly exported: boolean;
}

/** IO 边界：读不到就显式报错，绝不返回空串让下游断言变成空转。 */
function readTextFile(absolutePath: string): string {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new Error("cannot read " + absolutePath + ": " + String(cause));
  }
}

function repoFile(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

/** 从一份源码文本里抽出全部上限型数值常量。 */
function extractCaps(source: string, file: string): CapConstant[] {
  const found: CapConstant[] = [];
  CAP_DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CAP_DECLARATION.exec(source)) !== null) {
    const name = match[1] ?? "";
    if (!CAP_NAME.test(name)) continue;
    found.push({
      name,
      value: Number(match[2] ?? "0"),
      file,
      exported: match[0].startsWith("export"),
    });
  }
  return found;
}

/**
 * 规则文档里登记了某个常量的那些表格行。
 *
 * 两道过滤，缺一不可：
 * 1. 只认表格行（以竖线开头）。散文里顺口提一句不算登记——登记表得是一行能被逐条核对的记录。
 *    这条不是洁癖：第一版守卫只要求「文档某处同时出现标识符与数值」，反事实检查（把表格行删掉、
 *    只留解释文字）当场就是绿的，等于没守住；收紧成「必须是表格行」之后同一反事实才转红。
 * 2. 用标识符边界而不是朴素 includes()：规则第 16 行本来就有散文占位符
 *    MAX_DEPTH / MAX_CHILDREN / MAX_WIDTH，而 TREE_VALUE_MAX_CHILDREN 里含有子串
 *    MAX_CHILDREN，朴素子串查找会让「散文里提过一次」冒充「登记了这个常量」。
 */
function registryRows(ruleText: string, name: string): string[] {
  const boundary = new RegExp("(?<![A-Za-z0-9_])" + name + "(?![A-Za-z0-9_])");
  return ruleText
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|") && boundary.test(line));
}

/**
 * 登记格式：标识符与它的数值必须出现在同一条表格行里，这样才是一份可核对的登记表，
 * 人和机器读的是同一份东西。
 */
function hasRegisteredValue(ruleText: string, cap: CapConstant): boolean {
  const numeric = new RegExp("(?<![0-9.])" + cap.value + "(?![0-9.])");
  return registryRows(ruleText, cap.name).some((line) => numeric.test(line));
}

const scannedSources = SCANNED_FILES.map((file) => ({ file, text: readTextFile(repoFile(file)) }));
const extracted: CapConstant[] = scannedSources.flatMap((entry) =>
  extractCaps(entry.text, entry.file),
);
const ruleText = readTextFile(RULE_DOC);

function list(items: readonly string[]): string {
  return items.map((item) => "  - " + item).join("\n");
}

describe("渲染上限常量的抽取器", () => {
  test("哨兵名单里的每个上限都被抽到（抽取器失效时这里先红）", () => {
    const names = extracted.map((cap) => cap.name);
    const missed = SENTINEL_CAPS.filter((name) => !names.includes(name));
    expect(missed, "抽取器没抓到这些上限，登记断言已失去意义：\n" + list(missed)).toEqual([]);
    // 下界：抽取结果不得少于哨兵数量，防止「只剩一个也算过」。
    expect(extracted.length).toBeGreaterThanOrEqual(SENTINEL_CAPS.length);
  });

  test("抽取不是只扫 export：text.ts 的 INLINE_MAX_CHARS 没有 export", () => {
    // 直接读真实源码确认，不让这条断言只是复述抽取器的自我认知。
    const textSource = scannedSources.find((entry) => entry.file.endsWith("text.ts"))?.text ?? "";
    const declaration = textSource
      .split("\n")
      .find((line) => /^(?:export\s+)?const\s+INLINE_MAX_CHARS\b/.test(line));
    expect(declaration, "text.ts 里找不到 INLINE_MAX_CHARS 的声明行").toBeDefined();
    expect(declaration?.startsWith("export")).toBe(false);
    const cap = extracted.find((entry) => entry.name === "INLINE_MAX_CHARS");
    expect(cap, "抽取结果里没有未 export 的 INLINE_MAX_CHARS").toBeDefined();
    expect(cap?.exported).toBe(false);
  });

  test("抽取器只收上限，不收排版宽度、缩进与多行对象字面量（真实样例片段）", () => {
    // 逐行取自 src/tools/render.ts:44,64-85 与 src/tools/text.ts:25-31 的真实样例，
    // 不是为测试编造的输入：同一段里同时有上限、排版宽度、缩进和一个跨行对象字面量。
    const sample = [
      'const TOOL_TITLE: Record<PtcToolDetails["surface"], string> = {',
      '  run_code: "PTC",',
      '  workflow: "PTC workflow",',
      "};",
      'const TREE_ROOT = "└─ "; // call-row prefix',
      'const TREE_INDENT = "   "; // column children start at',
      "const LABEL_WIDTH = 8;",
      "const MAX_CODE_LINES_EXPANDED = 3;",
      "const MAX_CODE_LINE_CHARS = 120;",
      "export const MAX_LINE_CHARS = 200;",
      "const INLINE_MAX_CHARS = 100;",
      'const INDENT = "  ";',
    ].join("\n");
    expect(extractCaps(sample, "sample")).toEqual([
      { name: "MAX_CODE_LINES_EXPANDED", value: 3, file: "sample", exported: false },
      { name: "MAX_CODE_LINE_CHARS", value: 120, file: "sample", exported: false },
      { name: "MAX_LINE_CHARS", value: 200, file: "sample", exported: true },
      { name: "INLINE_MAX_CHARS", value: 100, file: "sample", exported: false },
    ]);
  });

  test("跨行的 = 与 as const 断言都不会让上限漏扫", () => {
    // 两种写法都不会静默漏扫：漏一个上限，等于给它开了一扇「不用登记」的门。
    const sample = ["export const MAX_SPLIT =\n  7;", "const MAX_PADDED = 9 as const;"].join("\n");
    expect(extractCaps(sample, "sample")).toEqual([
      { name: "MAX_SPLIT", value: 7, file: "sample", exported: true },
      { name: "MAX_PADDED", value: 9, file: "sample", exported: false },
    ]);
  });
});

describe("ptc-render-bounds.md 的上限登记表", () => {
  test("渲染/截断上限常量全部被规则文件登记", () => {
    const unregistered = extracted.filter((cap) => registryRows(ruleText, cap.name).length === 0);
    expect(
      unregistered,
      "以下上限常量没有被 .opencodereview/rules/ptc-render-bounds.md 登记（补登记时每个常量" +
        "需在自己的表格行里与数值同行出现）：\n" +
        unregistered
          .map((cap) => "  - " + cap.file + " " + cap.name + " = " + cap.value)
          .join("\n"),
    ).toEqual([]);
  });

  test("登记的数值与源码字面量一致（登记了但抄错数值同样算漏）", () => {
    const stale = extracted.filter((cap) => !hasRegisteredValue(ruleText, cap));
    expect(
      stale,
      "以下常量在规则文件里被提到，但同一行没有出现源码里的数值（可能抄错数值，" +
        "或只散落地提了一句而没有登记）：\n" +
        stale.map((cap) => "  - " + cap.file + " " + cap.name + " = " + cap.value).join("\n"),
    ).toEqual([]);
  });

  test("规则自称的适用文件包含登记表覆盖的两个文件", () => {
    const scopeLine = ruleText.split("\n").find((line) => line.includes("适用文件"));
    expect(scopeLine, "规则文件缺少「适用文件」声明行").toBeDefined();
    for (const file of SCANNED_FILES) {
      expect(scopeLine, "适用文件声明没有提到 " + file).toContain(file);
    }
  });
});

describe("IO 边界的失败路径", () => {
  test("读不到文件时显式报错，而不是返回空串", () => {
    const missing = repoFile("src/tools/this-file-does-not-exist.ts");
    expect(() => readTextFile(missing)).toThrow(/cannot read .*this-file-does-not-exist\.ts/);
  });
});
