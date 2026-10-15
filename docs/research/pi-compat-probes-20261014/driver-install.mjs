#!/usr/bin/env node
// PROTOTYPE helper: installs one pi version into a cached tree and prints the node_modules path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
const base = "/tmp/pi-cap-matrix";
const dir = join(base, "v" + version.replace(/\./g, "-"));
const nm = join(dir, "node_modules");
const marker = join(dir, ".installed");

if (existsSync(marker)) {
  console.log(nm);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const pkg = {
  name: "pi-cap-probe-" + version,
  private: true,
  type: "module",
  devDependencies: {
    "@earendil-works/pi-ai": version,
    "@earendil-works/pi-coding-agent": version,
    "@earendil-works/pi-tui": version,
  },
};
writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
// pin the whole @earendil-works/* family to the same version: pi-coding-agent 1.0.x imports
// MCP_TYPESCRIPT_PREAMBLE from pi-codemode, an export removed in pi-codemode 1.2.0. Without the
// pin pnpm resolves the newest sibling under an older pi and the tree cannot even load.
const ws = join(dir, "pnpm-workspace.yaml");
writeFileSync(
  ws,
  [
    "packages:",
    "  - .",
    "overrides:",
    '  "@earendil-works/pi-coding-agent": ' + version,
    '  "@earendil-works/pi-ai": ' + version,
    '  "@earendil-works/pi-tui": ' + version,
    '  "@earendil-works/pi-codemode": ' + version,
    '  "@earendil-works/pi-mcp": ' + version,
    '  "@earendil-works/pi-agent-core": ' + version,
    '  "@earendil-works/pi-telemetry": ' + version,
    "",
  ].join("\n"),
);
const r = spawnSync("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
  cwd: dir,
  encoding: "utf8",
  timeout: 5 * 60_000,
});
if (r.status !== 0 || !existsSync(join(nm, "@earendil-works/pi-coding-agent"))) {
  console.error("INSTALL FAILED for " + version + ":\n" + (r.stdout ?? "") + (r.stderr ?? ""));
  process.exit(1);
}
writeFileSync(marker, new Date().toISOString());
console.log(nm);
