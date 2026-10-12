#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway. Answers one question:
 *
 *   Does the work on `main` actually function inside a real pi, and how does it
 *   differ from the build a user has installed today?
 *
 * Every previous check ran against a test double (`makeExtensionStub`) or a fake
 * `pi` on PATH. Neither is pi. This one drives the real binary with the real
 * plugin loaded, and an A/B whose only variable is the build:
 *
 *   A  `-e .`                    the local working tree, built
 *   B  `-e <installed 2.0.3>`    what `pi install npm:pi-ptc-subagents` gives you today
 *
 * Both run `-ne` plus an explicit `-e builtin:codemode`, because codemode
 * activation is what makes surface detection register `ptc_subagent` at all —
 * without it neither build has a subagent face to test.
 *
 * Three probes, chosen for what a real pi can actually SHOW:
 *
 *   1. VIEW   what the model is told the `agent` argument is. Asked of the
 *             model, so the answer is about the text a session really receives.
 *   2. USE    a dispatch with no `agent`, plus the child's own report of what it
 *             was told — one call, because the child's answer is the evidence
 *             for the context work and the dispatch's status is the evidence for
 *             the optional-argument work.
 *   3. NOTICE whether the startup warning reaches stdout or stderr. Expected to
 *             be absent in BOTH builds, because `ui.notify` is the TUI channel —
 *             which makes it a measurement about the CHANNEL, not about the
 *             builds, and this script says so rather than counting it as a pass.
 *
 *
 * ── VERDICT (run 2026-10-12, deepseek-flash, real pi, repo cwd) ────────────────────
 *
 *   VIEW   the model is told the argument is optional:  A=true   B=false
 *          A quoted it verbatim from its own tool description; B answered "NOTHING",
 *          because 2.0.3's description never says what omitting it does.
 *   USE    dispatch with no `agent`:                    A=fulfilled  B=refused
 *          The models behaved IDENTICALLY in both builds — each passed only `{task}` —
 *          so the difference is entirely the build: A ran the child, B was stopped by
 *          `Validation failed for tool "ptc_subagent": agent: must have required
 *          properties agent`.
 *   NOTICE reaches a non-TUI channel: false in BOTH. This row measures the CHANNEL,
 *          not the builds: `ui.notify` is TUI-only. It is recorded rather than counted
 *          as a pass, and it means #187's removal has never been observed in a real pi
 *          by any means — only against `makeExtensionStub`.
 *
 * The child's own answer, verbatim, is the #186 evidence:
 *
 *   "Yes — my system prompt says I was dispatched as a fresh context, that I cannot see
 *    the caller's conversation, and that I cannot ask it anything." it then names where:
 *   `<addendum>` (pi's own wrapper for --append-system-prompt content) and the PTC depth
 *   note. That also settles criterion 3 by observation rather than by reading: the text
 *   arrives INSIDE pi's addendum, i.e. appended to pi's prompt, not substituted for it.
 *
 * Harness bug this script had to fix, worth repeating: the first run counted CALLS, so it
 * reported "A=1 B=1" for two builds that did opposite things. A refused call is still a
 * call. It now reads each call's outcome from its `_end` event.
 * Run:  node prototypes/__real-pi-check.mjs
 * Delete when answered. Nothing here is production.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const INSTALLED = join(homedir(), ".pi/agent/npm/node_modules/pi-ptc-subagents/dist/index.js");

const PROVIDER = "deepseek";
const MODEL = "deepseek-flash";
const TIMEOUT = 240_000;

const VIEW_PROMPT =
  "Do not call any tools. Quote, verbatim and exactly once, the sentence or sentences from your " +
  "`ptc_subagent` tool description that tell you what the `agent` argument is and whether you " +
  "have to provide it. If the description says nothing about it, say exactly: NOTHING.";

const USE_PROMPT =
  "Call `ptc_subagent` exactly once, and pass NO `agent` argument — only `task`. The task is: " +
  '"In one line: does your system prompt tell you that you were dispatched, and that you cannot ' +
  "see the caller?\" Then paste the child's reply verbatim. If the call is refused, paste the " +
  "refusal verbatim instead.";

const BUILDS = [
  { label: "A local (main)", ext: REPO },
  { label: "B installed 2.0.3", ext: INSTALLED },
];

const PROBES = { view: VIEW_PROMPT, use: USE_PROMPT };
const selected = process.argv[2] ? process.argv[2].split(",") : Object.keys(PROBES);
for (const p of selected) {
  if (!PROBES[p]) {
    console.error(`unknown probe: ${p}. known: ${Object.keys(PROBES).join(", ")}`);
    process.exit(2);
  }
}

function runPi(extPath, prompt) {
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
    // stdin MUST be closed: with an open, never-ended pipe pi waits for input instead of exiting.
    const child = spawn("pi", args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

function parseEvents(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* partial line */
    }
  }
  return events;
}

/**
 * One entry per CALL, with its OUTCOME.
 *
 * Counting calls alone was this script's own version of the bug it exists to catch: the first run
 * reported "A=1 B=1" for two builds that did opposite things, because a refused call is still a
 * call. `status` comes from the tool's structured result; a refusal that never produced one is
 * marked refused.
 */
function toolCalls(events) {
  const byId = new Map();
  for (const e of events) {
    const name = e.name ?? e.toolName ?? e.tool;
    if (!name) continue;
    const type = String(e.type ?? "");
    const id = e.toolCallId ?? e.id ?? `${name}#${byId.size}`;
    if (type.endsWith("_start")) {
      byId.set(id, { name, args: e.args ?? e.arguments ?? e.input ?? {}, status: "?" });
      continue;
    }
    if (!type.endsWith("_end")) continue;
    const call = byId.get(id);
    if (!call) continue;
    const sc = e.result?.structuredContent;
    const content = (e.result?.content ?? []).map((b) => b?.text ?? "").join(" ");
    call.status =
      typeof sc?.status === "string"
        ? sc.status
        : /validation failed|refused|must have required/i.test(content)
          ? "refused"
          : "no-structured-status";
  }
  return [...byId.values()];
}

function assistantText(events) {
  const parts = [];
  for (const e of events) {
    const content = e.message?.content ?? e.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content)
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

async function probe(label, ext, probeName, prompt) {
  process.stdout.write(
    `\n── ${label} · ${probeName} ${"─".repeat(Math.max(0, 34 - label.length - probeName.length))}\n`,
  );
  const { code, out, err, timedOut } = await runPi(ext, prompt);
  const events = parseEvents(out);
  const live = events.some((e) => e.type === "agent_settled");
  const calls = toolCalls(events);
  const subs = calls.filter((c) => c.name === "ptc_subagent");
  const text = assistantText(events);
  const both = out + err;
  const notice = /no registered agent|nothing to dispatch/i.test(both);

  console.log(
    `   live=${live} exit=${code}${timedOut ? " TIMED_OUT" : ""} calls=[${calls
      .map((c) => c.name)
      .join(",")}]`,
  );
  for (const s of subs) {
    const keys = Object.keys(s.args).sort().join(",");
    console.log(`   → ptc_subagent args {${keys}}  outcome=${s.status}`);
  }
  if (!live) {
    console.log(`   !! did not reach the model — no verdict from this row`);
    return { live, subs: subs.length, text, notice };
  }
  console.log(`   notice on stdout/stderr: ${notice ? "PRESENT" : "absent"}`);
  const flat = text.replace(/\s+/g, " ");
  console.log(`   said (head): ${flat.slice(0, 300)}`);
  console.log(`   said (tail): ${flat.slice(-900)}`);
  return { live, calls: calls.length, subs, text, notice };
}

console.log("PROTOTYPE — does it really work in a real pi?");
console.log(`repo       ${REPO}`);
console.log(`build A    ${REPO}`);
console.log(`build B    ${INSTALLED}`);
if (!existsSync(INSTALLED)) {
  console.error(`\n!! no installed build at ${INSTALLED}`);
  process.exit(1);
}

const results = {};
for (const b of BUILDS) {
  results[b.label] = {};
  for (const key of selected) {
    results[b.label][key] = await probe(b.label, b.ext, key.toUpperCase(), PROBES[key]);
  }
}

console.log(`\n${"═".repeat(70)}\nVERDICT\n${"═".repeat(70)}`);
const dead = [];
for (const b of BUILDS)
  for (const key of selected) if (!results[b.label][key].live) dead.push(`${b.label} ${key}`);
if (dead.length > 0) {
  console.log(`!! NO VERDICT for: ${dead.join(", ")} — those rows never reached the model.`);
  process.exit(2);
}

const A = results["A local (main)"];
const B = results["B installed 2.0.3"];
if (selected.includes("view")) {
  const aOpt = /optional|omit it/i.test(A.view.text);
  const bOpt = /optional|omit it/i.test(B.view.text);
  console.log(`VIEW   tells the model the argument is optional:  A=${aOpt}  B=${bOpt}`);
}
if (selected.includes("use")) {
  const outcome = (r) => r.subs.map((c) => c.status).join("/") || "(no call)";
  console.log(
    `USE    dispatch with no agent  A=${outcome(A.use)}   B=${outcome(B.use)}` +
      "   (a refused call is still a call)",
  );
}
const anyNotice = A.use.notice || B.use.notice;
console.log(
  `NOTICE reaches a non-TUI channel: ${anyNotice} ` +
    (anyNotice ? "" : "(expected: ui.notify is TUI-only, so NO build can show it here)"),
);
