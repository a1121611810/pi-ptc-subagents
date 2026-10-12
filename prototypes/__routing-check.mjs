#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway. Answers one question:
 *
 *   Does putting the agent roster in the `ptc_subagent` tool description actually make a
 *   model dispatch `research` on its own?
 *
 * Everything before this was inference: the description was proven to reach the provider
 * tool schema, but "reaches the model" and "changes what the model does" are different
 * claims and only the second one matters.
 *
 * The design is an A/B over the ONLY variable — the roster:
 *
 *   build A  `-e .`                          local working tree, has the roster
 *   build B  `-e <global 2.0.3 dist/index.js>` published, no roster
 *
 * Both runs get `-ne` (no extension discovery) plus an explicit `-e builtin:codemode`,
 * because codemode activation is what makes surface detection register `ptc_subagent` at
 * all. Same prompt, same cwd, same model. If A dispatches and B does not, the roster is
 * doing it; if both behave the same, the roster is decoration.
 *
 *
 * ── VERDICT (run 2026-10-12, deepseek-flash, repo cwd) ────────────────────────────
 *
 * ROUTE-HEAVY, single variable, real pi, real provider:
 *
 *   A local (roster)      4 dispatches · all `agent:"research", agentScope:"project"` · all fulfilled
 *   B published 2.0.3     0 dispatches · 41 tool calls reading every ADR inline
 *
 * The model also split the 38 ADRs into four parallel batches on its own. `agentScope`
 * being `"project"` is load-bearing: the default is `"user"`, which cannot see
 * `<cwd>/.pi/agents/`, so a roster without scope labels would have produced four refusals.
 *
 * EXPOSE: A names `research` and its purpose; B cannot — in 2.0.3 the description had no
 * outlet at all. A lighter ROUTE task (filtered slice) dispatched zero times in BOTH builds,
 * which is correct behaviour: that task was not worth delegating. Absence of a dispatch is
 * only evidence when the task was worth one.
 *
 * Two harness bugs this prototype had to fix, both of which produced confident wrong numbers:
 *   1. `spawn` without `stdio[0]: "ignore"` left stdin open and every `-p` probe hung to the
 *      timeout — shell invocation closes stdin implicitly, so it looked fine when run by hand.
 *   2. Counting `tool_execution_start` AND `tool_execution_end` reported 8 dispatches where
 *      there were 4, and inflated B's 41 calls to 91.
 * Run:  node prototypes/__routing-check.mjs
 * Delete when the question is answered. Nothing here is production.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PUBLISHED = join(homedir(), ".pi/agent/npm/node_modules/pi-ptc-subagents/dist/index.js");

const RAW_DIR = join(REPO, "prototypes/__routing-raw");

const PROVIDER = "deepseek";
const MODEL = "deepseek-flash";

/**
 * Two probes, because they fail differently.
 *
 * EXPOSE asks whether the model can even SEE the roster. A build without it cannot name
 * `research` or say what it is for — there is no channel carrying that text.
 *
 * ROUTE asks whether the model CHOOSES to dispatch. The task is a survey across many
 * files, the shape research's description targets, and it never names the agent.
 */
const EXPOSE_PROMPT =
  "Without dispatching anything and without reading any files: list every subagent you can " +
  "dispatch in this session. For each give its name, what it is for, and which agentScope " +
  "value reaches it. If you cannot tell what an agent is for, say so plainly.";

const ROUTE_PROMPT = "这个仓库里跟 subagent 派发相关的 ADR 一共有哪几条？每条的核心决策是什么？";

/**
 * A second routing probe, because the first one may simply not have been worth delegating.
 *
 * ROUTE #1 asked for a filtered slice (the subagent-related ADRs) — a model can answer that
 * with one `ls` plus a few reads, so choosing not to delegate was correct behaviour, not a
 * failure of the roster. This one asks for EVERY ADR's core decision: ~38 files, which is
 * exactly the "reading them would flood this context" case the description advertises. If the
 * roster does anything, it should show up here.
 */
const ROUTE_HEAVY_PROMPT =
  "把 docs/adr/ 下所有 ADR 逐篇读完，给我一份清单：每篇的文件名、它做出的核心决策、以及影响的行为。" +
  "不要抽样，全部都要。";

const PROBES = {
  expose: { name: "EXPOSE", prompt: EXPOSE_PROMPT },
  route: { name: "ROUTE", prompt: ROUTE_PROMPT },
  "route-heavy": { name: "ROUTE-HEAVY", prompt: ROUTE_HEAVY_PROMPT },
};

const selected = process.argv[2] ? process.argv[2].split(",") : Object.keys(PROBES);
for (const p of selected) {
  if (!PROBES[p]) {
    console.error(`unknown probe: ${p}. known: ${Object.keys(PROBES).join(", ")}`);
    process.exit(2);
  }
}

const RUNS = [
  { label: "A local (roster)", ext: REPO },
  { label: "B published (no roster)", ext: PUBLISHED },
];

