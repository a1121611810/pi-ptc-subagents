#!/usr/bin/env node
// 变异门禁（ADR-0029）：每条 mutant 必须被杀死，且**杀死它的用例就是 registry 里 kills 指定的那条**。
//
// 与旧 scripts/mutation-check.mjs 的差别（也就是本轮重写的全部理由）：
//   ① 归属核对——旧脚本只问「红了没有」，别的用例红也算杀死（假杀死）；这里读 Vitest 的 JSON
//      报告，按 failed 的 fullName 匹配 kills，对不上 = 假杀死 = 不计杀、判红。
//   ② 锚点唯一性——旧脚本用 split/join 全量替换；这里要求 from 在目标文件里恰好出现一次。
//   ③ 能力矩阵完整性——孤儿探针（不在登记表里）= 红；每条能力至少一条 mutant。
//
// 速度（2026-11-14 实测：快腿四面 96 条 326s → 74s，快 4.4 倍）——三处砍的都是「不碰判定」的开销：
//   ④ 基线每份探针文件只跑一次（能力 56 条 ⇒ 文件只有 16 份；按能力跑会让同一份文件重复跑几十次）。
//   ⑤ 每条变异只跑 kills 指定的那一条用例——归属判定只看「那条红没红」，与整文件跑等价；
//      那条没红就回退整文件（「真存活」与「假杀死」的诊断需要别的用例的失败信息）。
//      前提：探针的用例彼此独立（每条自己备料）⇒ 单跑与合跑同结果。
//   ⑥ 不经 pnpm exec / pnpm --filter：bin 路径从包 manifest 解析；收窄重建跑包自己的 build 脚本
//      （逐字节等价已由 --check-narrow 验过：7 个包通过）。
//
// 还原用内存里的原文写回——**不用 git checkout**：仓里有并行会话的未提交改动，不能误伤。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { capabilitiesFor, problemsFor } = await import(join(ROOT, "tests", "registry.mjs"));

// 直接调 bin，不经 pnpm exec：每条变异都要起一次探针进程，pnpm 的启动开销（≈0.2s）
// × 100 多次就是半分钟。bin 路径从包自己的 manifest 解析，跟着版本走。
const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const rootBin = join(ROOT, "node_modules", ".bin");

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("-"));
const jsonOut = args.includes("--json");
const checkNarrow = args.includes("--check-narrow");

const run = (cmd, argv, opts = {}) =>
  spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", ...opts });

// ── 收窄重建（ADR-0029 §1.6 的执行模型） ────────────────────────────
// 别名图实测结论：
//   entry   内联 dispatch/output/ptc/routes/search/task/tui 的 src；
//   kimi-mcp 内联 output/ptc/routes/search/tui 的 src；
//   output/search/task 的 dist 反过来把 tui（task 还有 dispatch/routes）的 dist 打进自己的 bundle。
// ⇒ 改 packages/tui ⇒ tui/entry/kimi-mcp 之外，output/search/task 的 dist 也要重出（它们内联 tui 的 dist）。
// ADR-0027 记过「只重建 tui ⇒ 变异冒烟误判」——所以这张图缺一条就等于重演那次事故。
const BUILD_ORDER = ["dispatch", "routes", "tui", "output", "search", "task", "entry", "kimi-mcp"];
const INLINERS = {
  dispatch: ["entry"],
  output: ["entry", "kimi-mcp"],
  ptc: ["entry", "kimi-mcp"],
  routes: ["entry", "kimi-mcp"],
  search: ["entry", "kimi-mcp"],
  task: ["entry"],
  tui: ["entry", "kimi-mcp"],
};
const DIST_CONSUMERS = {
  dispatch: ["task"],
  routes: ["task"],
  tui: ["output", "search", "task"],
};

function narrowTargets(pkg) {
  const targets = new Set([pkg]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [dep, consumers] of Object.entries(DIST_CONSUMERS)) {
      if (!targets.has(dep)) continue;
      for (const consumer of consumers) {
        if (!targets.has(consumer)) {
          targets.add(consumer);
          grew = true;
        }
      }
    }
  }
  for (const inliner of INLINERS[pkg] ?? []) targets.add(inliner);
  return BUILD_ORDER.filter((p) => targets.has(p));
}

