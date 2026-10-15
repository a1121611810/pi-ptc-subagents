#!/usr/bin/env node
// PROTOTYPE - throwaway. Answers the user's correction: the SUBAGENTS BRANCH is an INDEPENDENT
// mechanism of this package, not a property of pi. It must be exercised on EVERY version by
// feeding the surface DECISION the inputs that select it - what varies per version is one INPUT
// (the presence probe, read off the real pi's file layout).
//
// Usage: node surface-decision-probe.mjs <node_modules-dir> <dist-dir> [pi-entry-script]
// The pi entry script (the installed pi's bin/pi path) is what probeCodemodePresence walks.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

const [, , nmArg, distArg, entryArg] = process.argv;
if (!nmArg || !distArg) {
  console.error("usage: node surface-decision-probe.mjs <node_modules-dir> <dist-dir> [pi-entry]");
  process.exit(2);
}
const nm = realpathSync(nmArg);
const dist = realpathSync(distArg);
const piPkg = join(nm, "@earendil-works", "pi-coding-agent");
const entry =
  entryArg && entryArg !== "auto"
    ? entryArg
    : join(piPkg, JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8")).bin.pi);

const loaderPath = join(tmpdir(), "sd-loader-" + Math.random().toString(36).slice(2) + ".mjs");
writeFileSync(
  loaderPath,
  [
    'import { existsSync, realpathSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const BASE = " + JSON.stringify(nm) + ";",
    "export function resolve(specifier, context, next) {",
    '  if (specifier.startsWith("@earendil-works/")) {',
    '    const sub = specifier.slice("@earendil-works/".length);',
    '    const candidates = sub.includes("/")',
    '      ? [BASE + "/" + sub]',
    "      : [",
    '          BASE + "/@earendil-works/" + sub + "/dist/index.js",',
    '          BASE + "/@earendil-works/" + sub + "/index.js",',
    "        ];",
    "    const hit = candidates.find((c) => existsSync(c));",
    "    if (hit) return { url: pathToFileURL(realpathSync(hit)).href, shortCircuit: true };",
    "  }",
    "  return next(specifier, context);",
    "}",
  ].join("\n"),
);
register(pathToFileURL(loaderPath).href, pathToFileURL(nm + "/"));

const distExports = await import(pathToFileURL(join(dist, "index.js")).href);

// ---- INPUT 1: presence, read the way production reads it (off the real pi entry) -------------
// probeCodemodePresence walks dirname(realpath(argv[1])) then ../extensions/codemode etc.
// We drive it with the INSTALLED pi's own entry script - the honest argv a real session has.
function presenceFromEntry() {
  return distExports.probeCodemodePresence(["node", entry]);
}
// and the ground truth, for cross-checking the probe against the filesystem
function codemodeDirExists() {
  try {
    return statSync(join(piPkg, "dist", "extensions", "codemode")).isDirectory();
  } catch {
    return false;
  }
}

// ---- INPUT 2 / 3: switch + activation, resolved by OUR readers against real settings ---------
// A fresh temp "agent dir" with an explicit +builtin:codemode (switch=enabled) and an
// activation input; both readers are this package's own code, independent of pi.
const agentDir = mkdtempSync(join(tmpdir(), "sd-agent-"));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ extensions: ["+builtin:codemode"] }),
);
let switchRes;
try {
  switchRes = distExports.readCodemodeSwitch(agentDir, agentDir, ["node", "pi"]);
} catch (e) {
  switchRes = { thrown: String(e && e.message ? e.message : e).split("\n")[0] };
}
// activation, resolved from the live loadout our fake pi reports (codemode active => "active")
let activationRes;
try {
  activationRes = distExports.resolveCodemodeActivation([
    "read",
    "bash",
    "edit",
    "write",
    "codemode",
  ]);
} catch (e) {
  activationRes = { thrown: String(e && e.message ? e.message : e).split("\n")[0] };
}

// ---- THE DECISION, exercised on THIS version ------------------------------------------------
// detectedSurfaceMode is NOT re-exported from dist (finding), so drive it through
// detectSurfaceMode - the factory-level function that composes the same three inputs.
// detectSurfaceMode(agentDir, activeToolNames, presence?, switch?, activation?, cwd?)
// The three probe answers are OPTIONAL OVERRIDES over what it would otherwise read, so the
// decision can be driven with chosen inputs on ANY version - that is the seam that proves the
// decision is independent of pi.
const ACTIVE_WITH_CODEMODE = ["read", "bash", "edit", "write", "codemode"];
const ACTIVE_WITHOUT = ["read", "bash", "edit", "write"];

