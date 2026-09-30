/**
 * config 读点 source-scan fixture —— 兑现 `.opencodereview/rules/ptc-config-wiring.md` 第 7 条：
 * 「每次新增 config 键，必须配一条 source-scan fixture，断言每个 config 键在 `src/` 有读点」。
 *
 * 为什么需要机器防线（本规则第 2 条列举的「不算接线证据」形态）：
 * 缺席的读点不在 diff 里，逐行评审永远撞不见「这个键没人读」。本 fixture 把三块承诺面
 * 变成可执行断言：
 *   1. `DEFAULT_CONFIG` 的每个键（账本基线 15 键）；
 *   2. `BUILTIN_BINDING_NAMES` 的每个工具名（账本基线 7 个）；
 *   3. `WORKER_ENV_ALLOW_LIST` 的每个环境变量名（账本基线 6 个）。
 *
 * 抽取规则（为什么这么抽，见文末「已知局限」）：
 * - 语料只含生产代码：递归 src 下的 .ts 文件，不含 `tests/`（规则第 2 条：只有测试引用不算接线）；
 * - 去掉注释再匹配：键名只写在 JSDoc 里不算读点（本仓 `limits.ts` 的注释密度极高，
 *   不去注释会让全称断言被注释喂饱，恒为绿）；
 * - 排除声明处：声明文件里只有**声明语句结束行之后**的行才算读点。这同时挡掉
 *   `PtcConfig` 接口字段声明、`DEFAULT_CONFIG` 字面量、`BUILTIN_BINDING_NAMES` 数组元素
 *   ——规则第 2 条把这些全部列为「不算接线证据」；
 * - 只认标识符出现（`config.foo` / `const { foo } = config` / 字符串字面量 `"foo"`），
 *   不断言值流入了哪条行为。
 *
 * 期望值的独立来源：键名一律来自导出的常量（`Object.keys(DEFAULT_CONFIG)` /
 * `BUILTIN_BINDING_NAMES` / `WORKER_ENV_ALLOW_LIST`），测试里**不硬编码任何一个键名** ——
 * 硬编码会变成新的漂移源。断言本身是不变量：「没有键缺读点」。
 *
 * 已知局限（必须随本文件一起读）：
 * 守卫证明「有读取语法」，不证明「值流入承诺行为」（`ptc-config-wiring.md` 原文告诫）。
 * 具体三条：
 *   a) 命中一个同名局部变量也算（例如 `worker-main.ts` 里的 `const write = ...`），
 *      所以本 fixture 只报「有读点」，不报「这个读点兑现了哪条行为」；
 *   b) 读点可能在非生产路径上（备份 / 回放 / 迁移），identifier 匹配区分不了；
 *   c) 数据驱动的消费形态（遍历常量 + `source[name]`）根本没有逐名标识符，
 *      `WORKER_ENV_ALLOW_LIST` 就是这种形态，见该 describe 的说明。
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { BUILTIN_BINDING_NAMES } from "../src/runtime/bindings.ts";
import { createWorkerEnv, DEFAULT_CONFIG, WORKER_ENV_ALLOW_LIST } from "../src/runtime/limits.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const LIMITS_FILE = join(SRC_DIR, "runtime", "limits.ts");
const BINDINGS_FILE = join(SRC_DIR, "runtime", "bindings.ts");

/**
 * 数量下界（规则第 7 条要求：命中集合非空 + 有下界，否则这条防线本身就是 silent failure）。
 * 取自 `.opencodereview/rules/ptc-config-wiring.md` 的承诺面基线表，刻意用「下界」而不是
 * 「精确值」：承诺面变大时本 fixture 不该红，红的应该是「新增的键没接线」这件事本身。
 */
const CONFIG_KEY_FLOOR = 15;
const BINDING_NAME_FLOOR = 7;
const ENV_NAME_FLOOR = 6;
const PRODUCTION_FILE_FLOOR = 20;

/** 扫描命中的一处读点。 */
interface ReadPoint {
  readonly file: string;
  readonly line: number;
}

/** 声明点：声明文件 + 声明常量的名字。声明体本身永远不算读点。 */
interface DeclarationSite {
  readonly file: string;
  readonly constName: string;
}

/** 扫描目标：`label` 用来报错，`source` 是匹配用的正则源码。 */
interface ScanTarget {
  readonly label: string;
  readonly source: string;
}