function buildPackages(pkgs) {
  for (const pkg of pkgs) {
    // 跑包自己的 build 脚本（内容逐字照抄，含 tui/entry/kimi-mcp 的「先清 dist」那一步），
    // 只把 pnpm 的启动开销省掉——脚本本身与 `pnpm --filter … run build` 完全一致。
    const dir = join(ROOT, "packages", pkg);
    const script = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.build;
    const r = run("sh", ["-c", script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${rootBin}:${join(dir, "node_modules", ".bin")}:${process.env.PATH}`,
      },
    });
    if (r.status !== 0) throw new Error(`构建 ${pkg} 失败：\n${r.stdout}\n${r.stderr}`);
  }
  if (pkgs.includes("kimi-mcp")) assembleKimi();
}

function assembleKimi() {
  const r = run("node", ["scripts/assemble-kimi.mjs"]);
  if (r.status !== 0) throw new Error(`assemble-kimi 失败：\n${r.stdout}\n${r.stderr}`);
}

function buildAll() {
  const r = run("pnpm", ["run", "build"]);
  if (r.status !== 0) throw new Error(`构建失败：\n${r.stdout}\n${r.stderr}`);
  assembleKimi();
}

/**
 * 站点产物：website 面的判据读的是**构建后**的站点（dist/index.html）⇒ 全量跑（--all）
 * 必须先有它。根 build 脚本刻意排除了 website（`--filter=!@pi-ptc/website`）⇒ 这里补上。
 */
function buildSite() {
  const dir = join(ROOT, "packages", "website");
  const r = run("pnpm", ["run", "build"], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${rootBin}:${join(dir, "node_modules", ".bin")}:${process.env.PATH}`,
    },
  });
  if (r.status !== 0) throw new Error(`站点构建失败：\n${r.stdout}\n${r.stderr}`);
}

/** 产物指纹：目录 → 相对路径 → 内容哈希（收窄 vs 全量的逐字节等价校验用） */
function fingerprint() {
  const out = new Map();
  for (const dir of [
    "packages/entry/dist",
    "packages/kimi-mcp/dist",
    "packages/tui/dist",
    "packages/output/dist",
    "packages/search/dist",
    "packages/task/dist",
    "packages/dispatch/dist",
    "packages/routes/dist",
    "release/kimi",
  ]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of walk(base)) {
      const rel = entry.slice(ROOT.length + 1);
      const buf = readFileSync(entry);
      out.set(rel, createHash("sha256").update(buf).digest("hex"));
    }
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 一次性等价校验（ADR-0029 §1.6 的安全阀）：窄重建产物必须与根构建产物逐字节一致 */
function checkNarrowEquivalence(packages) {
  const bad = [];
  for (const pkg of packages) {
    buildPackages(narrowTargets(pkg));
    const narrow = fingerprint();
    buildAll();
    const full = fingerprint();
    for (const [file, hash] of narrow) {
      if (full.get(file) !== hash) bad.push(`${pkg} → ${file}`);
    }
    for (const file of full.keys()) {
      if (!narrow.has(file)) bad.push(`${pkg} → ${file}（根构建多出）`);
    }
  }
  if (bad.length > 0) {
    console.error("收窄重建与根构建产物不一致（ADR-0029 §1.6 安全阀触发 ⇒ 退回全量根构建）：");
    for (const line of bad) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`收窄重建逐字节等价校验通过：${packages.length} 个包`);
}

if (checkNarrow) {
  checkNarrowEquivalence(Object.keys(INLINERS));
  process.exit(0);
}

/**
 * 跑一批探针文件，返回失败用例的 fullName 列表（+ 每份文件的失败清单，供诊断）。
 *
 * `crashed` 单列「文件级崩溃」：import 失败、语法错这类问题在 Vitest 报告里是
 * `testResults[].status === "failed"` 且 `assertionResults` 为 0 条——一条断言都没跑。
 * 不单列的话它会混进 `failed`（空数组）⇒ 门禁把「探针没跑起来」读成「探针没抓住缺陷」。
 */
function runProbes(files, nameFilter) {
  const outDir = mkdtempSync(join(tmpdir(), "ptc-mutate-json-"));
  const report = join(outDir, "out.json");
  const argv = [vitestBin, "run", ...files, "--reporter=json", `--outputFile=${report}`];
  if (nameFilter) argv.push("-t", nameFilter);
  const r = run("node", argv);
  if (!existsSync(report)) {
    // 过滤没命中任何用例时可能不写报告——当「没红」处理，调用方会回退整文件再判
    if (nameFilter) return { failed: [], perFile: [], crashed: [] };
    throw new Error(`探针 ${files.join(", ")} 没产出 JSON 报告：\n${r.stdout}\n${r.stderr}`);
  }
  const data = JSON.parse(readFileSync(report, "utf8"));
  const failed = [];
  const perFile = [];
  const crashed = [];
  for (const file of data.testResults ?? []) {
    const names = [];
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") {
        const name = assertion.fullName ?? assertion.title ?? "";
        failed.push(name);
        names.push(name);
      }
    }
    // 文件级崩溃：一条断言都没跑起来（import 失败 / 语法错）
    if (names.length === 0 && file.status === "failed") {
      crashed.push(file.name);
      perFile.push({ file: file.name, failed: ["（文件级崩溃：一条用例都没跑起来）"] });
      continue;
    }
    if (names.length > 0) perFile.push({ file: file.name, failed: names });
  }
  return { failed, perFile, crashed };
}

