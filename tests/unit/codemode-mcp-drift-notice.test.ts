/**
 * ADR-0033, at the level the user sees it: the drift notice, and the MCP-evidence session that
 * never needs one.
 *
 * The evidence probe (ADR-0033, `codemode-mcp-evidence.test.ts`) predicts activation from config.
 * Two things can still make the real loadout disagree, and they are different in kind:
 *
 *   - pi activated codemode by a path no config records — the MCP extension is the one that
 *     exists today, but any extension calling `setActiveTools` does it too — or the evidence
 *     could not read the mcp.json that would have said so. The probe said `inactive`, the surface
 *     defaulted to `full`, and the model now sees two orchestration surfaces. ADR-0033's notice
 *     compares the probe's answer with `pi.getActiveTools()` and reports the difference, once.
 *   - the mcp.json DID say so, the probe followed it, and the session resolved `subagents`
 *     against a live codemode — the case ADR-0029 could not reach and the double surface cannot
 *     occur. Asserted here on the REGISTERED TOOL SET, not on the probe's answer: a probe that
 *     stopped consulting the evidence would keep `detectedSurfaceMode` green.
 *
 * Both cases are built through `makeStubInAgentDir`, so the factory really reads a temp agent dir
 * and the real `settings.json` / `mcp.json` probes run — a test that pinned `surfaceMode` would
 * set `source: "file"` and could not reach either cell, which is the point of pinning nothing.
 */
import { expect, test } from "vitest";
import { makeStubInAgentDir, removeTempDir, stubContext } from "../helpers/ptc.ts";

/** BG-14: the three always-on background-task tools, in registration order. */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;

/** What the `full` surface registers, in registration order — asserted exactly, not by contains. */
const FULL_TOOLS = ["ptc_run_code", "ptc_workflow", ...TASK_TOOLS, "ptc_child_report"];

/** The message of the ADR-0033 drift notice. */
const DRIFT = "codemode is active in this session";

/** An agent-dir mcp.json naming one stdio server — pi's default-exposure, auto-enable case. */
const MCP_JSON = JSON.stringify({
  mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } },
});

/**
 * Emit `session_start` and then one turn against the stub, and return what the session produced.
 *
 * The turn is part of the contract rather than a second scenario: ADR-0033 checks the real loadout
 * at session start AND on the first turn, because the MCP extension's own `session_start` may run
 * after ours. A test that stopped at `session_start` would pass while that second chance was
 * removed.
 */
async function startAndTurn(options: {
  active: readonly string[];
  mcpJson?: string;
  /** The `ptc.json` body; omitted means no file, so the surface is DETECTED rather than pinned. */
  ptc?: unknown;
  turns?: number;
  mode?: "tui" | "print";
}): Promise<{ notices: { message: string; type?: string }[]; tools: string[] }> {
  const { stub, dir } = await makeStubInAgentDir({
    // No ptc.json, so the surface is DETECTED; the probe is told pi ships codemode.
    codemode: { present: true, how: "found" },
    active: options.active,
    ...(options.mcpJson === undefined ? {} : { mcpJson: options.mcpJson }),
    ...(options.ptc === undefined ? {} : { ptc: options.ptc }),
  });
  try {
    const ctx = stubContext(stub, { mode: options.mode ?? "tui" });
    await stub.emit("session_start", ctx);
    for (let turn = 0; turn < (options.turns ?? 1); turn += 1) {
      await stub.emit("turn_start", ctx);
    }
    return { notices: [...stub.notifications], tools: [...stub.tools.keys()] };
  } finally {
    await removeTempDir(dir);
  }
}

test("an mcp.json the evidence reads resolves subagents, and registers no run-code orchestrator", async () => {
  // The session ADR-0029 could not resolve: the activation probe said `inactive`, the surface was
  // `full`, and pi's MCP extension activated codemode on top — both surfaces live. With the
  // evidence folded in, the prediction and pi agree, so the delegation happens and
  // `ptc_run_code` is not registered beside a live codemode.
  //
  // The assertion is on the registered tools rather than on `surface.codemodeActivation`: the
  // probe could report `mcp` while the factory quietly built `full` anyway, and only the tool set
  // says what the model is being offered.
  const { notices, tools } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    mcpJson: MCP_JSON,
  });
  expect(tools).toEqual(["ptc_subagent", ...TASK_TOOLS, "ptc_child_report"]);
  expect(
    notices.filter((n) => n.message.includes(DRIFT)),
    "a predicted session has no drift to report",
  ).toEqual([]);
});

test("a codemode the probe did not predict is reported once, as a warning naming the fix", async () => {
  // The backstop: nothing in `settings.json` or `mcp.json` names codemode, the surface defaults
  // to `full`, and pi's real loadout has codemode active anyway. The user is being offered two
  // orchestration tools, which ADR-0025 calls a measured defect, so this is a warning rather
  // than a note — the same level and the same one-line fix as the probe-missed notice.
  const { notices, tools } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    turns: 3,
  });
  const drift = notices.filter((n) => n.message.includes(DRIFT));
  expect(drift, "the drift is reported exactly once, however many turns run").toHaveLength(1);
  expect(drift[0]?.type).toBe("warning");
  expect(drift[0]?.message, "and it names the key that picks one").toContain('"surfaceMode"');
  expect(tools, "the surface it defaulted to is the full one").toContain("ptc_run_code");
  expect(tools).not.toContain("ptc_subagent");
});

