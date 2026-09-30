/**
 * 文档完整性守卫 —— 把 `.opencodereview/rules/doc-sync.md` 必查 6 / 7 里**可判定**的部分变成机器断言。
 *
 * 为什么必须有这份 fixture（而不是继续靠人手套 doc-sync 清单）：
 * doc-sync 是唯一一条管文档漂移的规则，而它在 ocr v1.12.10 上**永远不会被自动投递**。实测
 * （tests/ocr-anchor-coverage.test.ts 已把这条钉成断言）：`.md` 在 ocr 的**选择层**一律被丢，
 * `exclude_reason: unsupported_ext`，`ocr scan --preview` 列 70 个 `.md`、will_review 为 true 的有 0 个。
 * 规则解析层是好的（显式喂路径仍返回 `source: project`），但没人会显式喂 —— 于是这条规则只能靠人手套，
 * 而「人手」正是它在 AGENTS.md 里被记为 silent failure 的原因：链接 404、行号错位、符号零读点、
 * 账本伪闭环，没有一条会让任何 CI 变红。
 *
 * 期望值的独立来源（约束 #4）：本 fixture 不从实现反推任何期望值。四个断言各自钉住一条**不变量**：
 *   1. 文档里的相对链接指向的文件必须存在 —— 期望值是文件系统本身（`existsSync`）；
 *   2. 规范文档点名的具名符号必须在本仓 `src/` 里有读点 —— 期望值是「文档声明的东西必须在代码里存在」
 *      这条不变量，判定面是文档与 `src/` 两个独立文件的差分；
 *   3. 账本引用的 commit SHA 必须能被 git 解析 —— 期望值是 git 对象库本身（`git rev-parse`）；
 *   4. 规范文档里的 `file:line` 行号必须落在目标文件行数内 —— 期望值是目标文件本身。
 * 数量下界同样是实测基线，不是猜的（每个下界上方注明了它的来源与实测值）。
 *
 * ## 规范文档 / 历史快照的分界（本文件最重要的范围判断）
 *
 * **规范（normative）**：README.md、CONTEXT.md、docs/adr/**、docs/specs/**、docs/usage/**。
 * 它们是「当前事实的声明」，引用失效就是缺陷，必须断言。
 *
 * **历史快照（snapshot）**：docs/research/** 与 docs/reviews/**。
 * **本文件不对它们的 file:line 行号断言有效性**，理由必须写下来，否则下一个人会以为这里是漏了：
 * research 是调研当时的记录、reviews 是评审当时的账本，它们的 `file.ts:123` 在**写下时是对的**，
 * 代码一改就漂移，而那是预期行为不是缺陷。实测分布也说明断言它们没有意义：全仓 248 处
 * `file:line` 里 240 处在快照（69 处挤在 `docs/research/dispatcher-test-timing-rootcause.md`、
 * 84 处在 `docs/reviews/**`），规范文档只有 8 处。对快照断言行号会立刻产生 240 条红灯 ——
 * 守卫一旦变成噪声就等于没有守卫。
 *
 * 但**链接 404 在任何文档里都是缺陷，与行号会不会漂是两回事**，所以相对链接断言扫全量
 * docs/** 加仓库根的 README.md / AGENTS.md / CONTEXT.md，docs/research/** 也在内。
 * 这条口径上线第一天就抓到一个真缺陷：`docs/research/prototype-pulse-tui-variants/industry-findings.md`
 * 的 16 / 73 / 127 行写 `../../dsh-ptc-page-rendering.md`，从该目录出发落到 `docs/` 下不存在的文件，
 * 正确路径是 `../dsh-ptc-page-rendering.md`。
 *
 * ## file:line 的判定面
 *
 * 规范文档里 15 处 `file:line`：8 处指向 DSH 宿主文件与 node_modules 产物（`ToolCallTree.tsx`、
 * `ChatGroupSeat.tsx`、`bash.js` 等，本仓根本没跟踪，留在校验面外是对的）；7 处指向本仓的
 * `src/tools/render.ts`，逐行核对过，行号真的在被查。
 *
 * 判定基准有**三条**且缺一不可：文档所在目录（`../agents/domain.md`）、仓库根
 * （`src/runtime/limits.ts`）、以及全仓唯一同名文件（`render.ts:145`）。
 * 只认第一条时这条断言会退化成空转 —— 这不是假想，是反事实实测出来的。
 * **第三条是 2026-09-29 补的盲点**：ADR-0013 §6 补完「展开态错误块的两条边界」之后新增了 7 处
 * 引用，写的都是 `render.ts:145` 这种只有 basename 的形态，前两个基准双双落空 ——
 * 引用静默逃出校验面，**行号漂移也不会有任何东西变红**。守卫看上去覆盖了 file:line，
 * 实际漏掉了这七条。接进第三条之后它们第一次真的在被检查。
 * 第三条要求全仓唯一：重名（本仓只有 `.gitignore` 与 `README.md`）时不接，宁可漏不可猜。
 *
 * ## 符号断言为什么缩到只剩 adr + specs + usage + README + CONTEXT
 *
 * 口径放宽到全部规范文档时，408 个标识符形态的反引号 token 里有 72 个在 `src/` 找不到 ——
 * 72 条红灯会把守卫变成噪声，规则第 2 条的纪律是「宁可少报也不要因为误报把守卫变成噪声」。
 * 这 72 个不是缺陷，是三类词汇压根不属于本仓：
 *   - DSH / pi 宿主的 API（`TextShimmer`、`truncateLine`、`requestRender`、`SessionShutdownEvent` …）；
 *   - 打包与 `package.json` 的词表（`outExtensions`、`mangleProps`、`devDependencies` …）；
 *   - ADR-0022 明确推迟到 v2 的宿主 PTC 方法（`ptc_task_handoff`、`ptc_task_append` …）。
 * 所以扫描面排除 **AGENTS.md 与 docs/agents/**：那几份文档讲的是**评审工具与仓库流程**，
 * 它们的词表属于 ocr rule schema 与 GitHub API，不属于 PTC 产品。对它们断言「符号必须在 `src/`」
 * 没有语义。链接断言仍然覆盖它们。
 * 剩下的外部词汇收敛成一张**显式清单**（见 EXTERNAL_VOCABULARY），每条注明为什么排除，
 * 并配两条反向守护防止清单无声膨胀 —— 排除清单本身就是新的漂移源。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOCS_DIR = join(REPO_ROOT, "docs");
const SRC_DIR = join(REPO_ROOT, "src");

/** 仓库根的三份文档：doc-sync 必查 4 / 5 明确说它们不在 docs/** 里但同样受管。 */
const ROOT_DOCS: readonly string[] = ["README.md", "AGENTS.md", "CONTEXT.md"];

/**
 * 符号断言的扫描面（理由见文件头「符号断言为什么缩到只剩 …」）。
 * 链接与行号断言不受此限制，链接扫全量。
 */
const SYMBOL_SCAN_PREFIXES: readonly string[] = ["docs/adr/", "docs/specs/", "docs/usage/"];
const SYMBOL_SCAN_ROOT_DOCS: readonly string[] = ["README.md", "CONTEXT.md"];

/**
 * 数量下界。每个值都是实测基线（见各处的注释），不是拍脑袋 —— 下界的作用是
 * 「抽取器失效时必须红」。抽取器一坏，全称断言会静默恒真，而这正是
 * `docs/testing-constraints.md` 约束 #5 与 ptc-config-wiring 模板 B 的同款教训。
 */
const MARKDOWN_FILE_FLOOR = 50; // 实测 docs/** 50 个 .md + 仓库根 3 个 = 53
const LINK_FLOOR = 30; // 实测 43 条非 URL 链接目标（掩掉行内代码后）
const SYMBOL_TOKEN_FLOOR = 200; // 实测 239 个通过形态过滤的具名 token
const SHA_OCCURRENCE_FLOOR = 20; // 实测 68 处 SHA 出现（31 个唯一值）
const SHA_UNIQUE_FLOOR = 20; // 实测 31 个唯一短 SHA
const LINE_REF_FLOOR = 5; // 实测规范文档 8 处 file:line（全部指向仓库外）

