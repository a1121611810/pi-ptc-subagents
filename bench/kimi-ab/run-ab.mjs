// Kimi 面引导 A/B 执行器：双臂（git 提交 → 独立 worktree 构建 bundle → 换装插件）× 题集 × n 轮
// 安全：换装前备份现装插件，结束（含异常）必还原；--arm A|B、--tasks a,b、c、--n N 可局部跑
// 用法: node bench/kimi-ab/run-ab.mjs [--arm A] [--tasks batch-read,anti-small] [--n 3]
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENCH = join(ROOT, "bench/kimi-ab");
const PLUGIN_DIR = join(
  process.env.HOME ?? "",
  ".kimi-code/plugins/managed/ptc-tools/release/kimi",
);
const ARMS = {
  A: "ef09ddb",
  B: "cf1d8b2", // A+检查表+经济学 footer
  C: "cbf3fc9", // B+工具全名桥+write 绑定（五件套）
};
const RUN_TIMEOUT_MS = 8 * 60 * 1000;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const arms = arg("arm", "A,B").split(",");
const taskFilter = arg("tasks", "") ? arg("tasks", "").split(",") : null;
const n = Number(arg("n", "3"));
const tasks = readdirSync(join(BENCH, "tasks")).filter(
  (d) => !taskFilter || taskFilter.includes(d),
);
const resultsPath = join(BENCH, "results.jsonl");

// 1) 夹具（幂等）
execFileSync(process.execPath, [join(BENCH, "gen-fixture.mjs")], { stdio: "inherit" });

// 2) 每臂 bundle：/tmp 独立 worktree（不污染本仓）→ pnpm install → build:kimi
function buildArm(arm) {
  const wt = join(tmpdir(), `kimi-ab-src-${arm}`);
  const bundle = join(wt, "release/kimi");
  if (existsSync(join(bundle, "server.js"))) {
    console.log(`[arm ${arm}] 复用已有 bundle`);
    return bundle;
  }
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(wt, { recursive: true });
  const tar = spawnSync("git", ["archive", ARMS[arm]], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tar.status !== 0) throw new Error(`git archive ${ARMS[arm]} 失败`);
  const untar = spawnSync("tar", ["-x", "-C", wt], { input: tar.stdout });
  if (untar.status !== 0) throw new Error("tar 解包失败");
  console.log(`[arm ${arm}] worktree 源码就绪（${ARMS[arm]}）`);
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: wt, stdio: "inherit" });
  // 必须先全量构建 workspace 依赖包（@pi-ptc/* 的 dist 指向源码树内，缺了 rolldown 会把它们
  // 当 external 外置——运行时 installed 插件目录无 node_modules，MCP server 直接起不来，
  // 2026-10-31 首跑 36 轮全踩此坑：wire 里 0 个 tools_discovered，采用率假 0）
  execFileSync("pnpm", ["run", "build"], { cwd: wt, stdio: "inherit" });
  execFileSync("pnpm", ["run", "build:kimi"], { cwd: wt, stdio: "inherit" });
  return bundle;
}

// 3) 备份插件 + 换装
const backup = join(tmpdir(), `kimi-ab-plugin-backup-${process.pid}`);
cpSync(PLUGIN_DIR, backup, { recursive: true });
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
  cpSync(backup, PLUGIN_DIR, { recursive: true });
  console.log("[plugin] 已还原原装");
}
process.on("exit", restore);
function swap(bundle) {
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
  cpSync(bundle, PLUGIN_DIR, { recursive: true });
}

