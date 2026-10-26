/**
 * Does a parent model pass `goal` on its own? (map #208, the last fog item)
 *
 * Every E3 run so far FORCED the goal. This one does not: it gives a parent a task that would
 * benefit from a dispatch and measures whether the tool call carries a goal at all.
 *
 * The parent runs with the built extension (`-e dist/index.js`) in JSON mode, so each tool call is
 * an event on stdout. Nothing is asserted about what it SHOULD do — the question is adoption.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const PROMPTS = [
  [
    "p1",
    "We are preparing a release and I need to know whether `src/runtime/dispatch.ts` has a concurrency bug. Use a subagent if that helps, then tell me what matters.",
  ],
  [
    "p2",
    "Give me a second opinion on whether `src/runtime/child-report.ts` is safe to ship. A subagent may be useful.",
  ],
  [
    "p3",
    "Review the `ptc_subagent` tool description in `src/tools/subagent.ts` and tell me whether a model would understand when to use it.",
  ],
];

function parse(argv) {
  const a = { model: "", thinking: "", out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--model") ((a.model = v), (i += 1));
    else if (k === "--thinking") ((a.thinking = v), (i += 1));
    else if (k === "--out") ((a.out = v), (i += 1));
  }
  return a;
}

function run(prompt, a) {
  return new Promise((resolve) => {
    const argv = [
      "-p",
      "--mode",
      "json",
      "--no-session",
      "-e",
      join(REPO_ROOT, "dist", "index.js"),
      "--model",
      a.model,
    ];
    if (a.thinking.length > 0) argv.push("--thinking", a.thinking);
    argv.push("--", prompt);
    const child = spawn("pi", argv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Every dispatch call the parent made, with whether its args carried a non-empty goal. */
function dispatches(output) {
  const calls = [];
  for (const line of output.split("\n")) {
    if (!line.includes("ptc_subagent") && !line.includes("pi.dispatch")) continue;
    try {
      const event = JSON.parse(line);
      const message = event?.message ?? event?.partial?.message;
      for (const part of message?.content ?? []) {
        if (part?.type !== "toolCall") continue;
        if (part.name !== "ptc_subagent" && part.name !== "pi.dispatch") continue;
        const goal = part.arguments?.goal;
        calls.push({
          tool: part.name,
          hasGoal: typeof goal === "string" && goal.trim().length > 0,
        });
      }
    } catch {
      // A non-JSON line is not a tool call.
    }
  }
  return calls;
}

const args = parse(process.argv.slice(2));
for (const [id, prompt] of PROMPTS) {
  const output = await run(prompt, args);
  const calls = dispatches(output);
  const row = {
    prompt: id,
    dispatches: calls.length,
    goals: calls.filter((c) => c.hasGoal).length,
  };
  appendFileSync(args.out, JSON.stringify(row) + "\n");
  console.log([id, "dispatches=" + row.dispatches, "withGoal=" + row.goals].join("\t"));
}