/** 标识符形态：`config.foo` / `const { foo } = config` / 字符串字面量 `"foo"` 都能命中。 */
function identifierTarget(label: string): ScanTarget {
  return { label, source: `\\b${label}\\b` };
}

/** 调用形态：`createWorkerEnv(...)`，用来区分「只是 import 了」和「真的调用了」。 */
function callTarget(label: string): ScanTarget {
  return { label, source: `${label}\\s*\\(` };
}

type SourceMode = "code" | "line-comment" | "block-comment" | "string";

interface MaskedSource {
  /** 注释已屏蔽、字符串字面量内容保留 —— 用于匹配标识符。 */
  readonly code: string;
  /** 注释与字符串字面量内容都屏蔽 —— 用于括号配平（定位声明区间）。 */
  readonly structural: string;
}

/**
 * 单趟扫描同时产出两种掩码，行数与原文件严格一致（命中行号才对得上）。
 *
 * 已知局限：模板字符串里的 `${ ... }` 插值不再做嵌套词法分析，插值内部的引号 / 括号会被当作
 * 字面量内容处理。本 fixture 用到的三个声明体（`DEFAULT_CONFIG` / `WORKER_ENV_ALLOW_LIST` /
 * `BUILTIN_BINDING_NAMES`）都不含带括号的插值，所以不影响声明区间定位。
 */
function maskSource(source: string): MaskedSource {
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
    // 在 structural 变体里屏蔽（引号内的括号不该参与声明区间的配平）。
    // 两个变体都与原文逐字符等长，命中行号才对得上。
    code += char;
    structural += char === "\n" ? "\n" : " ";
  }
  return { code, structural };
}

/** 递归列出生产代码文件：`.ts`，排除 `.d.ts` 与构建 / 依赖目录。 */
function listProductionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 语料：文件绝对路径 -> 原始源码。 */
function buildCorpus(files: readonly string[]): Map<string, string> {
  const corpus = new Map<string, string>();
  for (const file of files) corpus.set(file, readFileSync(file, "utf8"));
  return corpus;
}

function countMatches(line: string, pattern: RegExp): number {
  return (line.match(pattern) ?? []).length;
}

/**
 * 定位声明常量的结束行（1-based）。
 *
 * 找不到声明就抛错而不是返回一个默认值：语料路径写错 / 常量被改名时，抛错让测试红，
 * 静默返回 0 会把整个声明体算成读点，这条防线当场退化成恒真。
 */
function declarationEndLine(structural: string, constName: string): number {
  const lines = structural.split("\n");
  const declarationRe = new RegExp(`^\\s*export\\s+const\\s+${constName}\\b`);
  const start = lines.findIndex((line) => declarationRe.test(line));
  if (start < 0) {
    throw new Error(
      `声明常量 ${constName} 在语料里找不到：抽取器的「排除声明处」失效，或常量被改名。`,
    );
  }
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    depth += countMatches(line, /[([{]/g);
    depth -= countMatches(line, /[)\]}]/g);
    if (depth <= 0 && line.includes(";")) return i + 1;
  }
  throw new Error(`声明常量 ${constName} 的区间没有闭合：抽取器无法排除声明体。`);
}

/**
 * 对每个目标名找出读点。声明文件只统计声明结束行之后的行；其他文件整份统计。
 * 找不到任何读点的名字在返回值里是空数组 —— 这就是「报缺失」的能力所在。
 */
function findReadPoints(
  corpus: ReadonlyMap<string, string>,
  targets: readonly ScanTarget[],
  declaration: DeclarationSite,
): Map<string, ReadPoint[]> {
  const declarationSource = corpus.get(declaration.file);
  if (declarationSource === undefined) {
    throw new Error(
      `声明文件 ${declaration.file} 不在语料里：语料为空或路径写错，全称断言会静默恒真。`,
    );
  }
  const maskedFiles: { file: string; lines: string[] }[] = [];
  const structuralByFile = new Map<string, string>();
  for (const [file, source] of corpus) {
    const masked = maskSource(source);
    maskedFiles.push({ file, lines: masked.code.split("\n") });
    structuralByFile.set(file, masked.structural);
  }
  const declarationEnd = declarationEndLine(
    structuralByFile.get(declaration.file) ?? "",
    declaration.constName,
  );
  const found = new Map<string, ReadPoint[]>();
  for (const target of targets) {
    const pattern = new RegExp(target.source);
    const points: ReadPoint[] = [];
    for (const { file, lines } of maskedFiles) {
      // 声明体本身不是读点：声明文件从声明结束行的下一行开始算。
      const fromLine = file === declaration.file ? declarationEnd : 0;
      for (let i = fromLine; i < lines.length; i++) {
        if (!pattern.test(lines[i] ?? "")) continue;
        points.push({ file, line: i + 1 });
        break; // 每个文件只记首个读点
      }
    }
    found.set(target.label, points);
  }
  return found;
}