/** 规范文档：当前事实的声明，引用失效即缺陷。 */
const NORMATIVE_PREFIXES: readonly string[] = ["docs/adr/", "docs/specs/", "docs/usage/"];

function isNormative(rel: string): boolean {
  if (rel === "README.md" || rel === "CONTEXT.md") return true;
  return NORMATIVE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

/** 历史快照：调研记录与评审账本，行号漂移是预期行为，见文件头。 */
function isSnapshot(rel: string): boolean {
  return rel.startsWith("docs/research/") || rel.startsWith("docs/reviews/");
}

// ---------------------------------------------------------------------------
// IO 边界（约束 #1 / #3：读文件失败要抛显式错误，不许静默返回空集合）
// ---------------------------------------------------------------------------

/** 读一份文档。失败时抛带路径的错误 —— 静默返回空串会让全称断言恒真。 */
function readDoc(absolute: string): string {
  try {
    return readFileSync(absolute, "utf8");
  } catch (cause) {
    throw new Error(`读文档失败: ${relative(REPO_ROOT, absolute)} —— ${String(cause)}`);
  }
}

/** 读 package.json，失败同样抛错（符号断言要用它的键当排除面）。 */
function readPackageJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new Error(`读 package.json 失败: ${String(cause)}`);
  }
}

/** 递归列出 docs/** 下的 .md（跳过隐藏目录与 node_modules），返回相对仓库根的路径。 */
function listDocsMarkdown(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".md")) out.push(relative(REPO_ROOT, full));
    }
  };
  walk(DOCS_DIR);
  return out.sort();
}

/** 递归列出 src/** 下的 .ts（生产代码，排除 .d.ts），返回相对仓库根的路径。 */
function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(relative(REPO_ROOT, full));
    }
  };
  walk(SRC_DIR);
  return out.sort();
}

// ---------------------------------------------------------------------------
// 代码掩码：抽 markdown 行内代码 / 围栏代码块
// ---------------------------------------------------------------------------

/**
 * 把围栏代码块（``` / ~~~）整段替换成空格，**行数与列宽与原文严格一致**。
 * 掩码而不是删除，是为了让命中行号仍能对回原文。
 */
function maskFencedCode(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(" ".repeat(line.length));
      continue;
    }
    out.push(inFence ? " ".repeat(line.length) : line);
  }
  return out.join("\n");
}

/** 在已掩掉围栏的文本上把行内代码片段整段替换成空格（同样保持等长）。 */
function maskInlineCode(text: string): string {
  const chunks: string[] = [];
  let index = 0;
  for (const match of text.matchAll(/(`+)([^`\n]+?)\1/g)) {
    const start = match.index;
    chunks.push(text.slice(index, start));
    chunks.push(" ".repeat((match[0] ?? "").length));
    index = start + (match[0] ?? "").length;
  }
  chunks.push(text.slice(index));
  return chunks.join("");
}

/** 把偏移量换算成 1-based 行号。 */
function lineAt(masked: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < masked.length; i++) {
    if (masked[i] === "\n") line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

interface DocEntry {
  /** 相对仓库根的路径，报告里直接用它。 */
  readonly rel: string;
  readonly absolute: string;
  readonly text: string;
}

const ALL_DOCS: readonly DocEntry[] = [...listDocsMarkdown(), ...ROOT_DOCS]
  .sort()
  .map((rel) => ({ rel, absolute: join(REPO_ROOT, rel), text: readDoc(join(REPO_ROOT, rel)) }));

const NORMATIVE_DOCS: readonly DocEntry[] = ALL_DOCS.filter((doc) => isNormative(doc.rel));
const SNAPSHOT_DOCS: readonly DocEntry[] = ALL_DOCS.filter((doc) => isSnapshot(doc.rel));
const SYMBOL_SCAN_DOCS: readonly DocEntry[] = ALL_DOCS.filter(
  (doc) =>
    SYMBOL_SCAN_ROOT_DOCS.includes(doc.rel) ||
    SYMBOL_SCAN_PREFIXES.some((prefix) => doc.rel.startsWith(prefix)),
);

/** src/ 全部生产代码拼成一个大字符串：符号断言只需要「这个标识符在不在生产代码里」。 */
const SOURCE_TEXT: string = listSourceFiles()
  .map((rel) => readDoc(join(REPO_ROOT, rel)))
  .join("\n");

/** package.json 的键集（顶层 + scripts + 两类依赖）：打包词表不是产品符号。 */
const PACKAGE_KEYS: ReadonlySet<string> = (() => {
  const pkg = readPackageJson();
  const keys = new Set<string>(Object.keys(pkg));
  for (const field of ["scripts", "dependencies", "devDependencies", "peerDependencies"]) {
    const value = pkg[field];
    if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value)) keys.add(key);
    }
  }
  return keys;
})();

// ---------------------------------------------------------------------------
// 断言一：相对链接可解析
// ---------------------------------------------------------------------------

