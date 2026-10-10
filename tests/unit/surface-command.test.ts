/**
 * What replaced ADR-0030's `surfaceMode` key and its `/ptc surface` command.
 *
 * Both are gone: the surface is now a pure function of what pi is (`detectSurfaceMode`), there is
 * no value a user can pin and no subcommand that could write one. What is left behind is a
 * MIGRATION problem, and it is the only thing worth pinning here — a developer's `ptc.json` still
 * carries a key that now does nothing, and the difference between "reported once, with the
 * replacement named" and "silently ignored" is the whole of what this file checks:
 *
 *   1. **The key changes nothing.** Every legacy value, compared DIFFERENTIALLY against the same
 *      pi with no key at all — not against a hand-written tool list, so the claim is "the key is
 *      inert" rather than "the tool list happens to look like this".
 *   2. **The user is told**, once, as a `warning`, with the path, the value, and `pi config` as
 *      the channel that actually works (pi does not LOAD an extension to honour it, which no value
 *      of a key this package reads could ever achieve — `src/mode/ptc-mode.ts:1171-1176`).
 *   3. **And only then.** A file with no key, no file, or a file too broken to parse raises no
 *      such notice: a notice on every ordinary session is a notice nobody reads.
 *
 * ADR-0030's reload discipline survives in its one remaining form — the notice is raised at
 * `session_start`, and nothing on this path reloads, so `stub.reloads` stays empty.
 *
 * NOTE: the filename is now a misnomer — there is no surface command. A rename to something like
 * `legacy-surface-key.test.ts` is the honest follow-up, but renaming was outside the assigned
 * scope, so the history stays visible here rather than being quietly dropped.
 */
import { describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PTC_MODE_CONFIG_FILE,
  PTC_MODE_ENTRY_TYPE,
  PTC_MODE_STATUS_KEY,
} from "../../src/mode/ptc-mode.ts";
import { makeExtensionStub, makeTempDir, removeTempDir, stubContext } from "../helpers/ptc.ts";

const FILE = PTC_MODE_CONFIG_FILE;

/**
 * The three probes that resolve `full` (`detectedSurfaceMode`'s table, `src/mode/ptc-mode.ts:1046`).
 *
 * Pinned because nothing short-circuits the detection any more: with the key gone, an unpinned
 * switch or activation axis runs the real probe over the developer's own
 * `~/.pi/agent/settings.json` and this file's surface would depend on the machine running it.
 */
const FULL_SURFACE_AXES = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "inactive", source: "default" },
} as const;

/**
 * The exact substring that identifies the stale-key notice, used to filter session_start's output.
 * A filter and not a "no notices at all" assertion, because `session_start` raises several
 * unrelated lines and pinning their absence would make this file a hostage to the others.
 */
const STALE_KEY = 'still has a "surfaceMode" key';

async function withAgentDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir("pi-ptc-surface-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
}

/** Write `body` as the agent dir's `ptc.json`, verbatim. */
const writeConfig = (dir: string, body: string) => writeFile(join(dir, FILE), body, "utf8");

/**
 * The stale-key notices `session_start` raised, and nothing else.
 *
 * Takes no agent dir: `withAgentDir` has already pointed `PI_CODING_AGENT_DIR` at it, which is
 * what `readLegacySurfaceKey` resolves against, and the three pinned axes make the surface itself
 * independent of it.
 */
async function staleKeyNotices(): Promise<{ message: string; type?: string }[]> {
  const stub = makeExtensionStub(FULL_SURFACE_AXES);
  await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
  return stub.notifications.filter((notice) => notice.message.includes(STALE_KEY));
}

