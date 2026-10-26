#!/usr/bin/env node
// PROTOTYPE - throwaway. Measures THIS PACKAGE's own feature surface against one installed pi.
// Usage: node surface-probe.mjs <node_modules-dir> <dist-dir>
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

const [, , nmArg, distArg] = process.argv;
if (!nmArg || !distArg) {
  console.error("usage: node surface-probe.mjs <node_modules-dir> <dist-dir>");
  process.exit(2);
}
const nm = realpathSync(nmArg);
const dist = realpathSync(distArg);

const loaderPath = join(tmpdir(), "surface-loader-" + Math.random().toString(36).slice(2) + ".mjs");
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

function makeFakePi(initialActive) {
  const active = [...initialActive];
  const registered = new Map();
  const handlers = new Map();
  const setToolsCalls = [];
  const statuses = [];
  const notifications = [];
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
      setToolsCalls.push([...list]);
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
      notify: (m, t) => notifications.push({ m, t }),
      setStatus: (_k, s) => statuses.push(s),
      theme: { fg: (_c, t) => t, bold: (t) => t },
    },
    sessionManager: { getEntries: () => [], getSessionDir: () => undefined },
    isProjectTrusted: () => true,
  };
  return { fakePi, registered, handlers, ctx, active, setToolsCalls, statuses, notifications };
}

function runFactory(scenario) {
  const codemodeActive = scenario === "subagents";
  const active0 = codemodeActive
    ? ["read", "bash", "edit", "write", "codemode"]
    : ["read", "bash", "edit", "write"];
  const h = makeFakePi(active0);
  distExports.default(h.fakePi, {
    codemode: codemodeActive
      ? { present: true, how: "found" }
      : { present: false, how: "not-found" },
    codemodeSwitch: { switch: "enabled", source: "default" },
    codemodeActivation: { activation: codemodeActive ? "active" : "inactive", source: "loadout" },
  });
  return h;
}

async function startSession(h) {
  const ss = h.handlers.get("session_start");
  await ss[0]({}, h.ctx);
}

const results = {};
async function feature(key, fn) {
  try {
    const detail = await fn();
    results[key] = { ok: true, detail: detail === undefined ? "" : String(detail) };
  } catch (e) {
    results[key] = {
      ok: false,
      detail: String(e && e.message ? e.message : e)
        .split("\n")[0]
        .slice(0, 160),
    };
  }
}

const hMain = runFactory("mainline");
const reg = hMain.registered;

await feature("F1 dist loads + session_start registers full surface", async () => {
  await startSession(hMain);
  const names = [...reg.keys()].sort().join(",");
  if (!reg.has("ptc_run_code") || !reg.has("ptc_workflow"))
    throw new Error("PTC surfaces missing: " + names);
  return names;
});

await feature("F2 surface=full: programming pair is DIRECT", async () => {
  const rc = reg.get("ptc_run_code");
  const wf = reg.get("ptc_workflow");
  if (rc.exposure !== "direct" || wf.exposure !== "direct")
    throw new Error("exposure=" + rc.exposure + "/" + wf.exposure);
  return "direct/direct";
});

await feature("F12 /ptc command registered", async () => {
  if (!hMain.handlers.has("cmd:ptc")) throw new Error("no /ptc command");
  return "cmd:ptc present";
});

await feature("F3 /ptc on narrows the loadout (read/bash hidden)", async () => {
  const cmd = hMain.handlers.get("cmd:ptc");
  await cmd.handler("on", hMain.ctx);
  if (hMain.active.includes("read") || hMain.active.includes("bash"))
    throw new Error("loadout still has read/bash: " + hMain.active.join(","));
  if (hMain.setToolsCalls.length === 0) throw new Error("setActiveTools never called");
  return "narrowed to: " + hMain.active.join(",");
});

const tmp = mkdtempSync(join(tmpdir(), "surface-probe-"));
writeFileSync(join(tmp, "f.txt"), "PTC_READ_OK");

await feature("F5 ptc_run_code executes a program using tools.read", async () => {
  const tool = reg.get("ptc_run_code");
  const runCtx = {
    cwd: tmp,
    sessionManager: { getSessionId: () => "probe", getSessionFile: () => undefined },
  };
  const res = await tool.execute(
    "probe",
    { code: "const r = await tools.read({ path: 'f.txt' });\nreturn r.content[0].text;" },
    undefined,
    undefined,
    runCtx,
  );
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  if (!text.includes("PTC_READ_OK")) throw new Error("output: " + text.slice(0, 120));
  return "read via program OK";
});

await feature("F6 binding tools.bash succeeds (real binding table, opt-in)", async () => {
  const bindings = distExports.createBuiltinBindings({ cwd: tmp, optIns: ["bash"] });
  const res = await bindings.get("bash").execute({ command: "echo PTC_BASH_OK" }, { callId: 1 });
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!text.includes("PTC_BASH_OK")) throw new Error("output: " + text.slice(0, 120));
  return "bash binding OK";
});