/** 没有读点的名字（断言的 right-hand side：空数组 = 全部接线）。 */
function missingLabels(
  targets: readonly ScanTarget[],
  found: ReadonlyMap<string, ReadPoint[]>,
): string[] {
  return targets
    .filter((target) => (found.get(target.label) ?? []).length === 0)
    .map((t) => t.label);
}

function hitCount(targets: readonly ScanTarget[], found: ReadonlyMap<string, ReadPoint[]>): number {
  return targets.filter((target) => (found.get(target.label) ?? []).length > 0).length;
}

function describeReadPoints(points: readonly ReadPoint[]): string {
  return points.map((point) => `${relative(REPO_ROOT, point.file)}:${point.line}`).join(", ");
}

const RAW_LINE_CACHE = new Map<string, readonly string[]>();

/** 取文件原文行（与 grep 看到的一致；缓存只为省掉重复 IO）。 */
function readRawLines(file: string): readonly string[] {
  const cached = RAW_LINE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const lines = readFileSync(file, "utf8").split("\n");
  RAW_LINE_CACHE.set(file, lines);
  return lines;
}

/**
 * 值读取形态：`config.<key>` / `DEFAULT_CONFIG.<key>` / `this.#config.<key>`。
 * 接收者大小写不敏感（`DEFAULT_CONFIG` 是全大写），键名本身保持大小写敏感。
 */
function valueReadPattern(name: string): RegExp {
  return new RegExp(`[cC][oO][nN][fF][iI][gG]\\s*\\??\\.\\s*${name}\\b`);
}

/**
 * 取「最强」的一处读点：优先 `config.<key>` 形态的值读取，其次才退到标识符出现。
 *
 * 为什么需要：同一个键名还可能出现在类型声明（`maxPendingCalls: number;`）或
 * 提示词字符串（`tools.read`）里。那些命中能证明「名字在代码里」，但证明不了
 * 「值被读走」。报错信息如果只报这种命中，人照着 grep 会落到一个没信息量的行上。
 *
 * 只对真实语料里的路径调用（合成语料的自检用例直接断言行号，不走这里）。
 */
function strongestHit(name: string, points: readonly ReadPoint[]): string {
  const read = points.find((point) =>
    valueReadPattern(name).test(readRawLines(point.file)[point.line - 1] ?? ""),
  );
  const chosen = read ?? points[0];
  if (chosen === undefined) return "（无）";
  return `${relative(REPO_ROOT, chosen.file)}:${chosen.line}`;
}

const CORPUS = buildCorpus(listProductionFiles(SRC_DIR));

// 键名一律来自导出的常量：唯一事实源在生产代码里，测试不复制第二份名单。
const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG);
const BINDING_NAMES: readonly string[] = BUILTIN_BINDING_NAMES;
const ENV_NAMES: readonly string[] = WORKER_ENV_ALLOW_LIST;

const CONFIG_DECLARATION: DeclarationSite = { file: LIMITS_FILE, constName: "DEFAULT_CONFIG" };
const BINDING_DECLARATION: DeclarationSite = {
  file: BINDINGS_FILE,
  constName: "BUILTIN_BINDING_NAMES",
};
const ENV_DECLARATION: DeclarationSite = {
  file: LIMITS_FILE,
  constName: "WORKER_ENV_ALLOW_LIST",
};

