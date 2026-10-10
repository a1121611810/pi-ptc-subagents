/**
 * Smoke-verify the built `dist/index.js` renderers without a TUI.
 *
 * Imports the real built artifact, calls the extension factory with a fake `pi` to capture the
 * tool definitions it registers in `full` surface mode, then exercises `renderCall` /
 * `renderResult` (collapsed and expanded) with a stub theme, printing the visible text exactly as
 * the TUI would lay it out.
 *
 * Exits non-zero on any failure so it can gate a release check.
 *
 * The agent dir is pinned to a throwaway empty directory, and the three detection probes are
 * stated explicitly at the call site. ADR-0034 removed the `surfaceMode` key, which used to be what
 * this pin was FOR -- and the pin silently became decorative at that moment: nothing wrote
 * `ptc.json` into it any more. The gate kept passing, but on a different and much weaker basis --
 * the presence probe walking out of `process.argv[1]` (this script) and finding no pi next to it.
 * That is an accident of how the script is invoked, not a property of the artifact, so it is
 * replaced here rather than left to hold the assertion up.
 *
 * The pin is still worth keeping, for the probes that do read the agent dir: activation reads
 * `<agentDir>/settings.json` and the MCP evidence probe reads `<agentDir>/mcp.json`. It is
 * unconditional -- a caller's own `PI_CODING_AGENT_DIR` is shadowed for the duration of the run,
 * because a release gate that reads the machine's settings is not a release gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distUrl = new URL("../dist/index.js", import.meta.url);
const dist = await import(fileURLToPath(distUrl));

// --- pinned agent dir: the probes' inputs, not the machine's ------------------------------
// The factory reads <agentDir>/settings.json (activation) and <agentDir>/mcp.json (ADR-0033
// evidence), so pointing PI_CODING_AGENT_DIR at a directory this script owns makes those two
// inputs empty rather than whatever the machine running the gate happens to have. There is no
// ptc.json written here any more: ADR-0034 removed the surfaceMode key, and a key nothing reads
// would be a pin in name only. The third axis -- whether this pi ships codemode at all -- cannot
// be shadowed this way, so it is stated at the call site below instead.
const agentDir = mkdtempSync(join(tmpdir(), "pi-ptc-verify-dist-"));
process.on("exit", () => {
  rmSync(agentDir, { recursive: true, force: true });
});
process.env.PI_CODING_AGENT_DIR = agentDir;

// --- fake pi that records tool registrations -------------------------------------------
const registered = new Map();
const fakePi = {
  registerTool(def) {
    registered.set(def.name, def);
  },
  registerCommand() {},
  on() {
    return () => {};
  },
  getActiveTools() {
    return ["read", "bash", "edit", "write"];
  },
  setActiveTools() {},
  appendEntry() {},
};
// The `full` surface the tool list below names, stated rather than inferred: pi ships no
// codemode, so pi would not load one, so the model would not get one. Naming all three axes is
// what makes the expected set a property of the built artifact -- before ADR-0034 this line was
// preceded by a `ptc.json` pin that had quietly stopped deciding anything.
dist.default(fakePi, {
  codemode: { present: false, how: "not-found" },
  codemodeSwitch: { switch: "disabled", source: "default" },
  codemodeActivation: { activation: "inactive", source: "default" },
});

// The extension registers the two PTC tools plus the three always-on background-task tools
// (ADR-0022) -- that is the `full` surface, pinned above. An exact-set assertion is deliberate: a
// tool silently disappearing from the built dist is exactly the regression this gate exists to
// catch, and a set that grows without this line moving is a surface change nobody reviewed.
//
// `ptc_child_report` (ADR-0032) is registered in EVERY surface including this one, but is
// `defaultActive: ptcDepth > 0`, so at depth 0 it is registered-and-inactive: the gate collects
// `registerTool` calls, not the active set, so it belongs here even though a parent session can
// never call it. That is deliberate — a child MUST be able to find it, and "registered only when
// we are already the child" would mean the tool is absent exactly where it is needed.
const EXPECTED_TOOLS = [
  "ptc_run_code",
  "ptc_workflow",
  "ptc_task_list",
  "ptc_task_output",
  "ptc_task_stop",
  "ptc_child_report",
];
{
  const missing = EXPECTED_TOOLS.filter((name) => !registered.has(name));
  const extra = [...registered.keys()].filter((name) => !EXPECTED_TOOLS.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    console.error("FAIL: registered tools differ from the expected set.", {
      missing,
      extra,
      got: [...registered.keys()],
    });
    process.exit(1);
  }
  for (const name of EXPECTED_TOOLS) {
    const tool = registered.get(name);
    if (typeof tool.renderCall !== "function" || typeof tool.renderResult !== "function") {
      console.error(`FAIL: ${name} has no renderCall/renderResult in the built dist`);
      process.exit(1);
    }
  }
}

// --- stub theme -----------------------------------------------------------------------
const theme = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => `\u001b[1m${t}\u001b[0m`,
  italic: (t) => t,
  underline: (t) => t,
  inverse: (t) => t,
  strikethrough: (t) => t,
};

// Strip ANSI for stable comparison, keep it for display.
// Built via `new RegExp` so the ESC control character never appears literally (no-control-regex).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s) => s.replace(ANSI_RE, "");
const show = (label, component, width = 100) => {
  const lines = component
    .render(width)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  for (const l of lines) console.log(`  ${l}`);
  return strip(lines.join("\n"));
};

const failures = [];
const expect = (label, out, needles) => {
  for (const n of needles) {
    checks += 1;
    if (!out.includes(n)) failures.push(`${label}: missing ${JSON.stringify(n)}`);
  }
};

const runCode = registered.get("ptc_run_code");
const workflow = registered.get("ptc_workflow");
if (runCode.renderCall === undefined || runCode.renderResult === undefined) {
  console.error("FAIL: ptc_run_code has no renderCall/renderResult in the built dist");
  process.exit(1);
}
if (workflow.renderCall === undefined || workflow.renderResult === undefined) {
  console.error("FAIL: ptc_workflow has no renderCall/renderResult in the built dist");
  process.exit(1);
}

const taskList = registered.get("ptc_task_list");

let checks = 0;

// ── 1. renderCall: label + description only (the code lives in the expanded view) ─────
const codeArgs = {
  code: "// preamble comment\nconst pkg = await tools.read({ path: 'package.json' });\nreturn { ok: true };",
  description: "Read package.json and return ok",
};
const callOut = show("renderCall · ptc_run_code", runCode.renderCall(codeArgs, theme));
expect("renderCall/run_code", callOut, ["PTC", "Read package.json and return ok"]);
if (callOut.includes("const pkg = await tools.read")) {
  failures.push("renderCall/run_code: code preview leaked into the call row");
}
checks += 1;

// ── 2. renderCall: workflow falls back to meta.name ───────────────────────────────────
const wfCallOut = show(
  "renderCall · ptc_workflow",
  workflow.renderCall({ meta: { name: "validate-config" }, script: "return 1;", args: {} }, theme),
);
expect("renderCall/workflow", wfCallOut, ["PTC workflow", "validate-config"]);
// The call row is a heading; the code itself is one ctrl+e away.
if (wfCallOut.includes("return 1;")) {
  failures.push("renderCall/workflow: code preview leaked into the call row");
}
checks += 1;

// ── 2b. ptc_task_list: call row + a record row from the built renderer ────────────────
const taskRecord = {
  id: "01JBZ000000000000000000002",
  label: "dist smoke",
  agentName: "researcher",
  depth: 1,
  status: "succeeded",
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
  durationMs: 1_000,
  transitionAt: 1_700_000_001_000,
  outputBytes: 913,
};
const taskListCall = show("renderCall · ptc_task_list", taskList.renderCall({}, theme));
expect("renderCall/task_list", taskListCall, ["PTC task list"]);
const taskListOut = show(
  "renderResult · ptc_task_list",
  taskList.renderResult(
    {
      content: [{ type: "text", text: "01JBZ000000000000000000002  succeeded" }],
      details: { tasks: [taskRecord], count: 1 },
    },
    { expanded: false, isPartial: false },
    theme,
    { args: {}, isError: false },
  ),
);
// The row shows the record's content and the status GLYPH (succeeded -> success check), not the
// status word, so both the content fields and the status mapping are asserted.
expect("renderResult/task_list", taskListOut, ["dist smoke", "researcher", "913B", "✓"]);

// ── 3. renderResult collapsed: result preview + duration ──────────────────────────────
const okDetails = {
  surface: "run_code",
  logs: ["[ptc] log 1", "[ptc] log 2"],
  narrations: [],
  phases: [],
  warnings: [],
  result: { version: "0.1.0", node: "v24" },
  durationMs: 412,
};
const collapsedOut = show(
  "renderResult collapsed · success",
  runCode.renderResult(
    { content: [{ type: "text", text: "x" }], details: okDetails },
    { expanded: false, isPartial: false },
    theme,
    { args: codeArgs, isError: false },
  ),
);
expect("collapsed/success", collapsedOut, [
  '├─ version: "0.1.0"',
  '└─ node: "v24"',
  "2 output lines",
  "412ms",
]);

// ── 4. renderResult collapsed: failure ───────────────────────────────────────────────
const failDetails = { ...okDetails, result: undefined, logs: [] };
const failOut = show(
  "renderResult collapsed · failure",
  runCode.renderResult(
    {
      content: [{ type: "text", text: "code run failed (exception): boom" }],
      details: failDetails,
    },
    { expanded: false, isPartial: false },
    theme,
    { args: codeArgs, isError: true },
  ),
);
expect("collapsed/failure", failOut, ["failed: code run failed (exception): boom", "412ms"]);

// ── 5. renderResult collapsed: workflow with phases + warnings ────────────────────────
const wfDetails = {
  surface: "workflow",
  logs: [],
  narrations: ["log line A"],
  phases: ["init", "compute", "report"],
  warnings: ['phase "extra" is not listed in meta.phases'],
  durationMs: 1500,
};
const wfCollapsed = show(
  "renderResult collapsed · workflow phases+warnings",
  workflow.renderResult(
    { content: [{ type: "text", text: "x" }], details: wfDetails },
    { expanded: false, isPartial: false },
    theme,
    { args: { meta: { name: "demo" }, script: "return 1;" }, isError: false },
  ),
);
expect("collapsed/workflow", wfCollapsed, ["3 phases", "1 warning", "1.5s"]);

// ── 6. renderResult expanded: code head + phases + logs ───────────────────────────────
const expandedOut = show(
  "renderResult expanded · workflow",
  workflow.renderResult(
    { content: [{ type: "text", text: "Phases: init → compute → report" }], details: wfDetails },
    { expanded: true, isPartial: false },
    theme,
    {
      args: { meta: { name: "demo" }, script: "phase('init');\nlog('a');\nreturn 1;" },
      isError: false,
    },
  ),
);
expect("expanded/workflow", expandedOut, [
  // description lives on the renderCall row, not repeated here
  "code   ",
  "├─ phases  init → compute → report",
  "├─ log     log line A",
  '└─ warn    phase "extra" is not listed',
]);
if (expandedOut.includes("demo")) {
  failures.push("expanded/workflow: description leaked into expanded view (renderCall-only)");
}
checks += 1;

// ── 7. renderResult expanded: error message surfaced ────────────────────────────────
const errExpanded = show(
  "renderResult expanded · error",
  runCode.renderResult(
    {
      content: [{ type: "text", text: "code run failed (timeout): exceeded 120 s" }],
      details: failDetails,
    },
    { expanded: true, isPartial: false },
    theme,
    { args: codeArgs, isError: true },
  ),
);
expect("expanded/error", errExpanded, ["code run failed (timeout): exceeded 120 s"]);

// ── 8. renderResult expanded: completion value shown in full ───────────────────────
const resultExpanded = show(
  "renderResult expanded · result payload",
  runCode.renderResult(
    { content: [{ type: "text", text: "x" }], details: okDetails },
    { expanded: true, isPartial: false },
    theme,
    { args: codeArgs, isError: false },
  ),
);
expect("expanded/result", resultExpanded, ['├─ version: "0.1.0"', '├─ node: "v24"']);

// A failed run has no completion value; the result block must not appear.
if (errExpanded.includes("├─ value") || errExpanded.includes("└─ value")) {
  failures.push("expanded/error: value block rendered on a failed run");
}
checks += 1;

console.log(
  failures.length === 0
    ? `\n✅ dist renderers OK — all ${checks} checks passed`
    : `\n❌ ${failures.length} of ${checks} check(s) failed:\n${failures.map((f) => `   - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
