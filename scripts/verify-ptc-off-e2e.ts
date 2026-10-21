/**
 * ADR-0050 and ADR-0058, measured on a real pi: with the PTC dispatch switch off, a new child
 * cannot be started — on the codemode front (`pi_task_codemode`) and the program's front
 * (`pi_task_ptc` inside a `ptc_run_code` program) alike — and the three background-task tools
 * leave the model's face.
 *
 * ## What is measured, and how
 *
 * The switch is a session-scoped record (`pi.appendEntry("ptc-dispatch", { enabled: false })`),
 * and the package restores it at `session_start`. This harness writes **that same entry** from a
 * tiny probe extension loaded BEFORE the package, so the package's own restore path runs — the
 * path a resume takes. The command that writes it (`/ptc off`) is covered by the stub-driven test
 * in `tests/unit/extension-background.test.ts`, which drives the real handler against the real
 * task registry.
 *
 * The observations are the parent's own json event stream and its system message:
 *
 *   - the tool table it was handed (`toolsAdded`) — the three task tools must be ABSENT;
 *   - the `<ptc>` section — ADR-0058: it must SAY that the task door is gone, and it must not
 *     teach HOW to create a task (the calling convention);
 *   - the tool calls it made — a dispatch attempt must be refused, and the refusal text must
 *     reach the model.
 *
 * ## Run it
 *
 *   node scripts/verify-ptc-off-e2e.ts
 *
 * It needs a real credential (`~/.pi/agent/auth.json`), a built `dist/`, and it spends a couple
 * of model calls. The model's behaviour is not asserted beyond the refusal: a model that reads
 * the section and answers without trying is a valid outcome, so the assertion is on the section
 * and the tool table, with the refusal checked as "did it try, and was it refused".
 *
 * The exit status is the verdict: a red check exits non-zero, so one run can be a gate.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist", "index.js");
const PI = join(REPO_ROOT, "node_modules", ".bin", "pi");
const MODEL = "deepseek-chat";

const TASK =
  "派一个子代理去查 DeepSeek 官方文档里「网页搜索与抓取」那一页的计费口径，" +
  "让子代理用 web_ds_search 找到那一页，把「什么样的请求才计费」那一段的原文带回来。";

/** The three tools ADR-0050 withholds while PTC is off and nothing is running. */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"];

/**
 * The tools a truncated session NAMES as withdrawn (ADR-0058).
 *
 * ADR-0058: "The withdrawn tools are NAMED, because a model that saw them a turn ago needs to
 * know they are gone rather than keep calling into a tool that is no longer there." The two
 * surfaces lose DIFFERENT things — the program pair on `full_ptc`, the program pair plus the
 * task door on `codemode_ptc` — so this is the union of both surfaces' losses: the harness does
 * not read the surface it landed on, and it must not have to.
 */
const WITHDRAWN_TOOLS = ["ptc_run_code", "ptc_workflow", "pi_task_codemode"];

/**
 * The CALLING CONVENTION — the thing the truncated section must not teach.
 *
 * ADR-0058 decides both halves of the truncated section, and they point in opposite directions:
 *
 *   - the withdrawn tools are NAMED (a model has to know they are gone), and
 *   - the calling convention is NOT given, because "telling a model HOW to create a task in a
 *     session where it cannot is an instruction it cannot follow" (ADR-0050 decision 6).
 *
 * The check this script used to make — "the door's NAME may not appear" — tested the first half
 * backwards: it went red on a sentence that says the door is GONE (which is ADR-0058's decision),
 * and it would have stayed green on a section that taught the call form while dodging the name.
 *
 * So the check is on the CALL FORM instead: the door's name used as a callee, and the door
 * reached through a tool table. Both spellings are in the route index (ADR-0061) —
 * `await tools.pi_task_codemode({ task })` on the codemode surface and
 * `await tools.pi_task_ptc({ task })` on the full one — so a truncated session that rendered the
 * index turns this red, and so does a truncation line that grew a calling convention.
 *
 * A bare mention of the door is NOT a call form, and it is deliberately allowed: naming what is
 * gone is the half ADR-0058 requires.
 */
const CALLING_CONVENTION: readonly RegExp[] = [
  // the door named as a callee: `pi_task_codemode({ task })`
  /\bpi_task_codemode\s*\(/,
  /\bpi_task_ptc\s*\(/,
  // the door reached through a tool table: `tools.pi_task_codemode(...)`,
  // `tools["pi_task_codemode"](...)`
  /\btools\s*(?:\.|\[)\s*["'`]?\s*pi_task_/,
];

interface PiEvent {
  type?: string;
  toolName?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string }[];
    toolsAdded?: { name: string }[];
    sections?: Record<string, string>;
  };
}

const work = mkdtempSync(join(tmpdir(), "pi-ptc-off-e2e-"));
const agentDir = join(work, "agent");
mkdirSync(agentDir, { recursive: true });
copyFileSync(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));
chmodSync(join(agentDir, "auth.json"), 0o600);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultModel: MODEL, defaultThinkingLevel: "off", defaultTools: ["+codemode"] }),
);
// The switch that makes the child able to search at all — so the refusal is about PTC being off,
// not about the capability being missing.
writeFileSync(
  join(agentDir, "ptc.json"),
  JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 30 } }),
);

