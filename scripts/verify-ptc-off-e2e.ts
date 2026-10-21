/**
 * ADR-0050, measured on a real pi: with the PTC dispatch switch off, a new child cannot be
 * started — on the top-level front (`ptc_subagent`) and the program's front (`pi.dispatch` inside
 * a `ptc_run_code` program) alike — and the three background-task tools leave the model's face.
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
 *   - the `<ptc>` section — it must say dispatching is off rather than how to dispatch;
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
const triedDispatch = calls.some((name) => name === "ptc_subagent" || name === "ptc_run_code");
const refusalReachedTheModel = out.includes("PTC is off in this session");

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
  ["the section says dispatching is off", section.includes("PTC is off")],
  ["the section does NOT teach how to dispatch", !section.includes("ptc_subagent")],
  ["the model was told, so it did not need to fail first", refusalReachedTheModel],
];
for (const [label, ok] of checks) console.log(`   ${ok ? "✓" : "✗"} ${label}`);

// The refusal itself is asserted only when the model actually tried: a model that reads the
// section and answers without trying is a valid outcome, and calling that a failure would be
// asserting the model's behaviour rather than the package's.
if (triedDispatch) {
  console.log(`   ${refusalReachedTheModel ? "✓" : "✗"} the dispatch it attempted was refused`);
}
console.log();
