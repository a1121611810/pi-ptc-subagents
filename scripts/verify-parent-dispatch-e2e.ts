/**
 * PROTOTYPE (throwaway) — does the PARENT model actually reach for a child to search?
 *
 * **The question.** The search module lives in the child (ADR-0049). The parent has no search
 * tool at all. So the whole design rests on one behaviour: **when the parent needs the web, does
 * it dispatch a child to do the searching?** If it does not, the capability is unreachable in
 * practice, whatever the ADR says.
 *
 * **Why this might not happen.** The parent's model reads the description of the task door —
 * "Create a task on a registered pi agent: it runs as a child subprocess" — and **nothing in it says the
 * child can search**. The parent also has no `web_ds_search` of its own, so the search tool's own
 * description never reaches the parent's context. The model is being asked to guess.
 *
 * **What it measures**, off the parent's own transcript and the child's:
 *
 *   1. which tools the parent called (`ptc_run_code` / `ptc_workflow` / `pi_task_codemode` / `bash`…);
 *   2. whether the program it wrote went for a task door (`pi_task_ptc` / `pi_task_codemode`, a
 *      child) or for `tools.bash` + curl (the parent doing it itself);
 *   3. whether a child actually called `web_ds_search` — the only tool the child has and the
 *      parent does not, so its presence in the child's transcript is the proof.
 *
 * **The parent runs with PTC mode on** (this package is default-on), so the parent's direct tool
 * list has no `bash`: reaching the web means writing a program, and the program either spawns a
 * child or curls.
 *
 * Run: `node scripts/verify-parent-dispatch-e2e.ts` (needs a DeepSeek credential + network).
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO_ROOT, "dist", "index.js");
const REAL_PI = join(REPO_ROOT, "node_modules", ".bin", "pi");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const MODEL = process.env.PTC_E2E_MODEL ?? "deepseek/deepseek-flash";

/**
 * Which surface the parent runs on (ADR-0051 renamed the values).
 *
 * - `full_ptc` — our PTC surfaces are model-facing (`exposure: "direct"`), the builtins are hidden
 *   by `--exclude-tools`. This is the PTC-mode TUI parent's shape.
 * - `codemode_ptc` — **pi's OWN codemode is active**: the surface detection (ADR-0029) sees codemode
 *   present, loaded and active, so our PTC surfaces drop to `codemode` reach and the model-facing
 *   tools become pi's `codemode` plus our `pi_task_codemode`. This is the "not our PTC mode" case:
 *   the programmable-tool-calling in the room is pi's, not ours.
 *
 * The env value is the surface name itself. It was `subagents` / `full` before ADR-0051 and is
 * `codemode_ptc` / `full_ptc` now — a comparison against the retired value could never match, so
 * the script silently measured the `full_ptc` branch on every run.
 */
const SURFACE = process.env["PTC_E2E_SURFACE"] === "codemode_ptc" ? "codemode_ptc" : "full_ptc";

/**
 * Which pi run mode the PARENT runs in. This is the axis the ADR-0010 entry policy turns on
 * (`decideModeEntry` refuses every mode but `"tui"`), so it is a first-class dimension of this
 * measurement, not a detail of the harness.
 *
 * - `json` (default) — `--mode json`. The only mode whose parent event stream is JSONL on stdout.
 * - `print` — plain `pi -p`, which is also what a CI run looks like. The parent's stdout is
 *   then only the final text, so the parent-side tool calls are NOT observable.
 * - `rpc` — the parent is driven over JSONL commands; its stdout carries the same event shapes.
 * - `tui` — the real interactive session, which needs a pty (run the harness under one).
 *   Its stdout is a rendered screen, so the parent-side tool calls are NOT observable either.
 *
 * The CHILD is always spawned by the dispatcher with `--mode json` (see `buildArgv`), so the
 * child's transcript is identical in every parent mode — which is what makes the comparison fair:
 * the child-side facts (did the child get the search tool? did it use it?) are measurable
 * everywhere, and only the parent-side facts are mode-dependent.
 */
const RUN_MODE = ((): "json" | "print" | "rpc" | "tui" => {
  const raw = process.env["PTC_E2E_MODE"];
  return raw === "print" || raw === "rpc" || raw === "tui" ? raw : "json";
})();

/** Whether the parent's own tool calls can be read in this mode. */
const PARENT_CALLS_VISIBLE = RUN_MODE === "json" || RUN_MODE === "rpc";

