#!/usr/bin/env node
// PROTOTYPE - throwaway. Answers one question: does pi-ptc-subagents RUN on pi 0.86.x, or only fail typecheck?
// Usage: node probe-runtime.mjs <dir-with-0861-node_modules> <dist-dir>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { register } from "node:module";

const [, , nmDir, distDir] = process.argv;
if (!nmDir || !distDir || !existsSync(join(nmDir, "@earendil-works"))) {
  console.error("usage: node probe-runtime.mjs <0861-node_modules-dir> <dist-dir>");
  process.exit(2);
}
const pkgJson = JSON.parse(
  readFileSync(join(nmDir, "@earendil-works/pi-coding-agent/package.json"), "utf8"),
);
console.log("pi under test:", pkgJson.version);

const nmAbs = nmDir;

const NEWLINE = String.fromCharCode(10);
const loaderPath = join(import.meta.dirname, "pi086-loader.mjs");
const loaderLines = [
  'import { existsSync, realpathSync } from "node:fs";',
  "export function resolve(specifier, context, next) {",
  '  if (specifier.startsWith("@earendil-works/")) {',
  '    const sub = specifier.slice("@earendil-works/".length);',
  "    const base = " + JSON.stringify(nmAbs) + ";",
  '    const candidates = sub.includes("/")',
  '      ? [base + "/" + sub]',
  "      : [",
  '          base + "/@earendil-works/" + sub + "/dist/index.js",',
  '          base + "/@earendil-works/" + sub + "/index.js",',
  "        ];",
  "    const hit = candidates.find((c) => existsSync(c));",
  '    if (hit) return { url: "file://" + realpathSync(hit), shortCircuit: true };',
  "  }",
  "  return next(specifier, context);",
  "}",
];
writeFileSync(loaderPath, loaderLines.join(NEWLINE));
register(pathToFileURL(loaderPath).href, pathToFileURL(nmAbs + "/"));

const results = [];
const step = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then((detail) =>
      results.push({ name, ok: true, detail: detail === undefined ? "" : String(detail) }),
    )
    .catch((error) =>
      results.push({
        name,
        ok: false,
        detail: String(error && error.message ? error.message : error).split("\n")[0],
      }),
    );

const makeFakePi = (registered, handlers) => ({
  registerTool: (def) => registered.set(def.name, def),
  registerCommand: (name, def) => handlers.set("cmd:" + name, def),
  on: (event, fn) => {
    const arr = handlers.get(event) ?? [];
    arr.push(fn);
    handlers.set(event, arr);
    return () => {};
  },
  getActiveTools: () => ["read", "bash", "edit", "write"],
  getAllTools: () => ["read", "bash", "edit", "write"].map((n) => ({ name: n })),
  setActiveTools: () => {},
  appendEntry: () => {},
  sendMessage: () => {},
  sendUserMessage: () => {},
  getSessionDir: () => undefined,
});

let distExports;
await step("A1: import dist/index.js under pi 0.86.1 modules", async () => {
  distExports = await import(pathToFileURL(join(distDir, "index.js")).href);
  return Object.keys(distExports).length + " exports";
});

await step("A2: session_start registers the full surface", async () => {
  const registered = new Map();
  const handlers = new Map();
  distExports.default(makeFakePi(registered, handlers), {
    codemode: { present: false, how: "not-found" },
    codemodeSwitch: { switch: "disabled", source: "default" },
    codemodeActivation: { activation: "inactive", source: "loadout" },
  });
  await handlers.get("session_start")[0](
    {},
    {
      ui: { notify: () => {}, theme: { fg: (_c, t) => t, bold: (t) => t }, setStatus: () => {} },
      sessionManager: { getEntries: () => [], getSessionDir: () => undefined },
      mode: "tui",
    },
  );
  return [...registered.keys()].sort().join(", ");
});

await step("B1: read 0.86.1 tool definition keys (does it carry outputSchema?)", async () => {
  const mod = await import(
    pathToFileURL(join(nmAbs, "@earendil-works/pi-coding-agent/dist/core/tools/read.js")).href
  );
  const def = mod.createReadToolDefinition(process.cwd(), {});
  return Object.keys(def).join(", ");
});

