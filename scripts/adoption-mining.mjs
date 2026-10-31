// 采用率基线挖掘：扫 ~/.kimi-code/server/events/*.jsonl，统计 ptc 插件工具采用与「错过的批量机会」
// 用法: node scripts/adoption-mining.mjs [eventsDir] [--since ISO]
// shortcut: 「错过机会」是同形态连续调用的启发式（≥5 记一次），探索式探针会误报，数字只当量级看
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir =
  args[0] && !args[0].startsWith("--") ? args[0] : `${process.env.HOME}/.kimi-code/server/events`;
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? Date.parse(args[sinceIdx + 1]) : 0;
const PTC = /mcp__plugin-ptc-tools.*__ptc_run_code/;
const WEBDS = /mcp__plugin-ptc-tools.*__web_ds_search/;

const shapeOf = (name, cmd) => {
  if (PTC.test(name)) return "ptc_run_code";
  if (WEBDS.test(name)) return "web_ds_search";
  if (name === "Bash") {
    return /^\s*(grep|rg|find|cat|head|tail|ls|wc|sed -n)\b|\|\s*(grep|head|tail|wc)\b/.test(
      cmd ?? "",
    )
      ? "Bash(shell-read)"
      : "Bash(other)";
  }
  if (name === "Grep" || name === "Read" || name === "Edit" || name === "Write" || name === "Glob")
    return name;
  return null; // 其他工具不参与同形态统计
};

let totals = {
  sessions: 0,
  sessionsWithPtc: 0,
  calls: 0,
  ptc: 0,
  webds: 0,
  webBuiltin: 0,
  missedRuns: 0,
  missedExcess: 0,
};
const rows = [];

for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  let counts = {};
  let seq = [];
  let createdAt = 0;
  try {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line).envelope ?? JSON.parse(line);
      } catch {
        continue;
      }
      if (e.kind === "journal_header") {
        createdAt = e.created_at ?? 0;
        continue;
      }
      if (e?.type !== "tool.call.started") continue;
      const name = e.payload?.name ?? "";
      counts[name] = (counts[name] ?? 0) + 1;
      const shape = shapeOf(name, e.payload?.args?.command);
      if (shape) seq.push(shape);
    }
  } catch {
    continue;
  }
  if (createdAt && createdAt < since) continue;
  // 同形态连续 ≥5 记一次「错过机会」，超出部分累计为 excess（本来可进一次程序）
  let runs = 0,
    excess = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) {
      let j = i;
      while (seq[j + 1] === seq[i]) j++;
      const len = j - i + 1;
      if (len >= 5 && seq[i] !== "ptc_run_code") {
        runs++;
        excess += len - 1;
      }
      i = j;
    }
  }
  const ptc = Object.entries(counts)
    .filter(([k]) => PTC.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const webds = Object.entries(counts)
    .filter(([k]) => WEBDS.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const webBuiltin = (counts.WebSearch ?? 0) + (counts.FetchURL ?? 0);
  const calls = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!calls) continue;
  totals.sessions++;
  if (ptc) totals.sessionsWithPtc++;
  totals.calls += calls;
  totals.ptc += ptc;
  totals.webds += webds;
  totals.webBuiltin += webBuiltin;
  totals.missedRuns += runs;
  totals.missedExcess += excess;
  rows.push({
    session: f.slice(8, 16),
    calls,
    ptc,
    webds,
    webBuiltin,
    missedRuns: runs,
    missedExcess: excess,
  });
}

rows.sort((a, b) => b.calls - a.calls);
console.log("session   calls  ptc  webds  webBuiltin  missedRuns  missedExcess");
for (const r of rows.slice(0, 20))
  console.log(
    [r.session, r.calls, r.ptc, r.webds, r.webBuiltin, r.missedRuns, r.missedExcess].join("\t"),
  );
console.log("—".repeat(60));
console.log(
  `共 ${totals.sessions} 场有调用的会话 | 采用 ptc 的 ${totals.sessionsWithPtc} 场 | 总调用 ${totals.calls}`,
);
console.log(
  `ptc_run_code ${totals.ptc} 次 | web_ds_search ${totals.webds} 次 | 内置 WebSearch+FetchURL ${totals.webBuiltin} 次`,
);
console.log(
  `错过的批量机会 ${totals.missedRuns} 段（涉及逐个调用 ${totals.missedExcess} 次，本可约进 ${totals.missedRuns} 次程序）`,
);