/**
 * The task, and the one variant that makes the strict path measurable.
 *
 * `PTC_E2E_TASK_VARIANT=readonly` adds a line asking for a READ-ONLY child, because that is
 * the shape that exposed the defect this harness now guards: the parent chose
 * `readOnly: "strict"` on its own (2026-10-20), the child's `--tools` allowlist dropped
 * `web_ds_search` out of existence, and the child reported having no web tool at all. Without
 * this variant the parent's tier choice is the model's own and varies between runs, so the
 * strict path is not measured at all.
 */
const TASK_VARIANT = process.env["PTC_E2E_TASK_VARIANT"];

const TASK = [
  "查一下 DeepSeek 官方文档「网页搜索与抓取」那一页现在写的计费口径是什么。",
  "把那一页上「什么样的请求才计费」那一段的原文，和你查到的那一页的完整 url，都原样写出来。",
  "如果拿不到那��页的内容，就直接说你拿不到，不要凭记忆编原文或编 url。",
  ...(TASK_VARIANT === "readonly"
    ? ["派子代理的时候要一个只读的子代理（不要让它改任何文件）。"]
    : []),
].join(" ");

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// --- preflight -------------------------------------------------------------------------------

if (!readFileSync(DIST, "utf8").includes("web_ds_search")) {
  fail("the built extension does not carry the search tool — run `pnpm run build` first.");
}
if (!readFileSync(REAL_PI, "utf8")) fail("the real pi is missing.");
const operatorAuth = JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) as {
  deepseek?: { key?: string };
};
if (typeof operatorAuth.deepseek?.key !== "string" || operatorAuth.deepseek.key.length === 0) {
  fail("the operator's auth.json has no deepseek key.");
}

// --- the isolated agent dir -------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), "pi-ptc-parent-e2e-"));
const agentDir = join(workDir, "agent");
const binDir = join(workDir, "bin");
const logDir = join(workDir, "logs");
mkdirSync(agentDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ deepseek: operatorAuth.deepseek }), {
  encoding: "utf8",
  mode: 0o600,
});
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    ...(SURFACE === "codemode_ptc" ? { defaultTools: ["+codemode"] } : {}),
  }),
  "utf8",
);
// The switch that makes the child able to search at all.
writeFileSync(
  join(agentDir, "ptc.json"),
  JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 30 } }),
  "utf8",
);

// --- the `pi` on PATH: the real pi, our build, and a transcript per process ---------------------

const wrapper = join(binDir, "pi");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env node",
    '"use strict";',
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const realPi = process.env.PTC_E2E_REAL_PI;",
    "const ext = process.env.PTC_E2E_EXTENSION;",
    "const logDir = process.env.PTC_E2E_LOG_DIR;",
    "const log = path.join(logDir, `pi-${process.pid}.jsonl`);",
    'const args = ["--extension", ext, ...process.argv.slice(2)];',
    // The proxy has to carry stdin through, or the mode that is DRIVEN rather than given a
    // prompt (rpc) never sees it: the parent answers nothing and the measurement reports
    // "the parent called: (nothing)", which reads like a refusal and is really a broken run.
    // The other three modes take the prompt as an argument and want stdin closed, so they keep
    // "ignore" — a live stdin there would leave the real pi waiting for input it will never get.
    'const isRpc = args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc";',
    'const child = spawn(realPi, args, { stdio: [isRpc ? "pipe" : "ignore", "pipe", "inherit"], env: process.env });',
    "if (isRpc) process.stdin.pipe(child.stdin);",
    'const out = fs.createWriteStream(log, { flags: "a" });',
    'child.stdout.on("data", (d) => { out.write(d); process.stdout.write(d); });',
    'child.on("close", (code) => { out.end(); process.exit(code === null ? 1 : code); });',
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(wrapper, 0o755);

// --- run the parent ----------------------------------------------------------------------------

console.log(
  `\n── the parent (PTC mode on, the search switch on) asks for a page that needs the web\n`,
);
console.log(`   task: ${TASK}\n`);

