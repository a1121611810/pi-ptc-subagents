/**
 * ADR-0033 — the activation drift no config probe can see, reported rather than prevented.
 *
 * pi's MCP extension activates `codemode` by calling `pi.setActiveTools` at runtime, and it does it
 * from inside **its own** `session_start` handler. Extension order is not ours to choose, and ours
 * loses that race: measured on pi 1.1.0, a read from our handler saw the tool inactive
 * synchronously, one microtask later, and on a zero-delay timer, and it appeared roughly 250 ms
 * afterwards.
 *
 * So this file is about the window BETWEEN our `session_start` and the next turn. The activation
 * probe snapshots at session start; `getActiveTools()` is live. Anything that activates `codemode`
 * after the snapshot lands in that gap, and the drift notice is what names it.
 *
 * **The shape of every case below changed, and the change is the point.** When activation was
 * reconstructed from the settings, the probe and pi's real loadout could disagree the moment the
 * session started — that was the ordinary case, and this file existed to catch it. Activation is
 * now READ from the loadout, so on that axis they agree by construction and the disagreement has
 * moved: the only reachable drift is a loadout that gains `codemode` after the snapshot, which is
 * the MCP ordering above and an extension calling `setActiveTools` for its own reasons.
 */
import { expect, test } from "vitest";
import { makeStubInAgentDir, stubContext } from "../helpers/ptc.ts";

/** BG-14: the three always-on background-task tools, in registration order. */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;

/** `full`: the pair declared to the model, the lifecycle face, and the report tool. No subagent. */
const FULL_TOOLS = ["ptc_run_code", "ptc_workflow", ...TASK_TOOLS, "ptc_child_report"] as const;

/** `subagents`: the pair at codemode reach plus the top-level subagent face. */
const SUBAGENTS_TOOLS = ["ptc_run_code", "ptc_workflow", "ptc_subagent", ...TASK_TOOLS] as const;

/** The message of the ADR-0033 drift notice. */
const DRIFT = "codemode is active in this session";

/** pi's default session loadout. `codemode` is NOT one of them — pi registers it inactive. */
const DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

/**
 * Start a session, optionally let pi activate `codemode` LATER, then run a turn.
 *
 * `activateAfterStart` is the whole subject of this file: it pushes `codemode` into the stub's loadout
 * AFTER `session_start` has snapshotted it, which is what pi's MCP extension does to a real session.
 * The turn is then the second chance ADR-0033 takes — a check that stopped at `session_start` would
 * pass while that second chance was deleted.
 */
async function startAndTurn(options: {
  active: readonly string[];
  /** Add `codemode` to the loadout after `session_start` has snapshotted it. */
  activateAfterStart?: boolean;
  mcpJson?: string;
  /** The `ptc.json` body; omitted means no file, so the surface is DETECTED rather than pinned. */
  ptc?: unknown;
  turns?: number;
  mode?: "tui" | "print";
}): Promise<{ notices: { message: string; type?: string }[]; tools: string[] }> {
  const { stub, dir } = await makeStubInAgentDir({
    // No ptc.json, so the surface is DETECTED; the probe is told pi ships codemode.
    codemode: { present: true, how: "found" },
    // `null` = let the REAL activation probe run. This file's entire subject is that probe, so
    // pinning it would make every case below pass for the wrong reason.
    codemodeActivation: null,
    active: options.active,
    mode: options.mode ?? "tui",
    ...(options.mcpJson === undefined ? {} : { mcpJson: options.mcpJson }),
    ...(options.ptc === undefined ? {} : { ptc: options.ptc }),
  });
  // `makeStubInAgentDir` restores `PI_CODING_AGENT_DIR` when it returns, and the probes now run in
  // `session_start`, which the helper has already driven. The legacy-key notice reads the agent dir
  // from that handler too, so holding the variable across the turns is what makes the test exercise
  // the real path rather than the developer's own agent dir.
  //
  // The stub's own `session_start` is NOT emitted again here: it is the event that registers, so a
  // second emit would register twice and raise every notice twice.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const ctx = stubContext(stub, { mode: options.mode ?? "tui" });
    if (options.activateAfterStart === true) stub.active.push("codemode");
    for (let turn = 0; turn < (options.turns ?? 1); turn += 1) {
      await stub.emit("turn_start", ctx);
    }
    return { notices: [...stub.notifications], tools: [...stub.tools.keys()] };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("a session whose loadout already had codemode at startup reports no drift", async () => {
  // The healthy case, and the one that got quieter rather than different: activation is read from
  // the loadout, so a session that arrived with `codemode` active is predicted correctly and there
  // is nothing to reconcile. Asserted on the tool set too, because a probe that answered `inactive`
  // here would still produce this notice-free surface — the pair would just be the wrong one.
  const { notices, tools } = await startAndTurn({ active: [...DEFAULT_TOOLS, "codemode"] });
  expect(tools).toEqual([...SUBAGENTS_TOOLS, "ptc_child_report"]);
  expect(notices.filter((n) => n.message.includes(DRIFT))).toEqual([]);
});

test("a codemode that appears AFTER startup is reported once, as a warning naming the fix", async () => {
  // The backstop, and now the only reachable drift: nothing named `codemode` when the session
  // started, the surface was built as `full`, and pi activated the tool anyway. The user is being
  // offered two orchestration tools, which ADR-0025 calls a measured defect, so this is a warning
  // rather than a note — the same level and the same one-line fix as the probe-missed notice.
  const { notices, tools } = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    turns: 3,
  });
  const drift = notices.filter((n) => n.message.includes(DRIFT));
  expect(drift, "the drift is reported exactly once, however many turns run").toHaveLength(1);
  expect(drift[0]?.type).toBe("warning");
  expect(drift[0]?.message, "and it names the two things that still move the surface").toContain(
    "-t codemode",
  );
  // The reverse assertion is the load-bearing half: the fix removed the setting this notice used
  // to send the user to, and a message that still named it would send them to write a key nothing
  // reads. Asserting only the new advice would pass on a message carrying both.
  expect(drift[0]?.message, "and it names no setting this package no longer reads").not.toContain(
    "surfaceMode",
  );
  // The surface was decided before the tool appeared, and pi cannot unregister: this is the
  // registered set the user is stuck with until the session restarts.
  expect(tools, "the surface it decided is the full one").toEqual(FULL_TOOLS);
});