/**
 * kills 唯一性核对：归属判定用子串匹配（failed 名 includes kills）⇒ 若同文件里两条用例名
 * 都含这个子串，「红的那条」未必是 kills 指的那条 ⇒ 归属判定会张冠李戴。
 * 判据：kills 在它的探针文件里必须**恰好**匹配一条用例名。
 */
function killsMatches(m) {
  const probe = join(ROOT, m.probe);
  if (!existsSync(probe)) return [];
  const src = readFileSync(probe, "utf8");
  const titles = [...src.matchAll(/it\(\s*([\x60'"])([\s\S]*?)\1\s*,/g)].map((x) => x[2]);
  return titles.filter((t) => t.includes(m.kills));
}

// 兜底还原：脚本中途崩了也不能把仓留在变异态
const pending = new Map();
function restoreAll() {
  for (const [file, original] of pending) {
    try {
      writeFileSync(file, original);
    } catch {
      // 进程正在退出，写不回去也没别的办法——但至少不吞
    }
  }
}
process.on("exit", restoreAll);

// 选择面：--capability <能力 id> / --capability <面名> / --all（全部八面）/ 默认快腿四面（CI 能跑的那四面）
const allFaces = args.includes("--all");
function selectCapabilities() {
  if (only) {
    const byFace = capabilitiesFor(only);
    if (byFace.length > 0) return { caps: byFace, scope: only };
    const byId = capabilitiesFor("all").filter((c) => c.id === only);
    if (byId.length === 0) {
      console.error(`没有这条能力也没有这个面：${only}`);
      process.exit(1);
    }
    return { caps: byId, scope: byId[0].face };
  }
  if (allFaces) return { caps: capabilitiesFor("all"), scope: "all" };
  return { caps: capabilitiesFor("fast"), scope: "fast" };
}
const { caps: selected, scope } = selectCapabilities();
const problems = problemsFor(scope);
if (problems.length > 0) {
  console.error("登记表自检不通过（能力矩阵完整性 / 锚点唯一性）：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const mutants = selected.flatMap((c) =>
  (c.mutants ?? []).map((m) => ({ ...m, capability: c.id, probe: c.probe })),
);
if (mutants.length === 0) {
  console.error(`能力 ${selected[0].id} 没有登记 mutant——能力矩阵完整性判红`);
  process.exit(1);
}

console.log(`变异清单 ${mutants.length} 条 · 能力 ${selected.length} 条\n`);

console.log("基线：未变异时探针必须全绿（红的原因是变异还是本来就红，要分清）");
buildAll();
// website 面的判据读构建后的站点 ⇒ 选到它就得先有产物（根 build 刻意不含 website）
if (selected.some((c) => c.face === "website")) buildSite();
// 一份探针文件只跑一次（能力 56 条 ⇒ 探针文件 16 份；旧写法是每条能力跑一遍，同一份文件被重复跑了几十次）。
// ⚠️ 标了 alone 的探针必须**单独跑**：站点反事实 harness 会对真实工作树取摘要（性质 4：跑完必须与
// 跑之前逐字节相同），别的探针并发写工作树就会让它红——并行跑过一次，基线就是这么红的（2026-11-14）。
const aloneProbes = [...new Set(selected.filter((c) => c.alone).map((c) => c.probe))];
const groupProbes = [...new Set(selected.filter((c) => !c.alone).map((c) => c.probe))];
for (const [label, probes] of [
  ["（并行）", groupProbes],
  ...aloneProbes.map((p) => [`${p}（单独）`, [p]]),
]) {
  if (probes.length === 0) continue;
  const { failed, perFile, crashed } = runProbes(probes);
  if (crashed.length > 0) {
    console.error(`✗ 基线里探针文件跑不起来：${label}`);
    for (const f of crashed)
      console.error(`  - ${f}（import 失败 / 语法错——不是「没红」，是探针没跑起来）`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`✗ 基线不绿：${label}`);
    for (const f of perFile) console.error(`  - ${f.file}：${f.failed.join(" | ")}`);
    process.exit(1);
  }
}
console.log("  基线全绿\n");

const killed = [];
const survived = [];
for (const m of mutants) {
  const abs = join(ROOT, m.file);
  const original = readFileSync(abs, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    survived.push({
      ...m,
      why: `锚点在 ${m.file} 出现 ${hits} 次（必须恰好 1 次）——源码变了，变异清单该更新`,
    });
    console.log(`  ? ${m.id}（锚点失效）`);
    continue;
  }
  // kills 唯一性：必须恰好匹配一条用例名——0 条（kills 写错）或多条（子串撞车）都判红
  const matched = killsMatches(m);
  if (matched.length !== 1) {
    survived.push({
      ...m,
      why:
        `kills「${m.kills}」在 ${m.probe} 里匹配 ${matched.length} 条用例名（必须恰好 1 条）` +
        (matched.length === 0 ? "——kills 指定的用例不存在" : "——子串撞车，归属判定会张冠李戴"),
    });
    console.log(`  ? ${m.id}（kills 匹配 ${matched.length} 条用例名）`);
    continue;
  }
  const pkg = m.file.split("/")[1] ?? "";
  const targets = INLINERS[pkg] ? narrowTargets(pkg) : null;
  writeFileSync(abs, original.replace(m.from, m.to));
  pending.set(abs, original);
  try {
    if (targets) buildPackages(targets);
    else buildAll();
    // 判定用**整文件跑**的结果：单跑（-t 只跑 kills 那条）会让同文件其它用例不执行，
    // 而本仓探针有共享状态（dispatch.test.ts 84 条共用假时钟与 keepAlives）⇒ 单跑时那条
    // 用例可能红得「不是被这条变异杀死的」。整文件跑一次即可同时回答「红没红」与「红的
    // 是不是 kills 指定的那条」，不必先单跑再回退（那会多付一次探针进程）。
    const probeResult = runProbes([m.probe]);
    const { failed, crashed } = probeResult;
    if (crashed.length > 0) {
      // 探针文件自己跑不起来（import 失败 / 语法错）⇒ 这条变异「杀不死」，但原因不是判据弱
      survived.push({
        ...m,
        why: `探针文件跑不起来（${crashed.join(", ")}）——变异后探针崩了，不是判据没抓住`,
      });
      console.log(`  ✗ ${m.id} 探针崩溃——变异后探针没跑起来`);
      continue;
    }
    if (failed.length === 0) {
      survived.push(m);
      console.log(`  ✗ ${m.id} 存活——探针没抓住这个缺陷：${m.why}`);
    } else if (!failed.some((name) => name.includes(m.kills))) {
      survived.push({
        ...m,
        why: `假杀死：红了的是别的用例（${failed.join(" | ")}），不是 kills 指定的「${m.kills}」——${m.why}`,
      });
      console.log(`  ✗ ${m.id} 假杀死——红的是别的用例`);
    } else {
      killed.push(m);
      console.log(`  ✓ ${m.id} 被杀死（${m.why}）`);
    }
  } catch (error) {
    survived.push({ ...m, why: `变异无效（构建或探针跑不起来）：${error.message}` });
    console.log(`  ? ${m.id} 变异无效：${error.message}`);
  } finally {
    writeFileSync(abs, original);
    pending.delete(abs);
  }
}

buildAll();

const report = {
  killed: killed.map((m) => ({ id: m.id, capability: m.capability, why: m.why })),
  survived: survived.map((m) => ({ id: m.id, capability: m.capability, why: m.why })),
};
if (jsonOut) {
  const outPath = join(ROOT, ".vitest", "mutations.json");
  mkdirSync(join(ROOT, ".vitest"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n报告：${outPath}`);
}

console.log(`\n结果：杀死 ${killed.length} / ${mutants.length} · 存活 ${survived.length}`);
if (survived.length > 0) {
  console.error("存活 = 假绿（探针没验到那个行为）：");
  for (const m of survived) console.error(`  - ${m.id}：${m.why}`);
  process.exit(1);
}