test("a session with no codemode at all is not told about a drift it does not have", async () => {
  // The crying-wolf guard, and the direction that matters: `full` with codemode inactive is the
  // DEFAULT cell after ADR-0029, and a notice on every ordinary session would be noise. Without
  // the `getActiveTools()` check this would fire on the whole user base.
  const { notices, tools } = await startAndTurn({ active: ["read", "bash", "edit", "write"] });
  expect(notices.filter((n) => n.message.includes(DRIFT))).toEqual([]);
  expect(tools).toContain("ptc_run_code");
});

test("an mcp.json we could not read is reported once, and the drift notice still applies", async () => {
  // Both halves of the failure path on one session: the broken file means the evidence cannot
  // say `active` (so the surface is `full`), pi's loadout is then genuinely active, and the user
  // hears about the file AND the drift. A probe that swallowed the parse error would report the
  // drift alone and leave the broken file invisible.
  const { notices } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    mcpJson: "{ not json",
  });
  // Matched on the parse failure itself, not on the file name: the drift notice names `mcp.json`
  // too, so a name-based filter would count both lines and prove nothing about either.
  expect(notices.filter((n) => n.message.includes("not valid JSON"))).toHaveLength(1);
  expect(notices.filter((n) => n.message.includes(DRIFT))).toHaveLength(1);
});

test("an mcp.json that keeps codemode off resolves full, exactly as ADR-0029's default does", async () => {
  // The row of ADR-0033's table the pure-function cases alone could not carry: the user who read
  // pi's own docs and set `autoEnableCodemode: false` must get `full`, and the factory must
  // register the full surface for it. Asserted on the whole registered list, because a mirror
  // that answered `active` here would still pass every evidence case — this is the only place
  // the negative decision is taken through the real factory.
  const { notices, tools } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    mcpJson: JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { docs: { command: "npx" } },
    }),
  });
  expect(tools).toEqual(FULL_TOOLS);
  // And with the tool really active, the drift notice is exactly what this session should hear.
  expect(notices.filter((n) => n.message.includes(DRIFT))).toHaveLength(1);
});

test("a disabled server resolves full, and a session with no MCP at all resolves full", async () => {
  // The remaining two negative rows, on the same terms: the registered list, exactly. `full`
  // means `ptc_run_code` and NOT `ptc_subagent` — the second is the assertion that carries, since
  // `ptc_run_code` alone could be registered beside a `subagents` decision that never happened.
  const disabled = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    mcpJson: JSON.stringify({ mcpServers: { docs: { command: "npx", enabled: false } } }),
  });
  expect(disabled.tools).toEqual(FULL_TOOLS);
  expect(disabled.tools).not.toContain("ptc_subagent");
  const none = await startAndTurn({ active: ["read", "bash", "edit", "write", "codemode"] });
  expect(none.tools).toEqual(FULL_TOOLS);
});

test("a PINNED surfaceMode is not second-guessed, even when it is the double-surface one", async () => {
  // The guard review round 2 found undocumented and untested (Spec finding 3): a user who pinned
  // `surfaceMode: "full"` has a predicted `full` surface AND a live codemode — the double surface
  // the drift notice exists to report — and the code exempts them. That is the right call (they
  // asked for this surface; ADR-0027's pinned-conflict notice already covers the disagreement),
  // but it is a third guard on the AC "predicted full + active codemode → notice", so it is
  // pinned here rather than left implicit.
  //
  // This one is CHARACTERIZATION by construction: the guard already exists, so no mutation makes
  // it red except deleting the guard. Counterfactual: remove `surface.source === "file"` from
  // `notifyCodemodeDrift` and this turns red.
  const { notices, tools } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    ptc: { surfaceMode: "full" },
  });
  expect(notices.filter((n) => n.message.includes(DRIFT))).toEqual([]);
  expect(tools, "and the pinned surface is what registers").toEqual(FULL_TOOLS);
});

test("a --print session is told neither notice, because ctx.ui.notify is TUI-only", async () => {
  // The limitation ADR-0033 restates rather than solves. It is only checkable because
  // `stubContext`'s recorder honours the mode: a stub that recorded unconditionally would let a
  // test "assert" TUI-only silence by seeing the line and failing for the wrong reason, which is
  // how this acceptance criterion went untested in the first place.
  const { notices } = await startAndTurn({
    active: ["read", "bash", "edit", "write", "codemode"],
    mcpJson: "{ not json",
    mode: "print",
  });
  expect(notices, "the drift and the unreadable file are both silent under --print").toEqual([]);
});