await feature("F7 failing tools.bash REJECTS capped, exit code kept", async () => {
  const bindings = distExports.createBuiltinBindings({ cwd: tmp, optIns: ["bash"] });
  let rejected = false;
  let message = "";
  try {
    await bindings.get("bash").execute({ command: "exit 3" }, { callId: 2 });
  } catch (e) {
    rejected = true;
    message = String(e.message);
  }
  if (!rejected) throw new Error("bash resolved instead of rejecting");
  if (!message.includes("Command exited with code 3"))
    throw new Error("exit-code sentence missing: " + message.slice(0, 120));
  if (message.length > 2100) throw new Error("uncapped: " + message.length);
  return "rejected, len=" + message.length;
});

await feature("F7b write+read bindings roundtrip in a program", async () => {
  const tool = reg.get("ptc_run_code");
  const runCtx = {
    cwd: tmp,
    sessionManager: { getSessionId: () => "probe", getSessionFile: () => undefined },
  };
  const res = await tool.execute(
    "probe",
    {
      code: "await tools.write({ path: 'w.txt', content: 'ROUNDTRIP_OK' });\nconst r = await tools.read({ path: 'w.txt' });\nreturn r.content[0].text;",
    },
    undefined,
    undefined,
    runCtx,
  );
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  if (!text.includes("ROUNDTRIP_OK")) throw new Error("output: " + text.slice(0, 120));
  return "write+read OK";
});

await feature("F8 pi.dispatch refuses unknown agent without spawning", async () => {
  const tool = reg.get("ptc_run_code");
  const runCtx = {
    cwd: tmp,
    sessionManager: { getSessionId: () => "probe", getSessionFile: () => undefined },
  };
  const res = await tool.execute(
    "probe",
    {
      code: 'const r = await tools["pi.dispatch"]({ agent: "surface-probe-ghost", task: "t", agentScope: "project" });\nreturn r.status + ":" + (r.errorMessage ?? "");',
    },
    undefined,
    undefined,
    runCtx,
  );
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  if (!text.includes("rejected")) throw new Error("output: " + text.slice(0, 120));
  return "refused: " + text.slice(0, 90);
});

await feature("F9 ptc_task_list resolves", async () => {
  const tool = reg.get("ptc_task_list");
  const runCtx = {
    cwd: tmp,
    sessionManager: { getSessionId: () => "probe", getSessionFile: () => undefined },
  };
  const res = await tool.execute("probe", {}, undefined, undefined, runCtx);
  const text = (res.content ?? []).map((b) => b.text ?? "").join("");
  return "resolved, " + text.length + " chars";
});

await feature("F10 ptc_child_report registered (parent-inactive)", async () => {
  const t = reg.get("ptc_child_report");
  if (!t) throw new Error("missing");
  return (
    "registered; outputSchema key=" +
    ("outputSchema" in t) +
    " defaultActive=" +
    (t.defaultActive ?? "(unset)")
  );
});

await feature("F11 renderers produce output for ptc_run_code", async () => {
  const t = reg.get("ptc_run_code");
  const theme = { fg: (_c, s) => s, bold: (s) => s, dim: (s) => s };
  const call = t.renderCall({}, theme);
  const rendered = typeof call === "string" ? call : JSON.stringify(call);
  if (!rendered || rendered.length === 0) throw new Error("empty renderCall");
  return "renderCall " + rendered.length + " chars";
});

await feature("F13 codemode probes resolve on this pi (no throw)", async () => {
  const presence = distExports.probeCodemodePresence
    ? distExports.probeCodemodePresence(["node", "probe"])
    : "n/a";
  return "presence=" + JSON.stringify(presence);
});

await feature("F12b /ptc off restores the base loadout", async () => {
  const cmd = hMain.handlers.get("cmd:ptc");
  await cmd.handler("off", hMain.ctx);
  if (!hMain.active.includes("read") || !hMain.active.includes("bash"))
    throw new Error("loadout not restored: " + hMain.active.join(","));
  return "restored: " + hMain.active.join(",");
});

const shipsCodemode = existsSync(
  join(nm, "@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js"),
);
if (shipsCodemode) {
  const hSub = runFactory("subagents");
  const regSub = hSub.registered;
  await feature("F14 surface=subagents: pair at codemode reach, subagent tool direct", async () => {
    await startSession(hSub);
    const rc = regSub.get("ptc_run_code");
    const sub = regSub.get("ptc_subagent");
    if (!sub) throw new Error("ptc_subagent missing");
    if (rc.exposure !== "codemode") throw new Error("run_code exposure=" + rc.exposure);
    const subExp = sub.exposure ?? "direct";
    if (subExp !== "direct") throw new Error("subagent exposure=" + subExp);
    return "run_code=codemode, subagent=direct";
  });
} else {
  results["F14 surface=subagents branch"] = {
    ok: true,
    detail: "N/A - this pi does not ship codemode (branch unreachable)",
  };
}

console.log(JSON.stringify({ results }, null, 2));