interface LinkRef {
  readonly doc: string;
  readonly line: number;
  /** 去掉锚点后的路径部分。 */
  readonly target: string;
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|#|\\)/i;

/**
 * 抽相对 markdown 链接。行内代码先掩掉 —— ``tools["pi.dispatch"](args)`` 这类**代码示例**里的
 * `](...)` 不是链接，掩码不当就会把 `args` / `{...}` 当成路径报 404。
 * 锚点片段（#xxx）不校验，只校验路径部分（锚点是否仍存在是另一条规则的事）。
 */
function extractRelativeLinks(doc: DocEntry): LinkRef[] {
  const masked = maskInlineCode(maskFencedCode(doc.text));
  const refs: LinkRef[] = [];
  for (const match of masked.matchAll(/\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1] ?? "";
    if (raw === "" || URL_LIKE.test(raw)) continue;
    refs.push({
      doc: doc.rel,
      line: lineAt(masked, match.index),
      target: raw.split("#")[0] ?? raw,
    });
  }
  return refs;
}

const ALL_LINKS: readonly LinkRef[] = ALL_DOCS.flatMap(extractRelativeLinks);

/** 目标文件是否存在于磁盘上。这是断言一的期望值来源。 */
function linkResolves(ref: LinkRef): boolean {
  if (ref.target === "") return true;
  return existsSync(resolve(dirname(join(REPO_ROOT, ref.doc)), ref.target));
}

/** 找出解析不了的链接，并带上 `文档:行号` 与原文目标，报错即可直接去改。 */
function collectBrokenLinks(docs: readonly DocEntry[]): LinkRef[] {
  return docs.flatMap(extractRelativeLinks).filter((ref) => !linkResolves(ref));
}

function formatRef(ref: LinkRef): string {
  return `${ref.doc}:${ref.line} -> ${ref.target}`;
}

// ---------------------------------------------------------------------------
// 断言二：规范文档点名的符号在 src/ 有读点
// ---------------------------------------------------------------------------

/**
 * 具名声明的四种形态（本仓 `src/` 里声明符号的真实形态，不多不少）：
 *   - lowerCamel：`ownerPid`、`drainGraceMs`、`dispatchConcurrency`
 *   - PascalCase：`TaskRecord`、`SubCallTracker`、`DispatchResult`
 *   - UPPER_SNAKE：`TREE_VALUE_MAX_DEPTH`、`WORKER_ENV_ALLOW_LIST`
 *   - snake_case：`lost_on_session_restart` 这类状态字符串
 * 刻意**不收**全小写单词（`engines`、`corepack`、`minify`、`checkout` …）：
 * 它们是散文词与命令行词，不是声明。
 */
const SYMBOL_SHAPES: readonly RegExp[] = [
  /^_?[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/,
  /^_?[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/,
  /^_?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/,
];

/** 7–40 位且含至少一个十六进制字母：commit 短 SHA，不是符号。 */
const HEX_SHA_LIKE = /^(?=.*[a-f])[0-9a-f]{7,40}$/;

interface SymbolRef {
  readonly doc: string;
  readonly line: number;
  readonly name: string;
}

/** 抽规范文档里反引号包裹、且形态像具名声明的 token。 */
function extractDeclaredSymbols(doc: DocEntry): SymbolRef[] {
  const masked = maskFencedCode(doc.text);
  const refs: SymbolRef[] = [];
  const seen = new Set<string>();
  for (const match of masked.matchAll(/`([^`\n]+?)`/g)) {
    const name = match[1] ?? "";
    if (seen.has(name)) continue;
    if (!SYMBOL_SHAPES.some((shape) => shape.test(name))) continue;
    if (HEX_SHA_LIKE.test(name)) continue;
    if (PACKAGE_KEYS.has(name)) continue;
    // 名字与仓库根某个真实路径同名（node_modules、coverage …）：那是路径不是符号。
    if (existsSync(join(REPO_ROOT, name))) continue;
    seen.add(name);
    refs.push({ doc: doc.rel, line: lineAt(masked, match.index), name });
  }
  return refs;
}

/**
 * Every declaration-shaped token named anywhere in the documentation, built once
 * and deliberately below the extractor that produces it: the function has to be
 * in scope, and relying on function hoisting for that is a trap waiting for the
 * day someone writes it as a const arrow.
 *
 * The point is not deduplication -- there is exactly one scan here and there was
 * exactly one before. The point is that the scan is not inside a timed test body:
 * it runs once at import, and the assertion that uses it is then O(exclusion list).
 * Growing the corpus by a few hundred lines had been enough to push that assertion
 * past vitest's default timeout in a fully parallel run, and the budget fix that
 * first seemed obvious -- raising the timeout -- was three hundred times the real
 * cost and would have hidden a genuine regression.
 */
const ALL_SCANNED_NAMES: ReadonlySet<string> = new Set(
  ALL_DOCS.flatMap((doc) => extractDeclaredSymbols(doc)).map((ref) => ref.name),
);

/**
 * 外部词汇排除清单：**名字 + 为什么排除**。
 *
 * 这张清单是「显式」而不是靠正则隐式过滤的：每一条都是一次判断，判断依据写在这里，
 * 将来谁想扩清单必须先回答同一个问题。配套有两条反向守护（见「排除清单不会无声膨胀」
 * describe），所以清单不会退化成「什么都往里塞」。
 *
 * 分类与实测（扫描面 = adr + specs + usage + README + CONTEXT，239 个 token、36 条命中本清单）：
 *   A. DSH / pi 宿主 API —— 本仓是被宿主加载的 mode extension，不可能声明宿主的类与字段；
 *   B. 打包与构建配置 —— rolldown / vite / package.json 的词表；
 *   C. ADR-0022 明确推迟到 v2 的宿主 PTC 方法（文档自己写了 out of scope）；
 *   D. 第三方词表 —— GitHub Actions、vitest、采集表字面量、npm 发布环境变量。
 */
const EXTERNAL_VOCABULARY: ReadonlyMap<string, string> = new Map([
  // A. DSH / pi 宿主 API
  // A2. pi 0.99.1 内建 codemode 扩展的沙箱全局函数，本仓只是文档层面提及，
  // 从不声明也从不调用（QuickJS 侧无 fs / 无网络，无法实现等价物）。
  ["describeTool", "pi 内建 codemode 沙箱的全局函数，本仓不声明（ADR-0025）"],
  ["ToolInfo", "pi ExtensionAPI.getAllTools 的返回类型，本仓只在 ADR-0026 里引用（ADR-0026）"],
  [
    "getSettings",
    "pi 0.99.1 的 ExtensionAPI 方法，工厂时点为 notInitialized 桩；本仓明确不依赖它（ADR-0026）",
  ],
  ["searchTools", "pi 内建 codemode 沙箱的全局函数，本仓不声明（ADR-0025）"],
  ["max_output_tokens", "pi 内建 codemode 的脚本级输出预算选项，本仓不声明（ADR-0025）"],
  ["timeout_ms", "pi 内建 codemode 的脚本级死线选项；本仓同名概念是 maxTimeoutMs（ADR-0025）"],
  ["SessionShutdownEvent", "pi 宿主生命周期事件，本仓只消费不声明"],
  ["ShimmerDecorator", "DSH 渲染层的装饰器类"],
  ["TextShimmer", "DSH 渲染层的 shimmer 组件类"],
  ["ToolCallTree", "DSH 渲染层的子调用树组件类"],
  ["UserConfig", "pi 宿主配置文件里的用户配置类型"],
  ["_baseSystemPromptOptions", "pi 宿主内部字段（下划线前缀即私有）"],
  ["additionalContexts", "pi 宿主的上下文数组字段"],
  ["defaultTools", "pi 宿主的工具名数组字段"],
  ["deferContext", "pi 宿主的上下文延迟注入接口"],
  ["maxSubCalls", "DSH 侧 sub-call 深度上限字段"],
  ["notificationCadenceMs", "宿主任务通知的节流字段"],
  ["notificationRateLimit", "宿主任务通知的限流字段"],
  ["outputSchema", "宿主对 model-facing 结果的 schema 字段"],
  ["rendererState", "DSH 渲染层的内部状态字段"],
  ["requestRender", "DSH 渲染层的重绘触发接口"],
  ["sourceInfo", "pi 宿主的消息来源信息字段"],
  ["subscriptionPollIntervalMs", "宿主订阅的轮询间隔字段"],
  ["toolPendingBg", "DSH 行渲染的后台 pending 状态字段"],
  ["truncateHead", "pi 宿主的截断函数，只被本仓调用不被本仓声明"],
  ["truncateLine", "pi 宿主的按行截断函数，只被本仓调用不被本仓声明"],
  // B. 打包与构建配置
  ["MinifyOptions", "rolldown 的 minify 选项类型"],
  ["VIRTUAL_MODULES", "rolldown 的虚拟模块集合名"],
  ["devDependency", "package.json 字段名的散文单数形态，复数形态已由 PACKAGE_KEYS 派生排除"],
  ["mangleProps", "rolldown 的属性混淆选项"],
  ["outExtensions", "rolldown 的产物扩展名映射选项"],
  ["withDist", "打包脚本的选项名"],
  // C. ADR-0022 推迟到 v2 的宿主 PTC 方法（文档自己标注 out of scope）
  ["ptc_parent_query", "ADR-0022 v2 方法，v1 明确 out of scope"],
  ["ptc_query_response", "ADR-0022 v2 方法，v1 明确 out of scope"],
  ["ptc_task_append", "ADR-0022 v2 方法，v1 明确 out of scope"],
  ["ptc_task_handoff", "ADR-0022 v2 方法，v1 明确 out of scope"],
  ["ptc_task_resume", "ADR-0022 v2 方法，v1 明确 out of scope"],
  ["start_or_steer_turn", "宿主 PTC 生命周期事件名，非本仓导出"],
  // D. 第三方词表
  ["_npmUser", "GitHub Actions / npm trusted publishing 的发布环境变量"],
  ["pull_request", "GitHub Actions 的事件名字面量"],
  ["toEqual", "vitest 的断言器名，ADR 里在讲测试写法"],
  ["tool_name", "竞态采集表的列名字面量，不是代码符号"],
]);

// ---------------------------------------------------------------------------
// 断言三：账本里的 commit SHA 可解析
// ---------------------------------------------------------------------------

/**
 * 7–40 位十六进制串，大小写都认。
 *
 * 字符类原来是 `[0-9a-f]`（只小写），**大写 SHA 会静默逃过整条断言三**——将来谁在账本里
 * 写一个大写 commit，守卫照样全绿。实测当前 8 份账本里没有大写形态（纯理论盲点），
 * 但「没有就够」不是纪律：漏网路径要堵上，不是等它发生。git 本身对大小写两种都接受。
 */
const HEX_TOKEN = /(?<![0-9a-zA-Z])([0-9a-fA-F]{7,40})(?![0-9a-zA-Z])/g;
/** 纯十进制串：账本里的日期 20260929 与时间戳 1469918176385 属这一类，按口径排除。 */
const ALL_DECIMAL = /^[0-9]+$/;

interface ShaRef {
  readonly doc: string;
  readonly line: number;
  readonly sha: string;
}

/** 抽账本里像 SHA 的十六进制串；纯十进制串按口径排除。 */
function extractShaCandidates(doc: DocEntry): ShaRef[] {
  const masked = maskFencedCode(doc.text);
  const refs: ShaRef[] = [];
  for (const match of masked.matchAll(HEX_TOKEN)) {
    const sha = match[1] ?? "";
    if (ALL_DECIMAL.test(sha)) continue;
    refs.push({ doc: doc.rel, line: lineAt(masked, match.index), sha });
  }
  return refs;
}

const REVIEW_DOCS: readonly DocEntry[] = ALL_DOCS.filter((doc) =>
  doc.rel.startsWith("docs/reviews/"),
);
const REVIEW_SHAS: readonly ShaRef[] = REVIEW_DOCS.flatMap(extractShaCandidates);

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

/**
 * 浅克隆里旧 commit 的对象根本不在本地，`git rev-parse` 必然失败 —— 那是环境问题不是文档缺陷。
 * 显式跳过并说明，绝不为了让断言变绿去动期望值。
 */
function gitIsShallow(): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
      }).trim() === "true"
    );
  } catch {
    return true;
  }
}

const gitReady = gitAvailable() && !gitIsShallow();

/**
 * 一个 SHA 的判定结果。**刻意是三态而不是布尔。**
 *
 * `git rev-parse --verify --quiet <sha>^{commit}` 抛异常有两种完全不同的原因：
 *   - exit 1、无输出 —— git 明确说这不是一个对象，**这是账本缺陷，要报**；
 *   - exit 128 / spawn 失败（fork EAGAIN、被杀、索引锁）—— 这是**环境问题**。
 * 混为一谈的后果是：一次瞬时失败会让门禁变红，而红的原因看上去是「账本记错了 commit」，
 * 于是有人会去改一条没坏的账本行。2026-09-29 在 47 个测试文件并行跑时实测到过一次。
 * 环境问题重试一次；仍失败返回 `unavailable`，由调用方显式 skip —— 不让噪声冒充缺陷。
 */
type ShaVerdict = "resolves" | "missing" | "unavailable";

/**
 * **一次 git 调用判定一批 SHA。**
 *
 * 原来是每个 SHA 一次 git rev-parse（68 次串行 spawn）。单跑没事，47 个测试文件并行时
 * 稳定超过 vitest 的 5 秒默认超时 —— 报出来的是「Test timed out」，而红的表面原因是
 * 「账本里的 SHA 解析不了」，两者毫无关系。这种超时是最坏的失败形态：它与缺陷无关，
 * 却长得像缺陷，CI 上会随机复现。实测 20 次串行 spawn = 0.263 秒，单次 cat-file --batch-check =
 * 0.011 秒。68 次变 1 次，超时面直接消失。
 *
 * 先去重再判定：账本里 68 处引用只有 31 个唯一 SHA。
 */
function resolveShas(shas: readonly string[]): Map<string, ShaVerdict> {
  const unique = [...new Set(shas)];
  const verdicts = new Map<string, ShaVerdict>();
  if (unique.length === 0) return verdicts;
  const input = unique.map((sha) => `${sha}^{commit}`).join("\n") + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    let stdout: string;
    try {
      stdout = execFileSync("git", ["cat-file", "--batch-check"], {
        input,
        encoding: "utf8",
        cwd: REPO_ROOT,
      });
    } catch {
      continue; // 环境问题，重试一次
    }
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    // 输出必须与输入逐行对得上；对不齐说明这次判定不可信，当作环境问题重试，
    // 而不是硬把某一行的结果安到某个 SHA 上。
    if (lines.length !== unique.length) continue;
    unique.forEach((sha, index) => {
      const line = lines[index] ?? "";
      verdicts.set(sha, line.endsWith(" missing") ? "missing" : "resolves");
    });
    return verdicts;
  }
  for (const sha of unique) verdicts.set(sha, "unavailable");
  return verdicts;
}

/**
 * 把一次 git 失败分类。**抽成纯函数是为了能单测判别本身**——真实语料里 `unavailable`
 * 分支一次都不会走到（它只在 git 抖动时出现），不抽出来就只能靠人读代码确认「exit 1 才算
 * 账本缺陷」这条判据没写反。写反的后果是：把环境抖动当成账本缺陷报出去。
 */
function classifyGitFailure(error: unknown): "missing" | "retryable" {
  // `git rev-parse --verify --quiet <不存在对象>` → exit 1，无输出：对象确实不存在。
  // 其余一切（exit 128、spawn EAGAIN、被杀）都是环境问题，与账本内容无关。
  return (error as { status?: number }).status === 1 ? "missing" : "retryable";
}

function shaVerdict(sha: string, attempt = 0): ShaVerdict {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      stdio: "ignore",
      cwd: REPO_ROOT,
    });
    return "resolves";
  } catch (error) {
    if (classifyGitFailure(error) === "missing") return "missing";
    // 其余（exit 128 / spawn 失败）= 环境问题，重试一次再放弃。
    if (attempt < 1) return shaVerdict(sha, attempt + 1);
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// 断言四：规范文档里 file:line 的行号落在目标文件范围内
// ---------------------------------------------------------------------------

interface LineRef {
  readonly doc: string;
  readonly line: number;
  /** 引用的目标文件，按文档所在目录解析。 */
  readonly file: string;
  readonly targetLine: number;
}

const FILE_LINE_REF = /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|md|json)):(\d+)\b/g;

function extractLineRefs(doc: DocEntry): LineRef[] {
  // 只掩围栏：`src/foo.ts:12` 这种引用就写在行内代码里，掩掉行内代码等于把引用全灭掉。
  const masked = maskFencedCode(doc.text);
  const refs: LineRef[] = [];
  for (const match of masked.matchAll(FILE_LINE_REF)) {
    const targetLine = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(targetLine)) continue;
    refs.push({
      doc: doc.rel,
      line: lineAt(masked, match.index),
      file: match[1] ?? "",
      targetLine,
    });
  }
  return refs;
}

const NORMATIVE_LINE_REFS: readonly LineRef[] = NORMATIVE_DOCS.flatMap(extractLineRefs);

/**
 * 被 git 跟踪的文件，按 basename 建的索引。只在第三个基准里用作消歧候选。
 */
function trackedByBasename(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: REPO_ROOT })
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    // 拿不到 git 索引时索引为空 → 第三个基准不生效 → 行为退回本文件修复前的状态，
    // 即那类简写引用不被校验（漏），而不是误判（红）。宁可漏不可猜。
    return index;
  }
  for (const rel of files) {
    const key = basename(rel);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [rel]);
    else bucket.push(rel);
  }
  return index;
}

const TRACKED_BY_BASENAME: ReadonlyMap<string, readonly string[]> = trackedByBasename();

/**
 * 第三个基准：仓库内**唯一**同名文件的绝对路径；不存在或不唯一都返回 null。
 *
 * 单独抽成纯函数是因为它有一条真实语料打不到的防御分支：全仓只有 `.gitignore` 与 `README.md`
 * 两个重名 basename，而它们都恰好能被「仓库根」这个更早的基准解析到，所以没有任何真实引用会
 * 落进歧义分支。不抽出来，这条分支就只能靠人读代码确认它对——而它恰恰是「宁可漏不可猜」这条
 * 纪律的落点，值得有自己的单测。
 */
function uniqueTrackedMatch(file: string): string | null {
  const sameName = TRACKED_BY_BASENAME.get(basename(file));
  if (sameName === undefined || sameName.length !== 1) return null;
  const unique = join(REPO_ROOT, sameName[0] ?? "");
  return existsSync(unique) && !statSync(unique).isDirectory() ? unique : null;
}

/**
 * 引用目标是否解析到本仓内的真实文件。仓库外的（DSH 宿主 / node_modules）不在校验面。
 *
 * 三个候选基准，缺一不可：
 *   1. 按文档所在目录解析 —— `../agents/domain.md` 这种同仓相对写法；
 *   2. 按仓库根解析 —— `src/runtime/limits.ts` 这种仓库根相对写法；
 *   3. 全仓**唯一同名**文件 —— `render.ts:145` 这种只有 basename 的简写。
 * 前两条是文档里一直都在用的两种写法，只认一种会把整类引用漏出校验面（缺第 2 条时
 * 反事实是绿的，见交付记录）。第 3 条是本轮补的**盲点**：ADR-0013 §6 的七处引用写的
 * 就是 `render.ts:145` 这种形态，前两个基准双双落空，引用就此静默逃出校验面 —— 行号漂移
 * 也不会有任何东西变红。接进第 3 条之后，那七处第一次真的在被检查。
 *
 * 第 3 条要求 basename 在全仓**唯一**。不唯一时不接：本仓只有 `.gitignore` 与 `README.md`
 * 两个重名，那种写法本身就是该改成全路径的信号，宁可漏也不猜——猜错会把一条正确引用
 * 报成越界，比不校验更糟。
 */
function inRepoTarget(ref: LineRef): string | null {
  const candidates = [
    resolve(dirname(join(REPO_ROOT, ref.doc)), ref.file),
    resolve(REPO_ROOT, ref.file),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) continue;
    return candidate;
  }
  return uniqueTrackedMatch(ref.file);
}

/**
 * 找出行号越界的仓库内引用。单独抽成函数是为了让样例单测能直接喂合成语料：
 * 全称断言与反事实走同一条判定，反事实因此证明的是真逻辑，不是「恰好没跑到」。
 */
function outOfRangeLineRefs(refs: readonly LineRef[]): string[] {
  const offenders: string[] = [];
  for (const ref of refs) {
    const absolute = inRepoTarget(ref);
    if (absolute === null) continue;
    const total = countLines(absolute);
    if (ref.targetLine < 1 || ref.targetLine > total) {
      offenders.push(
        `${ref.doc}:${ref.line} -> ${ref.file}:${ref.targetLine}（该文件只有 ${total} 行）`,
      );
    }
  }
  return offenders;
}

function countLines(absolute: string): number {
  return readFileSync(absolute, "utf8").split("\n").length;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("doc 语料：抽取面本身非空（防恒真的第一道门）", () => {
  test("语料覆盖 docs/** 与仓库根三份文档，且下界成立", () => {
    expect(
      ALL_DOCS.length,
      "markdown 文件数下界（防止 docs/ 改名后语料为空）",
    ).toBeGreaterThanOrEqual(MARKDOWN_FILE_FLOOR);
    expect(NORMATIVE_DOCS.length, "规范文档数必须非零，否则行号与符号断言全空转").toBeGreaterThan(
      0,
    );
    expect(
      SNAPSHOT_DOCS.length,
      "历史快照必须被识别出来（行号断言刻意不覆盖它们）",
    ).toBeGreaterThan(0);
    expect(SOURCE_TEXT.length, "src/ 语料为空会让符号断言恒真").toBeGreaterThan(1000);
    expect(
      ALL_DOCS.filter((doc) => doc.text === ""),
      "空文档会让行号/链接断言漏扫",
    ).toEqual([]);
    expect(
      ALL_DOCS.filter((doc) => !doc.rel.endsWith(".md")),
      "语料里只该有 .md",
    ).toEqual([]);
    // 链接面必须覆盖 research / reviews：链接 404 在快照里同样是缺陷，与行号会不会漂是两回事。
    expect(
      ALL_DOCS.filter((doc) => doc.rel.startsWith("docs/research/")).length,
      "链接断言必须覆盖 docs/research/**",
    ).toBeGreaterThan(0);
    expect(ROOT_DOCS.filter((rel) => !ALL_DOCS.some((doc) => doc.rel === rel))).toEqual([]);
  });
});

describe("断言一：文档里的相对链接指向的文件必须存在", () => {
  test("抽取器非空：相对链接数下界 + 快照文档也在扫描面里", () => {
    expect(ALL_LINKS.length, "相对链接数下界（防止掩码把链接全灭掉）").toBeGreaterThanOrEqual(
      LINK_FLOOR,
    );
    const snapshotLinks = ALL_LINKS.filter((ref) => isSnapshot(ref.doc));
    expect(
      snapshotLinks.length,
      "docs/research 与 docs/reviews 里的链接同样要校验",
    ).toBeGreaterThan(0);
  });

  test("口径守卫：没有裸的相对链接目标（统一用 ./ 或 ../ 前缀）", () => {
    // 裸目标（](foo.md)）本文件不解析。不静默吞掉：要么解析它，要么要求作者补前缀。
    // 写「先看看再说」式的提前返回在这里是错的 —— 直接报出来。
    const unprefixed = ALL_LINKS.filter(
      (ref) => !ref.target.startsWith("./") && !ref.target.startsWith("../"),
    );
    expect(
      unprefixed.map(formatRef),
      "相对链接必须以 ./ 或 ../ 开头，否则本守卫无法判定它指向本仓内还是站外",
    ).toEqual([]);
  });

  test("全量相对链接的目标文件都存在（链接 404 即缺陷）", () => {
    const broken = collectBrokenLinks(ALL_DOCS);
    expect(
      broken.map(formatRef),
      `以下相对链接的目标文件不存在：\n${broken.map((ref) => `  ${formatRef(ref)}`).join("\n")}`,
    ).toEqual([]);
    const resolvedCount = ALL_LINKS.length - broken.length;
    expect(resolvedCount, "可解析链接数下界").toBeGreaterThanOrEqual(LINK_FLOOR);
    console.log(
      `[doc-integrity] 相对链接 ${resolvedCount}/${ALL_LINKS.length} 可解析（全量 docs/** + 仓库根三份）`,
    );
  });

  test("反事实：合成的坏链接必须被报出，好的链接必须不被报出", () => {
    // 约束 #5：把语料换成明显错误但格式合法的版本，同一套判定必须区分得开。
    // 样本形态取自本仓真实写法：docs/adr/README.md 链接同目录 ADR。
    const synthetic: DocEntry[] = [
      {
        rel: "docs/adr/README.md",
        absolute: join(REPO_ROOT, "docs/adr/README.md"),
        text: [
          "行内代码不是链接：",
          "",
          '``tools["pi.dispatch"](args)``',
          "",
          "```ts",
          "const x = 1;",
          "```",
          "",
          "[好的](./0002-source-strategy.md)",
          "[坏的](./0000-does-not-exist.md)",
          "[带锚点的好链接](../agents/domain.md#词条)",
        ].join("\n"),
      },
    ];
    const broken = collectBrokenLinks(synthetic);
    expect(
      broken.map((ref) => ref.target),
      "只有那条指向不存在文件的链接该被报出",
    ).toEqual(["./0000-does-not-exist.md"]);
    expect(broken[0]?.line, "报出行号要能让人直接跳过去改").toBe(10);
    // 反向：真实语料里 ADR 索引的链接必须全部可解析，证明上面不是「扫描器坏了」。
    const adrIndex = ALL_DOCS.filter((doc) => doc.rel === "docs/adr/README.md");
    expect(collectBrokenLinks(adrIndex), "docs/adr/README.md 的索引链接必须全部可解析").toEqual([]);
  });
});

describe("断言二：规范文档点名的具名符号在 src/ 有读点（doc-sync 必查 2）", () => {
  const DECLARED: readonly SymbolRef[] = SYMBOL_SCAN_DOCS.flatMap(extractDeclaredSymbols);
  const distinctNames: readonly string[] = [...new Set(DECLARED.map((ref) => ref.name))].sort();
  const missingNames: readonly string[] = distinctNames.filter(
    (name) => !SOURCE_TEXT.includes(name),
  );

  test("抽取器非空：符号面下界 + 扫描面确实排除了工具流程文档", () => {
    expect(
      distinctNames.length,
      "通过形态过滤的具名 token 数下界（防止掩码或形态正则失效让断言空转）",
    ).toBeGreaterThanOrEqual(SYMBOL_TOKEN_FLOOR);
    expect(SYMBOL_SCAN_DOCS.length, "符号扫描面非空").toBeGreaterThan(0);
    // 口径必须真的生效：AGENTS.md 与 docs/agents/** 是评审工具/流程文档，其词表属 ocr 与 GitHub API。
    const scanned = new Set(SYMBOL_SCAN_DOCS.map((doc) => doc.rel));
    expect(scanned.has("AGENTS.md"), "AGENTS.md 不在符号扫描面（理由见文件头）").toBe(false);
    expect(
      DECLARED.filter((ref) => ref.doc.startsWith("docs/agents/")).map((ref) => ref.name),
      "docs/agents/** 不在符号扫描面",
    ).toEqual([]);
    // 但它们仍在链接扫描语料里：AGENTS.md 与 docs/agents/** 今天一条 markdown 链接都没有
    // （路径都写在行内代码里，不是链接），所以这里断言的是「在语料里」而不是「有链接」。
    expect(
      ALL_DOCS.map((doc) => doc.rel),
      "AGENTS.md 与 docs/agents/** 仍在链接扫描语料里",
    ).toEqual(expect.arrayContaining(["AGENTS.md", "docs/agents/ocr-rules.md"]));
  });

  test("规范文档点名的每个具名符号都能在 src/ 找到", () => {
    const unexplained = missingNames.filter((name) => !EXTERNAL_VOCABULARY.has(name));
    const report = unexplained.map((name) => {
      const first = DECLARED.find((ref) => ref.name === name);
      return `  ${first?.doc ?? "?"}:${first?.line ?? 0}  ${name}`;
    });
    expect(
      unexplained,
      `以下符号在规范文档里被点名，但 src/ 里找不到，且不在 EXTERNAL_VOCABULARY 排除清单里：\n${report.join("\n")}\n` +
        "处置：要么 src/ 真删了（订正文档），要么文档写错了（改文档），要么它确实是外部符号（补进排除清单并写明理由）。",
    ).toEqual([]);
    const found = distinctNames.length - unexplained.length;
    expect(
      found,
      `在 src/ 有读点的具名符号数下界（实测 ${found}/${distinctNames.length}）`,
    ).toBeGreaterThanOrEqual(SYMBOL_TOKEN_FLOOR);
    console.log(
      `[doc-integrity] 规范文档具名符号 ${found}/${distinctNames.length} 在 src/ 有读点，` +
        `${EXTERNAL_VOCABULARY.size} 个外部词汇走显式排除清单`,
    );
  });

  test("排除清单不会无声膨胀：没有一项在本仓变成真实存在", () => {
    // 排除清单自己是新的漂移源：某个名字将来真进了 src/，它就该从清单里删掉而不是继续被豁免。
    const becameReal = [...EXTERNAL_VOCABULARY.keys()].filter((name) => SOURCE_TEXT.includes(name));
    expect(
      becameReal,
      `这些排除项现在在 src/ 里真实存在了，请从 EXTERNAL_VOCABULARY 里删掉：${becameReal.join(" / ")}`,
    ).toEqual([]);
  });

  test("排除清单不会无声膨胀：没有一项已经是死条目", () => {
    // 文档里没人再提的名字，继续留在清单里只会让清单越攒越长、越攒越掏空守卫。
    // ALL_SCANNED_NAMES 在模块作用域构建一次（语料只在 import 时读一遍），本用例只做
    // O(清单大小) 的过滤 —— 否则每个用例各扫一遍全量文档，语料一大就会顶穿默认超时，
    // 而把预算放宽到几百倍又会让真正的回归测不出来。
    const dead = [...EXTERNAL_VOCABULARY.keys()].filter((name) => !ALL_SCANNED_NAMES.has(name));
    expect(dead, `这些排除项在全量文档里已经没人再提了，请删掉：${dead.join(" / ")}`).toEqual([]);
    // 清单条目必须各自带理由，否则「显式清单」退化成「一串名字」。
    const missingReason = [...EXTERNAL_VOCABULARY].filter(([, reason]) => reason.trim().length < 4);
    expect(
      missingReason.map(([name]) => name),
      "每条排除都必须写明为什么",
    ).toEqual([]);
  });

  test("反事实：伪造一个不存在的符号名必须被报出", () => {
    // 样本形态照抄 ADR-0023 的真实写法（ownerPid 是 doc-sync 必查 2 点名的符号）。
    const synthetic: DocEntry[] = [
      {
        rel: "docs/adr/0023-background-task-ownership.md",
        absolute: join(REPO_ROOT, "docs/adr/0023-background-task-ownership.md"),
        text: [
          "The record carries `ownerPidZzzNotARealSymbol` so the owner is recoverable.",
          "`lost_on_session_restart` 是真实存在的状态字符串。",
        ].join("\n"),
      },
    ];
    const names = synthetic.flatMap(extractDeclaredSymbols).map((ref) => ref.name);
    expect(names, "两个 token 都该被抽出：形态过滤只认声明形态，不认语义").toEqual([
      "ownerPidZzzNotARealSymbol",
      "lost_on_session_restart",
    ]);
    const missing = names.filter((name) => !SOURCE_TEXT.includes(name));
    expect(missing, "只有伪造的那个被判为 src/ 里没有：真实状态字符串必须通过").toEqual([
      "ownerPidZzzNotARealSymbol",
    ]);
    expect(SOURCE_TEXT.includes("lost_on_session_restart"), "真实状态字符串必须在 src/ 里").toBe(
      true,
    );
  });
});

describe("断言三：docs/reviews 账本里的 commit SHA 必须能被 git 解析（doc-sync 必查 6）", () => {
  const distinctShas: readonly string[] = [...new Set(REVIEW_SHAS.map((ref) => ref.sha))].sort();

  test("口径：纯十进制串不算 SHA（日期 / 时间戳），且账本里确有可校验的 SHA", () => {
    // 实测：docs/reviews/ 里一条 40 位完整 SHA 都没有，全是 7 位短 SHA。
    // 所以「只认 40 位」的口径会让这条断言恒真空转（约束 #5 要防的正是这个），
    // 口径因此定为「7–40 位、含至少一个十六进制字母」，并把实测基线写进下界。
    const fullSha = distinctShas.filter((sha) => sha.length === 40);
    expect(
      fullSha.length,
      `40 位完整 SHA 数量：${fullSha.length}。若将来账本改用完整 SHA，这条会记录变化，不影响 7 位短 SHA 的校验`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      REVIEW_SHAS.length,
      `账本里 SHA 出现次数下界（实测 ${REVIEW_SHAS.length}）`,
    ).toBeGreaterThanOrEqual(SHA_OCCURRENCE_FLOOR);
    expect(
      distinctShas.length,
      `唯一 SHA 数下界（实测 ${distinctShas.length}）`,
    ).toBeGreaterThanOrEqual(SHA_UNIQUE_FLOOR);
    expect(
      REVIEW_SHAS.filter((ref) => ALL_DECIMAL.test(ref.sha)),
      "纯十进制串已按口径排除，不该出现在候选里",
    ).toEqual([]);
    // 被排除的假阳性必须真的存在于账本里，否则这条口径就是在防一个不存在的东西。
    const reviewText = REVIEW_DOCS.map((doc) => doc.text).join("\n");
    expect(reviewText).toContain("20260929");
    expect(reviewText).toContain("1469918176385");
  });

  // 环境问题与文档缺陷必须分开：浅克隆里旧 commit 的对象不在本地，解析失败不代表账本写错。
  test.skipIf(!gitReady)("账本引用的每个 commit SHA 都能被 git 解析", (ctx) => {
    // 一次 git 调用判定全部 SHA（去重后 31 个），不是每个 SHA 一次 spawn。
    const bySha = resolveShas(REVIEW_SHAS.map((ref) => ref.sha));
    const verdicts = REVIEW_SHAS.map((ref) => ({
      ref,
      verdict: bySha.get(ref.sha) ?? "unavailable",
    }));
    // git 判定不了（重试后仍失败）时显式 SKIP，**不报成账本缺陷**：那会让一次环境抖动
    // 伪装成「账本记错了 commit」，引诱人去改一条没坏的账本行。
    const undecided = verdicts.filter((item) => item.verdict === "unavailable");
    if (undecided.length > 0) {
      ctx.skip(
        `git 在重试后仍无法判定 ${undecided.length} 个 SHA（环境问题，非账本缺陷）：` +
          undecided.map((item) => item.ref.sha).join(", "),
      );
    }
    const unresolved = verdicts.filter((item) => item.verdict === "missing").map((i) => i.ref);
    const seen = new Map<string, ShaRef>();
    for (const ref of unresolved) seen.set(`${ref.sha}@${ref.doc}`, ref);
    const report = [...seen.values()].map((ref) => `  ${ref.doc}:${ref.line}  ${ref.sha}`);
    expect(
      unresolved.map((ref) => `${ref.doc}:${ref.line} ${ref.sha}`),
      `账本里的 SHA 无法被 git 解析（要么 commit 不存在，要么账本记错了）：\n${report.join("\n")}`,
    ).toEqual([]);
    const resolvedCount = REVIEW_SHAS.length - unresolved.length;
    expect(
      resolvedCount,
      `可解析 SHA 出现次数下界（实测 ${resolvedCount}/${REVIEW_SHAS.length}）`,
    ).toBeGreaterThanOrEqual(SHA_OCCURRENCE_FLOOR);
    console.log(
      `[doc-integrity] 账本 commit SHA ${resolvedCount}/${REVIEW_SHAS.length} 可解析（${distinctShas.length} 个唯一值）`,
    );
  });

  test("git 失败的分类：只有 exit 1 算账本缺陷，其余都是环境问题", () => {
    // 这条判据写反的后果是把一次环境抖动报成「账本记错了 commit」，引诱人去改一条没坏的
    // 账本行。真实语料里 unavailable 分支一次都走不到，所以直接测纯函数。
    expect(classifyGitFailure({ status: 1 }), "exit 1 = 对象不存在 = 账本缺陷").toBe("missing");
    expect(classifyGitFailure({ status: 128 }), "exit 128 = git 自己的错 = 环境问题").toBe(
      "retryable",
    );
    expect(classifyGitFailure(new Error("spawnSync git EAGAIN")), "spawn 失败没有 status").toBe(
      "retryable",
    );
    expect(classifyGitFailure(new Error("killed")), "被信号杀死也没有 status").toBe("retryable");
  });

  test.skipIf(!gitReady)("反事实：把一个真实 commit SHA 改一位后必须解析失败", () => {
    // 约束 #5：证明上面那条断言不是「git 调用恒成功」的空转。
    const real = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    }).trim();
    const flipped = `${real.slice(0, 39)}${real.slice(39, 40) === "0" ? "1" : "0"}`;
    expect(flipped, "构造出的 SHA 必须与真实值不同").not.toBe(real);
    expect(shaVerdict(real), "真实 commit 必须可解析").toBe("resolves");
    expect(shaVerdict(flipped), "改一位的 SHA 必须解析失败").toBe("missing");
    expect(shaVerdict(real) === "unavailable", "真实 commit 不该落进环境问题分支").toBe(false);
  });

  test.skipIf(!gitReady)("批量判定与单条判定必须一致（68 次 spawn 换 1 次不能换了语义）", () => {
    // `resolveShas()` 是为了消掉 5 秒超时面（每个 SHA 一次 spawn -> 一次 batch-check）而引入的
    // 优化。优化最容易出的错是「快了但判得不一样」，所以这里把两条路径钉在一起。
    const real = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    }).trim();
    const flipped = `${real.slice(0, 39)}${real.slice(39, 40) === "0" ? "1" : "0"}`;
    // 真实语料的全部唯一 SHA：批量判定不得出现 missing / unavailable。
    const corpus = resolveShas([...new Set(REVIEW_SHAS.map((ref) => ref.sha))]);
    expect(corpus.size, "去重后的唯一 SHA 数下界").toBeGreaterThanOrEqual(SHA_UNIQUE_FLOOR);
    expect(
      [...corpus.values()].filter((verdict) => verdict !== "resolves"),
      "账本里的唯一 SHA 在批量路径下也必须全部 resolves",
    ).toEqual([]);
    // 混在真实 SHA 里一起判：顺序不能影响结论，missing 的那一个必须被单独标出来。
    const mixed = resolveShas([real, flipped, real]);
    expect(mixed.get(real), "重复传入同一个 SHA 不得影响判定").toBe("resolves");
    expect(mixed.get(flipped), "不存在的 SHA 在批量路径下必须是 missing").toBe("missing");
    // 单条路径独立复核一次，两条路径必须给同样的答案。
    expect(shaVerdict(real)).toBe(mixed.get(real));
    expect(shaVerdict(flipped)).toBe(mixed.get(flipped));
  });
});

describe("断言四：规范文档里 file:line 的行号落在目标文件行数内", () => {
  const inRepo: readonly LineRef[] = NORMATIVE_LINE_REFS.filter(
    (ref) => inRepoTarget(ref) !== null,
  );

  test("抽取器非空：规范文档里的 file:line 引用数下界", () => {
    // 这条断言存在的历史原因值得留下：接手时以为规范文档里一条 file:line 都没有，
    // 于是把全称断言写成「待命」（当时只按文档所在目录解析基准，漏掉了仓库根相对写法）。
    // 反事实一做就发现 ADR-0013 §5 有一条 `src/tools/render.ts:78`，待命说法当场作废。
    // 教训落到代码上：**「没有」必须用会失败的方式表达，不能用「没有就跳过」** ——
    // 抽取器一坏（语料空了、掩码失效、正则改坏、基准解析漏了一种写法），
    // 这条下界立刻红，「暂时没有」与「抽取器坏了」因此在测试里可区分。
    expect(
      NORMATIVE_LINE_REFS.length,
      `规范文档 file:line 引用数下界（实测 ${NORMATIVE_LINE_REFS.length}）`,
    ).toBeGreaterThanOrEqual(LINE_REF_FLOOR);
    expect(NORMATIVE_DOCS.length, "规范文档非空").toBeGreaterThan(0);
    // 账本：in-repo 与 out-of-repo 必须相加等于总数，抽取过程不许悄悄丢引用。
    const outRepo = NORMATIVE_LINE_REFS.length - inRepo.length;
    expect(outRepo, "仓库外引用数 = 总数 - 仓库内引用数").toBeGreaterThanOrEqual(0);
    console.log(
      `[doc-integrity] 规范文档 file:line 引用 ${NORMATIVE_LINE_REFS.length} 处，` +
        `其中指向本仓内可校验的 ${inRepo.length} 处（其余指向 DSH 宿主 / node_modules，不在本仓校验面）`,
    );
  });

  test("仓库内引用清单是钉住的基线：新增一条就要有人重新确认一次", () => {
    // 实测基线（2026-09-29 复核并扩到第三条解析基准之后）：规范文档（README / CONTEXT / adr /
    // specs / usage）里 15 处 file:line，其中 8 处指向 DSH 宿主文件（ChatGroupSeat.tsx、ToolRow.tsx、
    // ToolCallTree.tsx、ToolCall.tsx、interactive-mode.js、bash.js）与 node_modules 里的 dist 产物，
    // 本仓根本没跟踪，留在校验面外是对的；指向本仓的是 8 处 —— 1 处全路径写法加 7 处 `render.ts:N`
    // 简写。**那 7 处简写在本轮之前根本不在校验面内**（见下方逐条核对记录），守卫看上去覆盖了
    // file:line，实际一直在漏它们。
    //
    // 逐条核对记录（2026-09-29，Lead 手工核对 render.ts 每一行，不是照抄 ADR 的说法）：
    //   78   MAX_CODE_LINES_EXPANDED=3 起的八个常量定义段 —— §5 引的 78-85 属实
    //   127  alignRow()（定义在 125）里「无 meta 直接截断」那条分支 —— 失败行只 push left、
    //        没有 right，所以走的正是这一条，不是 129/130 那两条
    //   145  firstLine() 体内 apply MAX_ERROR_CHARS 的那一行
    //   693  errorText() 体内 return firstLine(...)
    //   834  折叠态 failed: ${errorText(result)} 的那一行
    //   925  「The failure text is the reason the reader expanded the row at all」注释
    //   928  展开态 ?? errorText(result) 的 fallback（仅当 result 无 text block 时才走）
    //   930  .slice(0, MAX_LOG_LINES_EXPANDED) 的切行
    // 钉清单的意义：有人新增一条仓库内引用时这条会红，届时要么核对行号后更新基线，
    // 要么把引用改成指明基准的写法。清单因此是一道「人看一眼」的闸，而不是死代码。
    expect(
      inRepo.map((ref) => `${ref.doc}:${ref.line} -> ${ref.file}:${ref.targetLine}`),
      "仓库内 file:line 引用基线变了。新增/删除引用后请逐条核对行号，再更新这份基线。",
      // 2026-09-29 第一次复核：ADR-0013 §6 插入 85 行后，这条引用从 135 行位移到 140 行，已核对属实。
      // 2026-09-29 第二次复核（补第三条解析基准之后）：7 处 `render.ts:N` 简写第一次进入校验面，
      // 逐条核对记录见上方注释。**这七条此前是盲区**——现在才真的在被检查。
    ).toEqual([
      "docs/adr/0013-ptc-row-compact-summary.md:140 -> src/tools/render.ts:78",
      "docs/adr/0013-ptc-row-compact-summary.md:174 -> render.ts:145",
      "docs/adr/0013-ptc-row-compact-summary.md:174 -> render.ts:693",
      "docs/adr/0013-ptc-row-compact-summary.md:174 -> render.ts:834",
      "docs/adr/0013-ptc-row-compact-summary.md:176 -> render.ts:928",
      "docs/adr/0013-ptc-row-compact-summary.md:177 -> render.ts:930",
      "docs/adr/0013-ptc-row-compact-summary.md:178 -> render.ts:127",
      "docs/adr/0013-ptc-row-compact-summary.md:182 -> render.ts:925",
      // Hand-confirmed line by line, 2026-09-30 (review round 5). The extractor resolves this
      // one only because the path is qualified: bare `dispatcher.ts` is ambiguous in this repo, and
      // the rule is to refuse rather than guess. Line 438 is
      // `const dispatchSlots = new DispatchSlotCounter(config.dispatchConcurrency);` -- the FALLBACK
      // counter, since :712 prefers `options.dispatchDeps?.slots ?? dispatchSlots`. ADR-0016 §2
      // names it as where the knob is read when nothing is injected.
      "docs/adr/0016-ptc-dispatch-binding.md:39 -> src/runtime/dispatcher.ts:438",
    ]);
  });

  test("盲点回归：只有 basename 的简写引用也能解析到本仓（第三条基准）", () => {
    // 这条测试是 2026-09-29 补的。ADR-0013 §6 的七处引用写的是 `render.ts:145` 这种形态，
    // 前两个基准（文档目录、仓库根）双双落空，于是它们**静默逃出校验面**：行号漂到 9999
    // 也不会有任何东西变红。守卫看上去覆盖 file:line，实际长期在漏这一整类。
    // 真实语料取自 ADR-0013 §6 的写法，不是构造的。
    const bare = extractLineRefs({
      rel: "docs/adr/0013-ptc-row-compact-summary.md",
      absolute: join(REPO_ROOT, "docs/adr/0013-ptc-row-compact-summary.md"),
      text: "the failure text is `render.ts:145` and `render.ts:99999`",
    });
    expect(bare.map((ref) => ref.file)).toEqual(["render.ts", "render.ts"]);
    // 解析到全仓唯一的同名文件，而不是落空。
    expect(inRepoTarget(bare[0]!)).toBe(join(REPO_ROOT, "src/tools/render.ts"));
    // 反事实：行号越界必须被抓到。修复前这条引用根本进不了判定面，outOfRangeLineRefs 会返回 []。
    expect(outOfRangeLineRefs([bare[1]!])).toEqual([
      "docs/adr/0013-ptc-row-compact-summary.md:1 -> render.ts:99999" +
        `（该文件只有 ${countLines(join(REPO_ROOT, "src/tools/render.ts"))} 行）`,
    ]);
  });

  test("同名歧义时不接第三条基准：宁可漏不可猜", () => {
    // 猜错会把一条正确引用报成越界 —— 那比不校验更糟，因为它会让人去改一条没坏的引用。
    // 本仓只有两个 basename 重名：`.gitignore` 与 `README.md`，且两者都能被「仓库根」这个
    // 更早的基准解析到，所以**没有任何真实引用会落进歧义分支**。直接测纯函数。
    expect(uniqueTrackedMatch("render.ts"), "唯一同名要接进来").toBe(
      join(REPO_ROOT, "src/tools/render.ts"),
    );
    expect(uniqueTrackedMatch("src/tools/render.ts"), "带路径的同样按 basename 命中唯一项").toBe(
      join(REPO_ROOT, "src/tools/render.ts"),
    );
    expect(uniqueTrackedMatch("README.md"), "重名必须返回 null 而不是随便挑一个").toBe(null);
    expect(uniqueTrackedMatch(".gitignore"), "重名必须返回 null").toBe(null);
    expect(uniqueTrackedMatch("ToolCallTree.tsx"), "本仓没跟踪的外部文件不接").toBe(null);
    expect(uniqueTrackedMatch("nonexistent.ts"), "不存在的 basename 不接").toBe(null);
  });

  test("指向本仓的引用：行号落在目标文件行数内", () => {
    const offenders = outOfRangeLineRefs(inRepo);
    expect(offenders, `行号越界的引用：\n${offenders.join("\n")}`).toEqual([]);
    // 非恒真信号：上面这条全称断言必须真的在判定至少一条引用，否则它与「没有引用」不可区分。
    expect(
      inRepo.length,
      "指向本仓的引用数下界（抽取口径一改就可能塌成 0，塌了这条断言就退化成空转）",
    ).toBeGreaterThan(0);
  });

  test("样例单测：判定逻辑对真实形态的文本片段有牙（不是死代码）", () => {
    // 样本形态取自本仓真实引用：ADR-0020 写 ChatGroupSeat.tsx:117。
    const samples: readonly LineRef[] = extractLineRefs({
      rel: "docs/adr/0020-ptc-row-pulse.md",
      absolute: join(REPO_ROOT, "docs/adr/0020-ptc-row-pulse.md"),
      text: "Rendered in DSH's row (`ToolRow.tsx:212,222,226` and `ChatGroupSeat.tsx:117`).",
    });
    // 一个行号跨度 `ToolRow.tsx:212,222,226` 抽三条：后两个逗号后的裸数字不带文件名，判定面只认
    // `<file>:<line>` 形态，所以这里取首条 212 —— 这正是真实语料里的行为。
    expect(
      samples.map((ref) => `${ref.file}:${ref.targetLine}`),
      "抽取器要按 <file>:<line> 逐个抽出，且不把逗号后的裸数字当引用",
    ).toEqual(["ToolRow.tsx:212", "ChatGroupSeat.tsx:117"]);
    const first = samples[0];
    expect(first && inRepoTarget(first), "该样本指向 DSH 宿主文件，因此不在本仓校验面内").toBe(
      null,
    );

    // 合成指向本仓真实文件的引用：范围内与越界各一条，喂给**全称断言用的同一个判定函数**。
    // 走同一条路径，反事实证明的才是真逻辑 —— 不是「恰好没跑到那段代码」。
    const srcFile = "src/runtime/limits.ts";
    const total = countLines(join(REPO_ROOT, srcFile));
    const inRange: LineRef = { doc: "README.md", line: 1, file: srcFile, targetLine: total };
    const outOfRange: LineRef = { doc: "README.md", line: 1, file: srcFile, targetLine: total + 1 };
    expect(inRepoTarget(inRange), `${srcFile} 必须在本仓内`).not.toBe(null);
    expect(inRepoTarget(outOfRange), "越界引用的目标文件本身仍存在").not.toBe(null);
    expect(outOfRangeLineRefs([inRange]), "范围内的样本不得被报出").toEqual([]);
    expect(outOfRangeLineRefs([outOfRange]), "越界的样本必须被报出，且带出真实行数").toEqual([
      `README.md:1 -> ${srcFile}:${total + 1}（该文件只有 ${total} 行）`,
    ]);
    // 两条一起喂：只报越界那条，不误伤范围内那条。
    expect(outOfRangeLineRefs([inRange, outOfRange])).toHaveLength(1);
    // 零行下界：真实文件不止一行，样本才有意义。
    expect(total, `${srcFile} 的行数下界`).toBeGreaterThan(10);
  });
});
