#!/usr/bin/env node
// PROTOTYPE - throwaway. Answers: for EVERY pi version from 0.86.0 to latest, which capability
// points exist? Emits a markdown table (rows = capabilities, columns = versions).
// Usage: node capability-probe.mjs <workdir-with-installed-trees.json> > table.md
// The JSON: { "<version>": "<path-to-node_modules>" } - the driver builds it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const mapPath = process.argv[2];
if (!mapPath) {
  console.error("usage: node capability-probe.mjs <trees.json>");
  process.exit(2);
}
const trees = JSON.parse(readFileSync(mapPath, "utf8"));
const versions = Object.keys(trees).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true }),
);

// --- capability probes -------------------------------------------------------
// Each probe: (nm) => string | boolean. string = detail; boolean = has/hasn't.
// Static probes read the tree; runtime probes import through the realpath loader.
const ca = join; // alias
function pkg(nm, name) {
  return join(nm, "@earendil-works", name);
}
function rd(nm, name, rel) {
  const p = join(pkg(nm, name), rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function agentCoreDir(nm) {
  // resolve through .pnpm (top-level symlink may be absent on older layouts)
  const direct = pkg(nm, "pi-agent-core");
  if (existsSync(direct)) return direct;
  const pnpm = join(nm, ".pnpm");
  if (!existsSync(pnpm)) return null;
  const dir = readdirSync(pnpm).find((d) => d.startsWith("@earendil-works+pi-agent-core@"));
  return dir ? join(pnpm, dir, "node_modules", "@earendil-works", "pi-agent-core") : null;
}

const CAPS = {
  "C1 isError channel (AgentToolResult.isError + bash uses it)": (nm) => {
    const core = agentCoreDir(nm);
    if (!core) return false;
    const t = readFileSync(join(core, "dist", "types.d.ts"), "utf8");
    const has = t.includes("isError");
    const bash = rd(nm, "pi-coding-agent", "dist/core/tools/bash.js") ?? "";
    return has && bash.includes("isError: true");
  },
  "C2 ToolDefinition.outputSchema": (nm) => {
    const t = rd(nm, "pi-coding-agent", "dist/core/extensions/types.d.ts");
    return t ? t.includes("outputSchema") : false;
  },
  "C3 ToolDefinition.exposure": (nm) => {
    const t = rd(nm, "pi-coding-agent", "dist/core/extensions/types.d.ts");
    return t ? t.includes("exposure") : false;
  },
  "C4 agent-session honors exposure (_getToolExposure)": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/core/agent-session.js");
    return s ? s.includes("_getToolExposure") : false;
  },
  "C5 agent-loop forwards structuredContent": (nm) => {
    const core = agentCoreDir(nm);
    if (!core) return false;
    const s = readFileSync(join(core, "dist", "agent-loop.js"), "utf8");
    return s.includes("structuredContent");
  },
  "C6 codemode ships (extensions/codemode/tool.js)": (nm) =>
    existsSync(join(pkg(nm, "pi-coding-agent"), "dist/extensions/codemode/tool.js")),
  "C7 MCP auto-enable (ensureDiscoveryActive)": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/extensions/mcp/index.js");
    return s ? s.includes("ensureDiscoveryActive") : false;
  },
  "C8 extension patterns normalized (normalizePath in matchers)": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/core/package-manager.js");
    return s
      ? /matchesAnyPattern[\s\S]{0,400}normalizePath/.test(s) ||
          s.includes("toPosixPath(normalizePath(")
      : false;
  },
  "C9 codemode declares reachesTools": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/extensions/codemode/tool.js");
    return s ? s.includes("reachesTools") : false;
  },
  "C10 BeforeAgentStartEvent is a messageType union": (nm) => {
    const t = rd(nm, "pi-coding-agent", "dist/core/extensions/types.d.ts");
    return t ? t.includes("BeforeAgentStartUserEvent") : false;
  },
  "C11 ToolRenderContext durationMs + outputPad": (nm) => {
    const t = rd(nm, "pi-coding-agent", "dist/core/extensions/types.d.ts");
    return t ? t.includes("outputPad") && t.includes("durationMs") : false;
  },
  "C12 registerToolRenderer API": (nm) => {
    const t = rd(nm, "pi-coding-agent", "dist/core/extensions/types.d.ts");
    return t ? t.includes("registerToolRenderer") : false;
  },
  "C13 print-mode truncation exits 1 (stderr warning)": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/modes/print-mode.js");
    return s ? s.includes("Response was truncated") : false;
  },
  "C14 formatSkillsForPrompt supports indirect": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/core/skills.js");
    return s ? s.includes("indirect") : false;
  },
  "C15 published settings schema (schemas/settings.schema.json)": (nm) =>
    existsSync(join(pkg(nm, "pi-coding-agent"), "schemas", "settings.schema.json")),
  "C16 --tools keeps MCP tools unless mcp__ entry": (nm) => {
    const s = rd(nm, "pi-coding-agent", "dist/core/settings-manager.js") ?? "";
    const d = rd(nm, "pi-coding-agent", "dist/core/sdk.d.ts") ?? "";
    return d.includes("mcp__") || s.includes("mcp__");
  },
};

// --- emit --------------------------------------------------------------------
const lines = [];
const header = ["capability", ...versions];
lines.push("| " + header.join(" | ") + " |");
lines.push("|" + header.map(() => "---").join("|") + "|");
for (const [cap, probe] of Object.entries(CAPS)) {
  const cells = versions.map((v) => {
    const nm = trees[v];
    if (!nm || !existsSync(join(nm, "@earendil-works", "pi-coding-agent"))) return "n/a";
    let out;
    try {
      out = probe(nm);
    } catch (e) {
      out = "ERR:" + String(e.message).slice(0, 30);
    }
    if (out === true) return "✓";
    if (out === false) return "✗";
    return "✓ " + String(out);
  });
  lines.push("| " + cap + " | " + cells.join(" | ") + " |");
}
console.log(lines.join("\n"));