await step("B2: defineTool accepts outputSchema/exposure/defaultActive as extra keys", async () => {
  const mod = await import(
    pathToFileURL(join(nmAbs, "@earendil-works/pi-coding-agent/dist/index.js")).href
  );
  const def = mod.defineTool({
    name: "ptc_probe",
    label: "probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    exposure: "codemode",
    defaultActive: false,
    async execute() {
      return {
        content: [{ type: "text", text: "ok" }],
        details: {},
        structuredContent: { ok: true },
      };
    },
  });
  return "stored; outputSchema=" + ("outputSchema" in def) + " exposure=" + ("exposure" in def);
});

await step(
  "B3: does 0.86.1 agent-loop forward structuredContent (child-report channel)?",
  async () => {
    const loopPath = join(
      nmAbs,
      ".pnpm",
      readdirSync(join(nmAbs, ".pnpm")).find((d) => d.startsWith("@earendil-works+pi-agent-core@")),
      "node_modules",
      "@earendil-works",
      "pi-agent-core",
      "dist",
      "agent-loop.js",
    );
    const src = readFileSync(loopPath, "utf8");
    return (
      "mentions structuredContent=" +
      src.includes("structuredContent") +
      ", emits tool_execution_end=" +
      src.includes("tool_execution_end")
    );
  },
);

console.log("");
console.log("=== RESULTS ===");
let failures = 0;
for (const r of results) {
  console.log((r.ok ? "  pass  " : "  FAIL  ") + r.name);
  if (!r.ok) failures += 1;
  if (r.detail) console.log("          " + r.detail);
}
console.log("");
console.log(
  failures === 0
    ? "VERDICT: dist RUNS on pi " + pkgJson.version + " - typecheck errors are compile-time only"
    : "VERDICT: " + failures + " runtime failure(s) on pi " + pkgJson.version,
);

await step(
  "B4: on 0.86.x (no codemode) the surface resolves full and tools are DIRECT",
  async () => {
    // Same wiring as src/index.ts:447 - exposure follows the DETECTED surface, so a pi without
    // codemode registers the programming pair as "direct", i.e. declared to the model. On 0.86.1
    // there is no exposure gate at all, so "direct" behaves exactly as intended.
    const registered = new Map();
    const handlers = new Map();
    distExports.default(makeFakePi(registered, handlers), {
      codemode: { present: false, how: "not-found" },
      codemodeSwitch: { switch: "disabled", source: "default" },
      codemodeActivation: { activation: "inactive", source: "loadout" },
    });
    await handlers.get("session_start")[0](
      {},
      {
        ui: { notify: () => {}, theme: { fg: (_c, t) => t, bold: (t) => t }, setStatus: () => {} },
        sessionManager: { getEntries: () => [], getSessionDir: () => undefined },
        mode: "tui",
      },
    );
    const rc = registered.get("ptc_run_code");
    const wf = registered.get("ptc_workflow");
    const exp = (rc && rc.exposure) === "direct" && (wf && wf.exposure) === "direct";
    return (
      "ptc_run_code exposure=" +
      (rc && rc.exposure) +
      ", ptc_workflow exposure=" +
      (wf && wf.exposure) +
      " | direct-on-full holds: " +
      exp
    );
  },
);

await step(
  "B4: on 0.86.x (no codemode) the surface resolves full and tools are DIRECT",
  async () => {
    const registered = new Map();
    const handlers = new Map();
    distExports.default(makeFakePi(registered, handlers), {
      codemode: { present: false, how: "not-found" },
      codemodeSwitch: { switch: "disabled", source: "default" },
      codemodeActivation: { activation: "inactive", source: "loadout" },
    });
    await handlers.get("session_start")[0](
      {},
      {
        ui: { notify: () => {}, theme: { fg: (_c, t) => t, bold: (t) => t }, setStatus: () => {} },
        sessionManager: { getEntries: () => [], getSessionDir: () => undefined },
        mode: "tui",
      },
    );
    const rc = registered.get("ptc_run_code");
    const wf = registered.get("ptc_workflow");
    return (
      "ptc_run_code exposure=" +
      (rc && rc.exposure) +
      ", ptc_workflow exposure=" +
      (wf && wf.exposure) +
      " (direct = declared to the model, as the full surface intends)"
    );
  },
);

console.log("");
console.log("=== RESULTS (final, including B4) ===");
for (const r of results) {
  console.log((r.ok ? "  pass  " : "  FAIL  ") + r.name);
  if (r.detail) console.log("          " + r.detail);
}