describe("the legacy surfaceMode key is inert", () => {
  test("every value it ever took registers exactly what no key at all registers", async () => {
    // The differential IS the claim. An implementation that read the key back -- returning early
    // for `"off"`, or registering the `subagents` line for `"subagents"` -- makes one of these
    // three disagree with the baseline, and the assertion is on the tool NAMES rather than on a
    // hand-written list, so it cannot be satisfied by a list that happens to still match.
    await withAgentDir(async (dir) => {
      const baseline = [...makeExtensionStub(FULL_SURFACE_AXES).tools.keys()];
      expect(baseline.length, "the baseline is a real surface, not an empty one").toBeGreaterThan(
        0,
      );

      // The literal set, not a constant: a value this loop stops naming is a value whose
      // behaviour stopped being checked, so it would go unnoticed rather than turn red.
      for (const value of ["off", "subagents", "full"] as const) {
        await writeConfig(dir, JSON.stringify({ surfaceMode: value }));
        const names = [...makeExtensionStub(FULL_SURFACE_AXES).tools.keys()];
        expect(names, `surfaceMode: ${JSON.stringify(value)}`).toEqual(baseline);
      }
    });
  });

  test("and it does not turn the PTC MODE off either -- the two were never the same switch", async () => {
    // `defaultMode` is the key that governs PTC mode and it still lives in this file. A reader
    // that reached for `surfaceMode: "off"` and acted on it would be acting on the wrong key, and
    // the failure would be a session silently not entering the mode rather than a visible one.
    await withAgentDir(async (dir) => {
      await writeConfig(dir, JSON.stringify({ surfaceMode: "off", defaultMode: true }));
      const stub = makeExtensionStub(FULL_SURFACE_AXES);
      await stub.emit("session_start", stubContext(stub, { mode: "tui" }));

      const status = stub.statuses.at(-1);
      expect(
        stub.entries.filter((entry) => entry.customType === PTC_MODE_ENTRY_TYPE),
        "the session still enters PTC mode",
      ).toMatchObject([{ data: { enabled: true } }]);
      expect(status?.key, "so it also publishes the mode status").toBe(PTC_MODE_STATUS_KEY);
    });
  });
});

describe("the legacy surfaceMode key is reported", () => {
  test("once, as a warning, naming the path, the value and the replacement", async () => {
    await withAgentDir(async (dir) => {
      await writeConfig(dir, JSON.stringify({ surfaceMode: "off" }));

      const notices = await staleKeyNotices();

      expect(notices, "exactly once -- a repeated warning is one nobody reads").toHaveLength(1);
      expect(notices[0]?.type, "a warning, not a note: the key is being IGNORED").toBe("warning");
      // The three facts a user needs to act: which file, what it says, and what to do instead.
      expect(notices[0]?.message, "which file").toContain(join(dir, FILE));
      expect(notices[0]?.message, "what it says").toContain('("off")');
      expect(notices[0]?.message, "and that it no longer does anything").toContain(
        "no longer read",
      );
      expect(
        notices[0]?.message,
        "and the channel that does work -- pi, without loading this package",
      ).toContain("pi config");
    });
  });

  test("a value that was never legal is echoed as JSON, so the user can see which key is stale", async () => {
    // `JSON.stringify` of a non-string, not an interpolation: a notice that printed `[object
    // Object]` for `{"a":1}` would tell the user nothing about what to delete. `7` is the case
    // that separates the two, because stringifying it drops the quotes a template literal adds.
    await withAgentDir(async (dir) => {
      await writeConfig(dir, JSON.stringify({ surfaceMode: 7 }));

      const notices = await staleKeyNotices();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.message).toContain("(7)");
    });
  });

  test("a file with no such key, and no file at all, raise nothing", async () => {
    // The guard that keeps this from being crying wolf: a session with a clean config is the
    // overwhelming majority, and a warning there is a warning that trains the reader to skip it.
    await withAgentDir(async (dir) => {
      expect(await staleKeyNotices(), "no ptc.json at all").toEqual([]);
      await writeConfig(dir, JSON.stringify({ defaultMode: false }));
      expect(
        await staleKeyNotices(),
        "a ptc.json whose only key is defaultMode, which is still honoured",
      ).toEqual([]);
    });
  });

  test("a file too broken to parse raises no stale-key notice -- that file belongs to defaultMode", async () => {
    // `readLegacySurfaceKey` documents the omission: a file it cannot parse has no `surfaceMode`
    // to be stale about, and the parse failure is reported by whoever OWNS the file. Asserting
    // the owner's notice as well is what makes this a filter rather than a way of asserting
    // "session_start is silent".
    for (const body of ["{ not json", "[]", "null", '"subagents"'] as const) {
      await withAgentDir(async (dir) => {
        await writeConfig(dir, body);
        const stub = makeExtensionStub(FULL_SURFACE_AXES);
        await stub.emit("session_start", stubContext(stub, { mode: "tui" }));

        expect(
          stub.notifications.filter((n) => n.message.includes(STALE_KEY)),
          "no stale-key notice for " + body,
        ).toEqual([]);
        expect(
          stub.notifications.some((n) => n.message.includes(PTC_MODE_CONFIG_FILE)),
          "but the owner of the file still reports it: " + body,
        ).toBe(true);
      });
    }
  });

  test("raising it does not reload -- a notice has nothing to apply to", async () => {
    // ADR-0030's half that outlives the command. `ctx.reload()` tears down the context that
    // raised it (`runner.js:482`), so a session_start that reloaded to deliver a message about
    // itself would drop every extension instance in the session to say one line.
    await withAgentDir(async (dir) => {
      await writeConfig(dir, JSON.stringify({ surfaceMode: "off" }));

      const stub = makeExtensionStub(FULL_SURFACE_AXES);
      await stub.emit("session_start", stubContext(stub, { mode: "tui" }));

      expect(stub.notifications.filter((n) => n.message.includes(STALE_KEY))).toHaveLength(1);
      expect(stub.reloads, "and the session is left standing").toEqual([]);
    });
  });
});