const started = Date.now();
const parent = await new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(
    wrapper,
    [
      ...(RUN_MODE === "json" ? ["--mode", "json"] : []),
      // RPC is the one mode that is DRIVEN rather than given a prompt: it reads commands from
      // stdin and stays alive. The prompt therefore goes over stdin, and the process is closed
      // when the run settles (below), not by the prompt argument.
      ...(RUN_MODE === "rpc" ? ["--mode", "rpc"] : []),
      // The TUI takes the prompt as an argument and needs a TTY to pick that mode at all, so the
      // harness has to run under a pty (see the header of this file). `-p` would force print mode.
      ...(RUN_MODE === "rpc" || RUN_MODE === "tui" ? [] : ["-p"]),
      "--no-session",
      "--model",
      MODEL,
      "--thinking",
      "off",
      // The PTC-mode parent's surface, reproduced non-interactively: the builtins are gone from
      // the model's direct list, so the only route to the web is a program, and the only binding
      // in that program is `pi_task_ptc` (bash is NOT in the default binding table — ADR-0040).
      //
      // Without this the measurement answers a different question: a plain pi session has `bash`
      // and it curls. That is a true answer about a plain session, and it is not the question.
      ...(SURFACE === "codemode_ptc"
        ? ["--tools", "+codemode"]
        : ["--exclude-tools", "read,bash,edit,write,grep,find,ls"]),
      ...(RUN_MODE === "rpc" ? [] : [TASK]),
    ],
    {
      cwd: workDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PTC_E2E_REAL_PI: REAL_PI,
        PTC_E2E_EXTENSION: DIST,
        PTC_E2E_LOG_DIR: logDir,
      },
    },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text !== "") console.log(`   [stderr] ${text.slice(0, 300)}`);
  });
  if (RUN_MODE === "rpc") {
    // The prompt command's shape is pi's own (docs/rpc-commands.md): `type`, not `command`.
    child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: TASK })}\n`);
    // RPC stays alive by design, so the run is ended by closing the pipe once it settles.
    const settle = setInterval(() => {
      if (out.includes("agent_settled")) {
        clearInterval(settle);
        child.stdin.end();
      }
    }, 250);
    const giveUp = setTimeout(() => {
      clearInterval(settle);
      child.stdin.end();
    }, 600_000);
    // Both timers have to die with the parent. A live fallback timer keeps this process alive for
    // ten minutes after the measurement is already printed, so the run looks unfinished and the
    // next one in a batch waits behind it.
    child.on("close", () => {
      clearInterval(settle);
      clearTimeout(giveUp);
    });
  }
  child.on("close", (code) => resolve({ code, out }));
});
console.log(`   the parent exited ${parent.code} in ${Date.now() - started}ms\n`);

// --- read the transcripts ------------------------------------------------------------------------

interface PiEvent {
  type?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  message?: {
    role?: string;
    content?: { type?: string; text?: string }[];
    /** The tool table that process was handed — pi's allowlist, applied. */
    toolsAdded?: { name: string }[];
  };
  text?: string;
}

function readEvents(file: string): PiEvent[] {
  if (!readFileSync(file, "utf8")) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PiEvent];
      } catch {
        return [];
      }
    });
}

const logFiles = readdirSync(logDir).filter((name) => name.endsWith(".jsonl"));
const transcripts = logFiles.map((name) => ({ name, events: readEvents(join(logDir, name)) }));

/**
 * The tool table a process was handed, read off its system message.
 *
 * This is the ONLY reliable way to tell the parent from the child: the child is the process that
 * holds `ptc_child_report` (the report tool is registered in every dispatched child and never
 * in a parent), and the parent is the one that does not.
 *
 * Reading it from the transcript rather than from the parent's stdout is what makes the
 * measurement work in EVERY run mode: in `print` mode the parent's stdout is only the final
 * text, so there is no event stream to classify.
 */
function toolTableOf(events: PiEvent[]): string[] {
  for (const event of events) {
    if (event.type !== "message_end") continue;
    if (event.message?.role !== "system") continue;
    return (event.message.toolsAdded ?? []).map((tool) => tool.name);
  }
  return [];
}

const isChild = (events: PiEvent[]): boolean => toolTableOf(events).includes("ptc_child_report");

const childTranscripts = transcripts.filter((t) => isChild(t.events));
const parentTranscripts = transcripts.filter((t) => !isChild(t.events));

/** The parent's own events: from its stdout in json mode, from its transcript file otherwise. */
const parentEvents: PiEvent[] =
  RUN_MODE === "json"
    ? parent.out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as PiEvent];
          } catch {
            return [];
          }
        })
    : (parentTranscripts[0]?.events ?? []);

function toolCallsOf(events: PiEvent[]): { name: string; args: Record<string, unknown> }[] {
  return events
    .filter((event) => event.type === "tool_execution_start" && typeof event.toolName === "string")
    .map((event) => ({ name: event.toolName as string, args: event.args ?? {} }));
}

const parentCalls = toolCallsOf(parentEvents);
const childCalls = childTranscripts.flatMap((t) => toolCallsOf(t.events));

const searched = childCalls.filter((call) => call.name === "web_ds_search");
// Either door counts: on the `full_ptc` surface the program calls `pi_task_ptc`, on the
// `codemode_ptc` surface the script calls `pi_task_codemode`. Both are "the parent created a
// child" — which is the fact this measurement is about.
const dispatched = parentCalls.filter((call) =>
  /pi_task_(ptc|codemode)/.test(JSON.stringify(call.args)),
);
const parentCurled = parentCalls.filter((call) =>
  /curl|wget|http/i.test(JSON.stringify(call.args)),
);

/**
 * The tier the parent asked for, and the tool list the child actually got.
 *
 * These two are the measurement that matters for the strict path: the child's tool list is
 * pi's ALLOWLIST, so a tier that drops `web_ds_search` drops the capability outright — and the
 * child then reports having no web tool rather than failing loudly. Read off the child's own
 * `toolsAdded` (the tool table that process was handed) and off the parent's dispatch arguments.
 */
const parentTiers = parentCalls
  .map((call) => call.args["readOnly"])
  .filter((value): value is string => typeof value === "string");
const childToolLists = childTranscripts.flatMap((t) => toolTableOf(t.events));

// --- the verdict ---------------------------------------------------------------------------------

console.log("── what happened\n");
console.log(`   the parent ran in mode: ${RUN_MODE}`);
console.log(
  `   the parent called: ${
    PARENT_CALLS_VISIBLE
      ? parentCalls.map((c) => c.name).join(", ") || "(nothing)"
      : "(not observable in this mode — the parent's stdout is not an event stream)"
  }`,
);
console.log(
  `   it used pi's own codemode: ${
    PARENT_CALLS_VISIBLE ? parentCalls.some((c) => c.name === "codemode") : "(not observable)"
  }`,
);
console.log(
  `   the tier it asked for: ${parentTiers.length > 0 ? parentTiers.join(", ") : "(none)"}`,
);
console.log(
  `   the child's tool list: ${childToolLists.length > 0 ? childToolLists.join(", ") : "(not read)"}`,
);
console.log(
  `   the child had the search tool: ${
    childToolLists.length > 0 ? String(childToolLists.includes("web_ds_search")) : "(not read)"
  }`,
);
for (const call of parentCalls) {
  const code = call.args["code"] ?? call.args["script"] ?? call.args["args"];
  if (typeof code === "string") {
    console.log(
      `\n   the program it wrote:\n${code
        .split("\n")
        .map((l) => "     " + l)
        .join("\n")}\n`,
    );
  }
}
console.log(
  `   the parent wrote a program that dispatches a child: ${
    PARENT_CALLS_VISIBLE ? String(dispatched.length > 0) : "(not observable)"
  }`,
);
console.log(
  `   the parent tried to reach the web itself (curl/http in a tool call): ${
    PARENT_CALLS_VISIBLE ? String(parentCurled.length > 0) : "(not observable)"
  }`,
);
console.log(`   a child called web_ds_search: ${searched.length > 0}`);
console.log(`   the child called: ${childCalls.map((c) => c.name).join(", ") || "(nothing)"}`);
for (const call of childCalls) {
  const args = JSON.stringify(call.args);
  if (args.length > 220) continue;
  console.log(`     - ${call.name} ${args}`);
}
console.log(`   transcripts on disk: ${logFiles.length} (${logFiles.join(", ")})`);

