/**
 * Visual preview of how the PTC tools render in pi's TUI.
 *
 * Uses pi's real theme instance (not a stub) and calls the built dist's `renderCall` /
 * `renderResult` with the exact same argument shape pi's `ToolExecutionComponent.updateDisplay()`
 * passes:
 *
 *   renderCall(this.args, theme, context)
 *   renderResult({ content, details }, { expanded, isPartial }, theme, context)
 *
 * Prints the composed rows (call line + result line, as they sit inside the tool's content box)
 * with ANSI colors, so the terminal shows what the interactive TUI shows.
 *
 * Usage: node scripts/preview-ptc-render.mjs [width]
 */
import { fileURLToPath } from "node:url";

const PI = "/Users/lilianda/.bun/install/global/node_modules/@earendil-works/pi-coding-agent";

// Real theme: initTheme() populates the singleton `theme` export for a terminal mode.
const themeMod = await import(`${PI}/dist/modes/interactive/theme/theme.js`);
themeMod.initTheme?.("dark");
const theme = themeMod.theme;

const dist = await import(fileURLToPath(new URL("../dist/index.js", import.meta.url)));

const registered = new Map();
dist.default({
  registerTool: (d) => registered.set(d.name, d),
  registerCommand: () => {},
  on: () => () => {},
  getActiveTools: () => ["read", "bash"],
  setActiveTools: () => {},
  appendEntry: () => {},
});

const WIDTH = Number(process.argv[2] ?? 100);

/** Mimic ToolExecutionComponent: call renderer, render(width), join lines. */
const paint = (component) => component.render(WIDTH).join("\n").replace(/\s+$/gm, "");

function row(label, callArgs, result, expanded = false) {
  const def = registered.get(callArgs.__tool);
  const args = { ...callArgs };
  delete args.__tool;

  console.log(`\n\x1b[2m${label}\x1b[0m`);
  // Call line
  const callComponent = def.renderCall(args, theme, {
    args,
    isError: false,
    expanded: false,
    isPartial: false,
  });
  console.log(`\x1b[90m│\x1b[0m ${paint(callComponent)}`);
  // Result line(s)
  if (result !== undefined) {
    const resultComponent = def.renderResult(
      { content: result.content ?? [{ type: "text", text: "" }], details: result.details },
      { expanded, isPartial: false },
      theme,
      { args, isError: result.isError ?? false, expanded, isPartial: false },
    );
    console.log(`\x1b[90m│\x1b[0m ${paint(resultComponent)}`);
  }
}

const codeArgs = {
  __tool: "ptc_run_code",
  code: "// read the manifest\nconst pkg = await tools.read({ path: 'package.json' });\nreturn JSON.parse(pkg.content[0].text).version;",
  description: "Read package.json and extract version",
};

const runCodeDetails = {
  surface: "run_code",
  logs: ["[ptc] parsed manifest"],
  narrations: [],
  phases: [],
  warnings: [],
  result: { name: "pi-ptc-subagents", version: "0.1.0" },
  durationMs: 412,
};

const wfArgs = {
  __tool: "ptc_workflow",
  meta: {
    name: "audit-deps",
    description: "Audit dependency versions",
    phases: [{ name: "collect" }, { name: "compare" }, { name: "report" }],
  },
  script:
    "const pkg = await tools.read({ path: 'package.json' });\nlog('read manifest');\nphase('collect');\nreturn { ok: true };",
};

const wfDetails = {
  surface: "workflow",
  logs: ["[ptc] done"],
  narrations: ["read manifest"],
  phases: ["collect", "compare", "report"],
  warnings: ['phase "compare" is not listed in meta.phases (declared: collect, report)'],
  result: { ok: true, deps: 12 },
  durationMs: 1480,
};

console.log(`\x1b[1m\nPTC tool rendering preview — width ${WIDTH}\x1b[0m`);
console.log(
  "\x1b[2m(each │ block is one tool row inside pi's default content box; colors from pi's dark theme)\x1b[0m",
);

row("ptc_run_code · collapsed", codeArgs, { details: runCodeDetails });
row("ptc_run_code · collapsed (failed)", codeArgs, {
  content: [
    { type: "text", text: "code run failed (exception): ReferenceError: pkg is not defined" },
  ],
  details: { ...runCodeDetails, result: undefined, logs: [], durationMs: 96 },
  isError: true,
});
row("ptc_run_code · expanded (ctrl+e)", codeArgs, { details: runCodeDetails }, true);
row("ptc_workflow · collapsed", wfArgs, { details: wfDetails });
row("ptc_workflow · expanded (ctrl+e)", wfArgs, { details: wfDetails }, true);

console.log();
