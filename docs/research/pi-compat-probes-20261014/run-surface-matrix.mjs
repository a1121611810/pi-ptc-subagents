#!/usr/bin/env node
// PROTOTYPE helper: runs surface-probe.mjs against every installed tree and prints the
// feature x version matrix in markdown.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trees = JSON.parse(readFileSync("/tmp/trees-full.json", "utf8"));
const versions = Object.keys(trees).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true }),
);
const probe = new URL("./surface-probe.mjs", import.meta.url).pathname;
const dist = new URL("../../dist", import.meta.url).pathname;

const all = {};
for (const v of versions) {
  process.stdout.write("probing " + v + "... ");
  const r = spawnSync(process.execPath, [probe, trees[v], dist], {
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = {
      results: {
        "F0 probe crashed": {
          ok: false,
          detail: (r.stderr ?? "").split("\n").slice(-3).join(" | ").slice(0, 160),
        },
      },
    };
  }
  all[v] = parsed.results;
  const pass = Object.values(all[v]).filter((x) => x.ok).length;
  console.log(pass + "/" + Object.keys(all[v]).length + " pass");
}

// feature keys in stable order (union across versions)
const keys = [];
for (const v of versions) for (const k of Object.keys(all[v])) if (!keys.includes(k)) keys.push(k);

console.log("");
console.log("| feature | " + versions.join(" | ") + " |");
console.log("|" + versions.map(() => "---").join("|") + "|");
for (const k of keys) {
  const cells = versions.map((v) => {
    const r = all[v][k];
    if (!r) return "n/a";
    return r.ok ? "✓" : "✗ " + r.detail.slice(0, 60);
  });
  console.log("| " + k + " | " + cells.join(" | ") + " |");
}
