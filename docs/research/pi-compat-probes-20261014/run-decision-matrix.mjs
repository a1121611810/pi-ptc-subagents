#!/usr/bin/env node
// PROTOTYPE helper: runs surface-decision-probe.mjs against every installed tree and prints the
// decision x version matrix. The subagents branch is exercised on EVERY version: it is this
// package's own mechanism, independent of whether the pi under test ships codemode.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trees = JSON.parse(readFileSync("/tmp/trees-full.json", "utf8"));
const versions = Object.keys(trees).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true }),
);
const probe = new URL("./surface-decision-probe.mjs", import.meta.url).pathname;
const dist = new URL("../../dist", import.meta.url).pathname;

const all = {};
for (const v of versions) {
  process.stdout.write("probing " + v + "... ");
  const r = spawnSync(process.execPath, [probe, trees[v], dist, "auto"], {
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = { __crashed: (r.stderr ?? "").split("\n").slice(-2).join(" | ").slice(0, 140) };
    console.log("CRASH");
    all[v] = parsed;
    continue;
  }
  all[v] = parsed;
  const s = parsed.surfaces ?? {};
  console.log(
    "subagents=" +
      s.subagents +
      " fullAbsent=" +
      s.fullAbsent +
      " disabled=" +
      s.disabledSwitch +
      " inactive=" +
      s.inactiveActivation +
      " realPi=" +
      (s.drivenByRealPiInputs?.surfaceMode ?? "?") +
      " presence=" +
      JSON.stringify(parsed.presence) +
      " dirExists=" +
      parsed.codemodeDirExists +
      " subagentReg=" +
      parsed.registration?.subagents?.subagentRegistered,
  );
}

// matrix: one row per version, the decision under each input set + the registration outcome
console.log("");
console.log(
  "| version | presence (real pi) | codemode dir | decision: subagents inputs | absent | disabled | inactive | driven by real pi | ptc_subagent registered? | run_code exposure (subagents) |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const v of versions) {
  const d = all[v];
  if (d.__crashed) {
    console.log("| " + v + " | CRASH | | | | | | | | " + d.__crashed + " |");
    continue;
  }
  const s = d.surfaces ?? {};
  console.log(
    "| " +
      v +
      " | " +
      JSON.stringify(d.presence) +
      " | " +
      d.codemodeDirExists +
      " | " +
      s.subagents +
      " | " +
      s.fullAbsent +
      " | " +
      s.disabledSwitch +
      " | " +
      s.inactiveActivation +
      " | " +
      (s.drivenByRealPiInputs?.surfaceMode ?? "?") +
      " | " +
      d.registration?.subagents?.subagentRegistered +
      " | " +
      d.registration?.subagents?.runCodeExposure +
      " |",
  );
}