describe("config 读点 source-scan（ptc-config-wiring 第 7 条）", () => {
  test("语料只含生产代码：递归 src/**/*.ts，不含 tests/", () => {
    // 路径写错 / 目录改名会让语料为空，进而让全称断言静默恒真 —— 先把语料钉住。
    expect(CORPUS.size, "生产代码文件数下界（防止空语料恒真）").toBeGreaterThanOrEqual(
      PRODUCTION_FILE_FLOOR,
    );
    const testFiles = [...CORPUS.keys()].filter((file) => file.includes(`${sep}tests${sep}`));
    expect(testFiles, "测试里的引用不算接线（规则第 2 条），语料里不应出现 tests/").toEqual([]);
    // 声明文件必须在语料里，否则「排除声明处」无从谈起。
    expect(CORPUS.has(LIMITS_FILE), "声明文件 limits.ts 必须在语料里").toBe(true);
    expect(CORPUS.has(BINDINGS_FILE), "声明文件 bindings.ts 必须在语料里").toBe(true);
  });

  test("DEFAULT_CONFIG 的每个键都有生产读点", () => {
    const targets = CONFIG_KEYS.map(identifierTarget);
    const found = findReadPoints(CORPUS, targets, CONFIG_DECLARATION);
    const missing = missingLabels(targets, found);

    expect(
      CONFIG_KEYS.length,
      `DEFAULT_CONFIG 键数下界（账本基线 ${CONFIG_KEY_FLOOR} 键）`,
    ).toBeGreaterThanOrEqual(CONFIG_KEY_FLOOR);
    expect(found.size, "扫描器必须为每个键产出一条判定（判定数 = 键数）").toBe(CONFIG_KEYS.length);
    // 失败时逐键报出可 grep 的位置，并带上那一行原文，排查不用二次搜索。
    const report = CONFIG_KEYS.map(
      (key) => `${key.padEnd(28)} ${strongestHit(key, found.get(key) ?? [])}`,
    );
    expect(missing, `缺生产读点的 config 键：${missing.join(" / ")}\n${report.join("\n")}`).toEqual(
      [],
    );
    expect(hitCount(targets, found), "有读点的键数必须等于键数（规则第 7 条建议形态）").toBe(
      CONFIG_KEYS.length,
    );

    // 非恒真信号：键必须在声明文件之外被读到。若这个下界塌掉，说明「排除声明」几乎肯定空转了。
    const outsideDeclaration = CONFIG_KEYS.filter((key) =>
      (found.get(key) ?? []).some((point) => point.file !== LIMITS_FILE),
    );
    expect(
      outsideDeclaration.length,
      "在 limits.ts 之外被读到的 config 键数下界",
    ).toBeGreaterThanOrEqual(Math.ceil(CONFIG_KEYS.length / 2));
    console.log(
      `[config-read-points] DEFAULT_CONFIG ${CONFIG_KEYS.length}/${CONFIG_KEYS.length} 键有生产读点`,
    );
  });

  test("BUILTIN_BINDING_NAMES 的每个工具名都有生产消费点", () => {
    const targets = BINDING_NAMES.map(identifierTarget);
    const found = findReadPoints(CORPUS, targets, BINDING_DECLARATION);
    const missing = missingLabels(targets, found);

    expect(
      BINDING_NAMES.length,
      `builtin binding 名字数下界（账本基线 ${BINDING_NAME_FLOOR} 个）`,
    ).toBeGreaterThanOrEqual(BINDING_NAME_FLOOR);
    expect(found.size, "扫描器必须为每个名字产出一条判定").toBe(BINDING_NAMES.length);
    const report = BINDING_NAMES.map(
      (name) => `${name.padEnd(8)} ${strongestHit(name, found.get(name) ?? [])}`,
    );
    expect(
      missing,
      `缺生产消费点的 binding 名：${missing.join(" / ")}\n${report.join("\n")}`,
    ).toEqual([]);
    expect(hitCount(targets, found), "有消费点的 binding 名数必须等于名字数").toBe(
      BINDING_NAMES.length,
    );
    // 逐名的接线落在 BUILTIN_TOOL_FACTORIES 的 record key 上：createBuiltinBindings 按名字查工厂，
    // 查不到就抛 unknown PTC binding，所以那行 key 就是「这个名字真的被暴露成 binding」的证据。
    const factoryTableHits = BINDING_NAMES.filter((name) =>
      (found.get(name) ?? []).some((point) => point.file === BINDINGS_FILE),
    );
    expect(
      factoryTableHits.length,
      `每个 binding 名都应在 bindings.ts 的工厂表里有 key：${factoryTableHits.join(" / ")}`,
    ).toBe(BINDING_NAMES.length);
  });
});