describe("the /ptc surface subcommand is gone", () => {
  async function run(dir: string, args: string): Promise<ReturnType<typeof makeExtensionStub>> {
    const stub = makeExtensionStub(FULL_SURFACE_AXES);
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    const command = stub.commands.get("ptc");
    expect(command, "the /ptc command is registered").toBeDefined();
    if (command === undefined) throw new Error("unreachable");
    await command.handler(args, stubContext(stub, { mode: "tui" }));
    return stub;
  }

  test("the argument changes nothing and writes nothing", async () => {
    // The old handler read this argument and wrote `ptc.json`. An argument that now falls
    // through to the mode report is the proof it is gone: the file is compared BYTE FOR BYTE,
    // so a writer that reformatted an unrelated file would still be caught.
    await withAgentDir(async (dir) => {
      const original = JSON.stringify({ defaultMode: true }, null, 2) + "\n";
      await writeConfig(dir, original);

      const stub = await run(dir, "surface full");
      const said = stub.notifications.at(-1)?.message ?? "";

      expect(await readFile(join(dir, FILE), "utf8"), "no write").toBe(original);
      expect(said, "no surface is mentioned").not.toContain("surface");
      expect(said, "it is the mode report").toContain("PTC mode is");
    });
  });

  test("/ptc off is still the MODE switch, which is a different switch", async () => {
    // The asymmetry worth guarding: `surface` went, `off` stayed, and the two are unrelated.
    // Deleting the wrong branch of that handler would take PTC mode's own off-switch with it and
    // every test above would still be green.
    //
    // The session ENTERED the mode at `session_start` (no `ptc.json`, so `defaultMode` is true),
    // which is what makes this a behavioural assertion: the persisted record has to flip, rather
    // than the handler merely reaching a branch that prints something.
    await withAgentDir(async (dir) => {
      const stub = await run(dir, "off");

      expect(
        stub.entries.filter((entry) => entry.customType === PTC_MODE_ENTRY_TYPE).at(-1),
        "the mode record flipped to off",
      ).toMatchObject({ data: { enabled: false } });
      expect(stub.notifications.at(-1)?.message, "and the user is told").toContain("PTC mode off");
    });
  });
});