function runPi(extPath, prompt, timeoutMs) {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--thinking",
    "off",
    "-ne",
    "-e",
    "builtin:codemode",
    "-e",
    extPath,
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    prompt,
  ];
  return new Promise((resolve) => {
    // stdin MUST be closed. `-p` is non-interactive, but with an open, never-ended stdin
    // pipe pi waits for input instead of exiting — the first run of this script killed all
    // four probes at the timeout and produced zero events. `shell` invocation closes stdin
    // implicitly; `spawn` does not, which is the whole difference between the two.
    const child = spawn("pi", args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** Tolerant reader: the event shape differs between pi versions and output modes. */
function parseEvents(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* partial line from a killed process */
    }
  }
  return events;
}

/**
 * One entry per CALL, not per event.
 *
 * The first version counted `tool_execution_start` and `tool_execution_end` as two calls and
 * reported 8 dispatches where there were 4 — the end events carry the tool name but no args,
 * which is also why half the log lines read `agent=undefined`. Keyed on the start event and
 * the toolCallId; everything else is a duplicate of a call already counted.
 */
function toolCalls(events) {
  const byId = new Map();
  for (const e of events) {
    const name = e.name ?? e.toolName ?? e.tool ?? e.message?.name;
    if (!name) continue;
    const id = e.toolCallId ?? e.id ?? e.message?.toolCallId;
    const args = e.args ?? e.arguments ?? e.input ?? e.message?.arguments ?? {};
    const isStart = String(e.type ?? "").endsWith("_start");
    if (isStart) {
      byId.set(id ?? `${name}#${byId.size}`, { name, args });
      continue;
    }
    // An end/update for an id we never saw start: record it only if its id is unknown, so a
    // stream that omits start events is still counted rather than silently dropped.
    if (id !== undefined && !byId.has(id) && String(e.type ?? "").endsWith("_end")) {
      byId.set(id, { name, args });
    }
  }
  return [...byId.values()];
}

function assistantText(events) {
  const parts = [];
  for (const e of events) {
    const content = e.message?.content ?? e.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function probe(label, ext, probeName, prompt, timeoutMs) {
  process.stdout.write(
    `\n── ${label} · ${probeName} ${"─".repeat(Math.max(0, 40 - label.length - probeName.length))}\n`,
  );
  const { code, out, err, timedOut } = await runPi(ext, prompt, timeoutMs);
  const events = parseEvents(out);
  const calls = toolCalls(events);
  const subagent = calls.filter((c) => c.name === "ptc_subagent");
  const text = assistantText(events);

  // A run that produced no events is a run that DID NOT HAPPEN. Reporting it as "the model
  // chose not to dispatch" is the false verdict this script is most able to produce, because
  // every probe is allowed to dispatch zero times. Liveness first, behaviour second.
  const live = events.some((e) => e.type === "agent_settled");
  // Raw stream to disk: the interesting case is a model that mentions ptc_subagent while
  // choosing not to call it, which no summary field above would show.
  mkdirSync(RAW_DIR, { recursive: true });
  const slug = `${label}-${probeName}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(join(RAW_DIR, `${slug}.jsonl`), out);
  const mentioned = /ptc_subagent/.test(out);
  if (mentioned) console.log(`   · the stream mentions "ptc_subagent" — it saw the tool`);
  console.log(
    `   live=${live}  exit=${code}${timedOut ? " TIMED_OUT" : ""}  bytes=${out.length}  ` +
      `toolCalls=${calls.length}  ptc_subagent=${subagent.length}`,
  );
  for (const c of calls) console.log(`   · ${c.name}`);
  for (const c of subagent) {
    console.log(
      `   → dispatched agent=${JSON.stringify(c.args?.agent)} agentScope=${JSON.stringify(c.args?.agentScope)}`,
    );
  }
  if (err.trim())
    console.log(`   stderr: ${err.trim().split("\n").slice(0, 2).join(" | ").slice(0, 300)}`);
  if (!live && out.trim())
    console.log(`   raw tail: ${out.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
  console.log(`   said: ${text.replace(/\s+/g, " ").slice(0, 420)}`);
  return { live, subagentCount: subagent.length, text, calls };
}

const TIMEOUT = 240_000;

console.log(`PROTOTYPE — routing check`);
console.log(`repo     ${REPO}`);
console.log(`build A  ${REPO}            (local working tree)`);
console.log(`build B  ${PUBLISHED}`);
if (!existsSync(PUBLISHED)) {
  console.error(`\n!! published build not found at ${PUBLISHED}`);
  process.exit(1);
}

const results = {};
for (const r of RUNS) {
  results[r.label] = {};
  for (const key of selected) {
    results[r.label][key] = await probe(
      r.label,
      r.ext,
      PROBES[key].name,
      PROBES[key].prompt,
      TIMEOUT,
    );
  }
}

console.log(`\n${"═".repeat(64)}\nVERDICT\n${"═".repeat(64)}`);
for (const r of RUNS) {
  const v = results[r.label];
  for (const key of selected) {
    const names = /research/i.test(v[key].text) ? "names-research" : "-";
    console.log(
      `${r.label.padEnd(24)} ${PROBES[key].name.padEnd(12)} ` +
        `${names.padEnd(16)} dispatches=${v[key].subagentCount}`,
    );
  }
}

const dead = [];
for (const r of RUNS) {
  const v = results[r.label];
  for (const key of selected) {
    if (!v[key].live) dead.push(`${r.label} ${PROBES[key].name}`);
  }
}
if (dead.length > 0) {
  console.log(`\n!! NO VERDICT. These probes never reached the model: ${dead.join(", ")}`);
  console.log("   A probe that did not run is not a probe whose result was 'no dispatch'.");
  process.exit(2);
}

const a = results["A local (roster)"];
const b = results["B published (no roster)"];
if (!selected.includes("route")) process.exit(0);
console.log(
  a.route.subagentCount > b.route.subagentCount
    ? "\n=> The roster changed routing behaviour."
    : a.route.subagentCount === 0 && b.route.subagentCount === 0
      ? "\n=> INCONCLUSIVE. Neither build dispatched. The task may simply not have been worth" +
        "\n   delegating; run it with the agent named explicitly to confirm the path works at all."
      : "\n=> No behavioural difference observed; treat the roster as unproven.",
);