/**
 * `WORKER_ENV_ALLOW_LIST` 是承诺面里唯一的「数据驱动」消费面，所以它的防线形态与上面两个不同。
 *
 * 实测（2026-09 复核）：6 个环境变量名在 `src/` 里的标识符出现次数是 **0** —— 它们只以字符串
 * 字面量的形式存在于 `WORKER_ENV_ALLOW_LIST` 的声明体内；消费方式是
 * `createWorkerEnv` 遍历名单 + `source[name]` 泛读。逐名做 identifier 扫描在这里只会得到
 * 「全称断言恒红」，而把匹配放宽成「声明体里出现过」就是规则要找的 silent failure
 * （绿灯 = 没扫到）。因此这一面用两条真实读点 + 真实函数行为来兑现：
 *   1. 名单常量本身在声明之后被消费（否则白名单形同虚设）；
 *   2. `createWorkerEnv()` 在 `limits.ts` 之外被生产路径真的调用（否则名单进不了 worker）；
 *   3. 每个名字逐个走一遍真实函数：非空值放行、空值与名单外丢弃。
 */
describe("WORKER_ENV_ALLOW_LIST 读点（数据驱动消费面）", () => {
  test("名单常量在声明之后被消费，且 createWorkerEnv 被生产路径调用", () => {
    const constantFound = findReadPoints(
      CORPUS,
      [identifierTarget("WORKER_ENV_ALLOW_LIST")],
      ENV_DECLARATION,
    );
    const constantPoints = constantFound.get("WORKER_ENV_ALLOW_LIST") ?? [];
    expect(
      constantPoints.length,
      `WORKER_ENV_ALLOW_LIST 必须有读点（只有声明 = 白名单形同虚设）：${describeReadPoints(constantPoints)}`,
    ).toBeGreaterThan(0);

    // 调用形态（而不是 import 形态）才算接线：import 只是门面（规则第 3 条）。
    const callFound = findReadPoints(CORPUS, [callTarget("createWorkerEnv")], ENV_DECLARATION);
    const callPoints = (callFound.get("createWorkerEnv") ?? []).filter(
      (point) => point.file !== LIMITS_FILE,
    );
    expect(
      callPoints.length,
      `createWorkerEnv() 必须在 limits.ts 之外被生产代码调用：${describeReadPoints(callPoints)}`,
    ).toBeGreaterThan(0);
  });

  test("名单里的每个名字都被 createWorkerEnv 逐个放行", () => {
    expect(
      ENV_NAMES.length,
      `白名单名字数下界（账本基线 ${ENV_NAME_FLOOR} 个）`,
    ).toBeGreaterThanOrEqual(ENV_NAME_FLOOR);
    // 逐名构造源环境：名字来自名单常量，测试里不复制第二份名单。
    const source: Record<string, string> = {};
    for (const name of ENV_NAMES) source[name] = `/fixture/${name}`;
    const env = createWorkerEnv(source);
    expect(Object.keys(env).sort(), "白名单里的每个名字都应被放行").toEqual([...ENV_NAMES].sort());
    for (const name of ENV_NAMES) {
      expect(env[name], `${name} 必须被原值放行`).toBe(`/fixture/${name}`);
    }
  });

  test("空值与名单外的名字被丢弃：白名单的失败路径不留静默通过", () => {
    // 诱饵取自真实世界：本仓与 DSH 宿主都会带 token，漏一个进 worker 就是凭据外泄。
    // 先钉住诱饵确实不在名单里，避免名单扩大后 fixture 悄悄失去意义。
    expect(ENV_NAMES, "诱饵名字必须不在白名单里").not.toContain("DEEPSEEK_API_KEY");
    const source: Record<string, string> = {};
    for (const name of ENV_NAMES) source[name] = "";
    source.DEEPSEEK_API_KEY = "sk-live-must-never-reach-a-ptc-worker";
    source.HOME = "/home/pi";
    expect(createWorkerEnv(source), "空值与名单外的名字都不应进入 worker 环境").toEqual({});

    for (const name of ENV_NAMES) source[name] = `set/${name}`;
    expect(
      Object.keys(createWorkerEnv(source)).sort(),
      "填上非空值后，仍只有白名单名字进入 worker 环境",
    ).toEqual([...ENV_NAMES].sort());
  });
});

/**
 * 抽取器自检。规则第 7 条的第二条防御：抽取逻辑必须能被一条故意的假阴性测到，
 * 否则无法区分「绿灯 = 有读点」与「绿灯 = 没扫到」。
 */
