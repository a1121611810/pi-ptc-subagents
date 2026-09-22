/**
 * Smoke-verify the built `dist/index.js` renderers without a TUI.
 *
 * Imports the real built artifact, calls the extension factory with a fake `pi` to capture the
 * two registered tool definitions, then exercises `renderCall` / `renderResult` (collapsed and
 * expanded) with a stub theme, printing the visible text exactly as the TUI would lay it out.
 *
 * Exits non-zero on any failure so it can gate a release check.
 */
import { fileURLToPath } from "node:url";

const distUrl = new URL("../dist/index.js", import.meta.url);
const dist = await import(fileURLToPath(distUrl));

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
dist.default(fakePi);

if (registered.size !== 2 || !registered.has("ptc_run_code") || !registered.has("ptc_workflow")) {
  console.error("FAIL: expected ptc_run_code + ptc_workflow, got:", [...registered.keys()]);
  process.exit(1);
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