// The probe extension: it writes exactly the entry `/ptc off` writes, and it is loaded BEFORE the
// package so the package's `session_start` sees it.
const probe = join(work, "probe.mjs");
writeFileSync(
  probe,
  [
    "export default function probe(pi) {",
    "  pi.on('session_start', () => {",
    "    pi.appendEntry('ptc-dispatch', { enabled: false });",
    "  });",
    "}",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`\n── PTC is off: can the parent still start a child?\n`);
console.log(`   task: ${TASK}\n`);

const started = Date.now();
const out = execFileSync(
  PI,
  [
    "--extension",
    probe,
    "--extension",
    DIST,
    "--mode",
    "json",
    "--no-session",
    "--thinking",
    "off",
    "--tools",
    "+codemode",
    "-p",
    TASK,
  ],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", maxBuffer: 64 << 20 },
);
console.log(`   the parent exited in ${Date.now() - started}ms\n`);

const events = out
  .split("\n")
  .filter((line) => line.trim() !== "")
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as PiEvent];
    } catch {
      return [];
    }
  });

const system = events.find((e) => e.type === "message_end" && e.message?.role === "system");
const tools = (system?.message?.toolsAdded ?? []).map((t) => t.name);
const section = system?.message?.sections?.ptc ?? "";
const calls = events
  .filter((e) => e.type === "tool_execution_start" && typeof e.toolName === "string")
  .map((e) => e.toolName as string);
const answer = events
  .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
  .map((e) => (e.message?.content ?? []).map((c) => c.text ?? "").join("\n"))
  .join("\n\n");

const present = TASK_TOOLS.filter((name) => tools.includes(name));
const triedDispatch = calls.some((name) => name === "pi_task_codemode" || name === "ptc_run_code");
const refusalReachedTheModel = out.includes("PTC is off in this session");

/** Does this section teach HOW to create a task? (ADR-0058 — the calling convention.) */
function teachesHowToCreateATask(text: string): boolean {
  return CALLING_CONVENTION.some((pattern) => pattern.test(text));
}

/** Does this section say what was withdrawn? (ADR-0058 — the withdrawn tools are NAMED.) */
function saysWhatWasWithdrawn(text: string): boolean {
  return WITHDRAWN_TOOLS.some((name) => text.includes(name)) && /\bwithdrawn\b/i.test(text);
}

console.log("── what happened\n");
console.log(`   the parent's tool table: ${tools.join(", ")}`);
console.log(`   the three task tools present: ${present.length > 0 ? present.join(", ") : "NONE"}`);
console.log(`   the <ptc> section: ${JSON.stringify(section)}`);
console.log(`   the parent called: ${calls.join(", ") || "(nothing)"}`);
console.log(`   a dispatch was attempted: ${triedDispatch}`);
console.log(`   the refusal reached the model: ${refusalReachedTheModel}`);
console.log(
  `\n   the parent's answer:\n${answer
    .split("\n")
    .map((line) => "     " + line)
    .join("\n")}\n`,
);

const checks: [string, boolean][] = [
  ["the three task tools left the model's face", present.length === 0],
  ["the section says creating a task is off", section.includes("PTC is off")],
  ["the section says what was withdrawn", saysWhatWasWithdrawn(section)],
  ["the section does NOT teach how to create a task", !teachesHowToCreateATask(section)],
  ["the model was told, so it did not need to fail first", refusalReachedTheModel],
];
const failures: string[] = checks.filter(([, ok]) => !ok).map(([label]) => label);
for (const [label, ok] of checks) console.log(`   ${ok ? "✓" : "✗"} ${label}`);

// The refusal itself is asserted only when the model actually tried: a model that reads the
// section and answers without trying is a valid outcome, and calling that a failure would be
// asserting the model's behaviour rather than the package's.
if (triedDispatch) {
  const refused = refusalReachedTheModel;
  console.log(`   ${refused ? "✓" : "✗"} the dispatch it attempted was refused`);
  if (!refused) failures.push("the dispatch it attempted was refused");
}
console.log();

// The exit status is the verdict: a red check has to fail the run, or the run is a printout
// nobody has to read.
if (failures.length > 0) {
  console.error(`   ✗ ${failures.length} check(s) failed: ${failures.join("; ")}\n`);
  process.exit(1);
}