// 4) 单轮跑题：新鲜夹具副本 + 无头 kimi --auto -p；从 wire.jsonl 解析工具采用
function runOnce(arm, task, i) {
  const runDir = join(tmpdir(), `kimi-ab-run-${arm}-${task}-${i}`);
  rmSync(runDir, { recursive: true, force: true });
  cpSync(join(BENCH, "fixture"), runDir, { recursive: true });
  const prompt = readFileSync(join(BENCH, "tasks", task, "prompt.md"), "utf8");
  const t0 = Date.now();
  spawnSync("kimi", ["-p", prompt], {
    cwd: runDir,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env },
  });
  const wallMs = Date.now() - t0;
  // 会话定位不靠 stdout：Kimi 把 workspace 目录名小写化，按 mtime 取最新 wire
  const wires = globSync(
    `${process.env.HOME}/.kimi-code/sessions/wd_${basename(runDir).toLowerCase()}_*/session_*/agents/main/wire.jsonl`,
  )
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const wire = wires[0]?.p ?? null;
  const resume = /session_([0-9a-f-]+)/.exec(wire ?? "")?.[0] ?? null;
  const counts = {};
  let toolCalls = 0;
  let ptcToolsListed = false;
  if (wire) {
    for (const line of readFileSync(wire, "utf8").split("\n")) {
      if (line.includes("mcp.tools_discovered") && line.includes("ptc_run_code")) {
        ptcToolsListed = true;
      }
      if (!line.includes('"type":"tool.call"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.event?.type !== "tool.call") continue;
        toolCalls++;
        counts[e.event.name] = (counts[e.event.name] ?? 0) + 1;
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  const ptc = Object.entries(counts)
    .filter(([k]) => /ptc_run_code/.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const webds = Object.entries(counts)
    .filter(([k]) => /web_ds_search/.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const builtinSearch = (counts.WebSearch ?? 0) + (counts.FetchURL ?? 0);
  const g = spawnSync(process.execPath, [join(BENCH, "tasks", task, "grade.mjs"), runDir], {
    encoding: "utf8",
  });
  const row = {
    arm,
    task,
    run: i,
    wallMs,
    sessionId: resume,
    wire: !!wire,
    ptcToolsListed,
    toolCalls,
    ptcCalls: ptc,
    webdsCalls: webds,
    builtinSearch,
    ptcUsed: ptc > 0,
    grade: g.status === 0 ? "PASS" : "FAIL",
    gradeOut: (g.stdout ?? "").trim().split("\n").pop() ?? "",
  };
  writeFileSync(resultsPath, JSON.stringify(row) + "\n", { flag: "a" });
  if (!ptcToolsListed)
    throw new Error(
      `[${arm}/${task}#${i}] 该会话 wire 里没有 ptc 工具的 tools_discovered——插件没起来，结果无效，中止`,
    );
  console.log(
    `[${arm}/${task}#${i}] ${row.grade} ptc=${ptc} webds=${webds} builtinSearch=${builtinSearch} calls=${toolCalls} ${(wallMs / 1000) | 0}s`,
  );
  rmSync(runDir, { recursive: true, force: true });
}

// 5) 主循环（每次完整跑清空结果文件，避免历史冒烟数据污染汇总）
writeFileSync(resultsPath, "");
try {
  for (const arm of arms) {
    swap(buildArm(arm));
    console.log(`[arm ${arm}] 插件已换装`);
    for (const task of tasks) for (let i = 1; i <= n; i++) runOnce(arm, task, i);
  }
} finally {
  restore();
}

// 6) 汇总 + 验收判据
const rows = readFileSync(resultsPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => arms.includes(r.arm));
const byArm = (arm, pred) => rows.filter((r) => r.arm === arm && pred(r));
for (const arm of arms) {
  const expPtc = byArm(arm, (r) => ["batch-read", "batch-edit", "grep-aggregate"].includes(r.task));
  const anti = byArm(arm, (r) => ["anti-small", "anti-bash"].includes(r.task));
  const adopt = expPtc.filter((r) => r.ptcUsed).length;
  const pass = rows.filter((r) => r.arm === arm && r.grade === "PASS").length;
  console.log(
    `臂 ${arm}: 期望形态题采用 ${adopt}/${expPtc.length}，过度触发 ${anti.filter((r) => r.ptcUsed).length}/${anti.length}，判分 PASS ${pass}/${rows.filter((r) => r.arm === arm).length}`,
  );
}
console.log("明细见 bench/kimi-ab/results.jsonl");