test("a session with no codemode at all is not told about a drift it does not have", async () => {
  // The crying-wolf guard, and the direction that matters: `full` with codemode inactive is the
  // DEFAULT cell after ADR-0029, and a notice on every ordinary session would be noise. Without
  // the `getActiveTools()` check this would fire on the whole user base.
  const { notices, tools } = await startAndTurn({ active: DEFAULT_TOOLS });
  expect(notices.filter((n) => n.message.includes(DRIFT))).toEqual([]);
  expect(tools).toContain("ptc_run_code");
});

test("an mcp.json we could not read is reported once, and the drift notice still applies", async () => {
  // Both halves of the failure path on one session: the broken file means the evidence cannot say
  // `active`, pi activates `codemode` after the snapshot anyway, and the user hears about the file
  // AND the drift. A probe that swallowed the parse error would report the drift alone and leave
  // the broken file invisible.
  const { notices } = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    mcpJson: "{ not json",
  });
  // Matched on the parse failure itself, not on the file name: the drift notice names `mcp.json`
  // too, so a name-based filter would count both lines and prove nothing about either.
  expect(notices.filter((n) => n.message.includes("not valid JSON"))).toHaveLength(1);
  expect(notices.filter((n) => n.message.includes(DRIFT))).toHaveLength(1);
});

test("an mcp.json that keeps codemode off resolves full, exactly as ADR-0029's default does", async () => {
  // The row of ADR-0033's table the pure-function cases alone could not carry: the user who read
  // pi's own docs and set `autoEnableCodemode: false` must get `full`. Asserted on the whole
  // registered list, because a probe that answered `active` here would still pass every evidence
  // case — this is the only place the negative decision is taken through the real factory.
  const { notices, tools } = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    mcpJson: JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { docs: { command: "npx" } },
    }),
  });
  expect(tools).toEqual(FULL_TOOLS);
  // And with the tool really active afterwards, the drift notice is exactly what this session
  // should hear — a setting that silenced the evidence does not silence the measurement.
  expect(notices.filter((n) => n.message.includes(DRIFT))).toHaveLength(1);
});

test("a disabled server resolves full, and a session with no MCP at all resolves full", async () => {
  // The remaining two negative rows, on the same terms: the registered list, exactly. `full`
  // means `ptc_run_code` and NOT `ptc_subagent` — the second is the assertion that carries, since
  // `ptc_run_code` alone could be registered beside a `subagents` decision that never happened.
  const disabled = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    mcpJson: JSON.stringify({ mcpServers: { docs: { command: "npx", enabled: false } } }),
  });
  expect(disabled.tools).toEqual(FULL_TOOLS);
  expect(disabled.tools).not.toContain("ptc_subagent");
  const none = await startAndTurn({ active: DEFAULT_TOOLS, activateAfterStart: true });
  expect(none.tools).toEqual(FULL_TOOLS);
});

test("a leftover surfaceMode key is inert: it neither pins the surface nor buys silence", async () => {
  // ADR-0034 removed the key, so the guard this file used to pin — "a pinned surface is not
  // second-guessed" — has no subject left. What replaced it is the opposite claim, and it is worth
  // an assertion rather than an absence: a `surfaceMode` left behind by an older release must not
  // buy the user the exemption, or the package would be deciding the surface twice, once from a
  // key it ignores and once from the probes.
  //
  // The scenario is deliberately the worst one for that: `full` was decided while no codemode was
  // live, and one appears afterwards — which is exactly the double surface the drift notice exists
  // to report. If the key were still honoured the notice would stay silent AND the pair would
  // register.
  const { notices, tools } = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    ptc: { surfaceMode: "full" },
  });
  expect(
    notices.filter((n) => n.message.includes(DRIFT)),
    "an ignored key must not suppress the drift report",
  ).toHaveLength(1);
  expect(
    notices.filter((n) => n.message.includes("no longer read")),
    "and the user is told the key is being ignored, with the replacement",
  ).toHaveLength(1);
  // The surface came from the probes, not the key: no codemode was live at startup, so `full`.
  expect(tools).toEqual(FULL_TOOLS);
});

test("a --print session is told neither notice, because ctx.ui.notify is TUI-only", async () => {
  // The limitation ADR-0033 restates rather than solves. It is only checkable because
  // `stubContext`'s recorder honours the mode: a stub that recorded unconditionally would let a
  // test "assert" TUI-only silence by seeing the line and failing for the wrong reason, which is
  // how this acceptance criterion went untested in the first place.
  const { notices } = await startAndTurn({
    active: DEFAULT_TOOLS,
    activateAfterStart: true,
    mcpJson: "{ not json",
    mode: "print",
  });
  expect(notices, "the drift and the unreadable file are both silent under --print").toEqual([]);
});