/**
 * The parent's final answer.
 *
 * In `json` mode that is an assistant message event; in `print` mode the parent's stdout IS
 * the answer, and there is no event stream to read it from. Both paths are answered here so the
 * report reads the same in every run mode.
 */
const finalText =
  RUN_MODE === "print"
    ? parent.out.trim()
    : parentEvents
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) =>
          (event.message?.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n"),
        )
        .join("\n\n");
console.log(
  `\n   the parent's answer:\n${finalText
    .split("\n")
    .map((l) => "     " + l)
    .join("\n")}\n`,
);

/**
 * The verdict, and the case where there is no verdict.
 *
 * "the parent called nothing" has two causes that mean opposite things: the model chose not to
 * dispatch, or the prompt never reached it. They are told apart by whether the parent said
 * anything at all — a parent that answered and did not dispatch is a finding, a parent that
 * answered nothing never ran, and reporting the second as the first would hide a broken harness.
 */
const parentAnswered = finalText.trim() !== "";
const verdict =
  searched.length > 0
    ? "DISPATCHED"
    : parentCurled.length > 0
      ? "DID ITSELF"
      : parentAnswered
        ? "NEITHER"
        : "NO-RUN (the parent produced no answer — the prompt may never have reached it)";
console.log(`   VERDICT: ${verdict}\n`);

if (process.env["PTC_E2E_KEEP"] === "1") {
  console.log(`   (work dir kept: ${workDir})`);
} else {
  rmSync(workDir, { recursive: true, force: true });
}