// detectedSurfaceMode is now re-exported from the dist, so the decision is driven DIRECTLY -
// no detour through the factory-level detectSurfaceMode. This is the seam my earlier probe
// could not reach, which is why it substituted a presence check for a decision check.
const decidedDirectly = typeof distExports.detectedSurfaceMode === "function";
const subagentsSurface = distExports.detectedSurfaceMode(
  { present: true, how: "found" },
  "enabled",
  "active",
);
const fullAbsentSurface = distExports.detectedSurfaceMode(
  { present: false, how: "not-found" },
  "enabled",
  "active",
);
const disabledSurface = distExports.detectedSurfaceMode(
  { present: true, how: "found" },
  "disabled",
  "active",
);
const inactiveSurface = distExports.detectedSurfaceMode(
  { present: true, how: "found" },
  "enabled",
  "inactive",
);
// The un-driven path: presence passed as production's argv[1] (the pi entry script); the switch
// and activation are resolved by our own readers against real settings and the live loadout.
// This is what production actually does on this version.
const drivenByRealPi = distExports.detectSurfaceMode(
  agentDir,
  ACTIVE_WITH_CODEMODE,
  presenceFromEntry(),
  undefined,
  undefined,
  agentDir,
);

// ---- and the REGISTRATION the branch produces, on THIS version's runtime --------------------
function makeFakePi(initialActive) {
  const active = [...initialActive];
  const registered = new Map();
  const handlers = new Map();
  const fakePi = {
    registerTool: (def) => registered.set(def.name, def),
    registerCommand: (name, def) => handlers.set("cmd:" + name, def),
    on: (event, fn) => {
      const arr = handlers.get(event) ?? [];
      arr.push(fn);
      handlers.set(event, arr);
      return () => {};
    },
    getActiveTools: () => [...active, ...registered.keys()],
    getAllTools: () => [...active, ...registered.keys()].map((n) => ({ name: n })),
    setActiveTools: (list) => {
      active.length = 0;
      active.push(...list);
    },
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    getSessionDir: () => undefined,
  };
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => {},
      setStatus: () => {},
      theme: { fg: (_c, t) => t, bold: (t) => t },
    },
    sessionManager: { getEntries: () => [], getSessionDir: () => undefined },
    isProjectTrusted: () => true,
  };
  return { fakePi, registered, handlers, ctx, active };
}

async function registrationFor(scenario) {
  const isSub = scenario === "subagents";
  const h = makeFakePi(
    isSub ? ["read", "bash", "edit", "write", "codemode"] : ["read", "bash", "edit", "write"],
  );
  distExports.default(h.fakePi, {
    codemode: isSub ? { present: true, how: "found" } : { present: false, how: "not-found" },
    codemodeSwitch: { switch: "enabled", source: "default" },
    codemodeActivation: { activation: isSub ? "active" : "inactive", source: "loadout" },
  });
  await h.handlers.get("session_start")[0]({}, h.ctx);
  const rc = h.registered.get("ptc_run_code");
  const sub = h.registered.get("ptc_subagent");
  return {
    runCodeExposure: rc?.exposure ?? "(none)",
    subagentRegistered: Boolean(sub),
    subagentExposure: sub ? (sub.exposure ?? "direct") : "(none)",
    tools: [...h.registered.keys()].sort().join(","),
  };
}

const out = {
  piEntry: entry,
  decisionDrivenDirectly: decidedDirectly,
  presence: presenceFromEntry(),
  codemodeDirExists: codemodeDirExists(),
  switchFromSettings: switchRes,
  activationFromLoadout: activationRes,
  surfaces: {
    subagents: subagentsSurface,
    fullAbsent: fullAbsentSurface,
    disabledSwitch: disabledSurface,
    inactiveActivation: inactiveSurface,
    drivenByRealPiInputs: {
      surfaceMode: drivenByRealPi.surfaceMode,
      codemode: drivenByRealPi.codemode,
      switch: drivenByRealPi.codemodeSwitch,
      activation: drivenByRealPi.codemodeActivation,
    },
  },
  registration: {
    subagents: await registrationFor("subagents"),
    full: await registrationFor("full"),
  },
};
console.log(JSON.stringify(out, null, 2));