describe("抽取器自检：假阴性必须能被测到", () => {
  const SYNTHETIC_DECLARATION: DeclarationSite = { file: "decl.ts", constName: "DECLARED" };
  const DECLARATION_ONLY = `export const DECLARED = Object.freeze({
  zzzNeverReadConfigKey: 1,
});
const afterDeclaration = 1;
`;

  test("假键名 zzzNeverReadConfigKey 被报成 missing：声明体本身不算读点", () => {
    const target = identifierTarget("zzzNeverReadConfigKey");
    const declarationOnly = new Map([["decl.ts", DECLARATION_ONLY]]);
    const missing = missingLabels(
      [target],
      findReadPoints(declarationOnly, [target], SYNTHETIC_DECLARATION),
    );
    expect(missing, "只有声明体、没有读取的键必须被报成 missing").toEqual([
      "zzzNeverReadConfigKey",
    ]);

    // 同一份语料补一处真实读取后必须被检出：证明上一步不是「扫描器坏了」而是「真的没读点」。
    const withRead = new Map([
      ...declarationOnly,
      ["use.ts", "const value = config.zzzNeverReadConfigKey;\n"],
    ]);
    const points =
      findReadPoints(withRead, [target], SYNTHETIC_DECLARATION).get("zzzNeverReadConfigKey") ?? [];
    expect(points.length, "存在真实读取时必须命中").toBe(1);
    expect(points[0]?.file, "命中位置应指向读取所在文件").toBe("use.ts");
  });

  test("注释里的名字不算读点，字符串字面量形态算读点", () => {
    const corpus = new Map([
      ["decl.ts", "export const DECLARED = { a: 1 };\n"],
      [
        "use.ts",
        [
          "// zzzCommentOnlyKey 行注释",
          "/* zzzCommentOnlyKey 块注释 */",
          'const literal = config["zzzStringLiteralKey"];',
          "const plain = config.zzzCommentOnlyKey;",
          "",
        ].join("\n"),
      ],
    ]);
    const targets = [
      identifierTarget("zzzCommentOnlyKey"),
      identifierTarget("zzzStringLiteralKey"),
    ];
    const found = findReadPoints(corpus, targets, SYNTHETIC_DECLARATION);
    // 前两行是注释，必须被去注释挡掉，只剩第 4 行的真读点。
    expect((found.get("zzzCommentOnlyKey") ?? []).map((point) => point.line)).toEqual([4]);
    // 字符串字面量形态也是读点（第 3 行）——这是 fixture 明确支持的消费形态之一。
    expect((found.get("zzzStringLiteralKey") ?? []).map((point) => point.line)).toEqual([3]);
  });

  test("声明文件缺失或声明常量缺失时抛错，不静默恒真", () => {
    const target = identifierTarget("zzzNeverReadConfigKey");
    expect(
      () => findReadPoints(new Map(), [target], { file: "missing.ts", constName: "DECLARED" }),
      "语料里没有声明文件时必须抛错",
    ).toThrow(/声明文件/);
    expect(
      () =>
        findReadPoints(
          new Map([["decl.ts", "export const OTHER = 1;\n"]]),
          [target],
          SYNTHETIC_DECLARATION,
        ),
      "语料里没有声明常量时必须抛错",
    ).toThrow(/声明常量/);
  });

  test("反事实：语料退化成只剩声明文件时，同一条全称断言必须变红", () => {
    // 这是本 fixture 自身有牙的证据：把语料砍到只剩声明文件，用同一套断言重跑，
    // 「每个键都有读点」当场不成立。绿灯因此只能读作「扫到了并且每个键都接线了」。
    const onlyDeclaration = new Map([[LIMITS_FILE, readFileSync(LIMITS_FILE, "utf8")]]);
    const targets = CONFIG_KEYS.map(identifierTarget);
    const found = findReadPoints(onlyDeclaration, targets, CONFIG_DECLARATION);
    const missing = missingLabels(targets, found);
    expect(missing.length, `语料退化后必须报出缺失的键：${missing.join(" / ")}`).toBeGreaterThan(0);
    expect(hitCount(targets, found), "语料退化后命中数必须小于键数").toBeLessThan(
      CONFIG_KEYS.length,
    );
    // 说明：若哪天 15 个读点全部搬进 limits.ts，这两条会红。那不是脆弱 —— 那是守卫
    // 退化成「在声明文件里自证」的形态，值得重审而不是改断言。
  });
});
