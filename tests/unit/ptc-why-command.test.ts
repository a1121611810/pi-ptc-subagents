/**
 * `/ptc why [on|off]` — ADR-0043's session switch for the dispatch caller's reason.
 *
 * The switch itself (the `whyEnabled` key) is owned by `tests/unit/why-enabled-config.test.ts`;
 * this file owns the half that is a COMMAND, and the property that makes it a command rather than
 * another key is that it writes a SESSION record instead of a file. So most of what is pinned here
 * is about scope and separation:
 *
 *   1. **Session scope, in both directions.** `/ptc why off` survives a resume
 *      ({@link SessionOptions.resumeFrom} carries one session's records into the next) and does NOT
 *      survive anything else — a fresh session over the same `ptc.json` starts from the file again,
 *      which is the only thing that distinguishes this from a second spelling of the config key.
 *   2. **PTC mode is a different switch.** `/ptc why off` must not narrow the loadout and `/ptc off`
 *      must not silence the block. Two subcommands of one command that each look like they could be
 *      the other's off-switch is the exact confusion that costs a user a session of debugging.
 *   3. **Nothing reaches the disk.** Compared byte for byte, because the file this package must not
 *      write is the one whose sibling keys it does read.
 *
 * The bare query is asserted for its SOURCE as well as its value. After `/ptc why off` the file
 * still says what it always said, so a report that named only the value would send the user to
 * open a file that does not explain the session they are in.
 *
 * Every case below drives the real registered command with the argument a user actually types,
 * `why off` rather than `off` — the two spellings reach different branches, and a helper that
 * prepended the subcommand would have made the `/ptc off` case inexpressible.
 *
 * ## What is NOT asserted here, and why
 *
 * No test drives a real dispatch. `background.dispatchDeps.lifecycle` is the real
 * `RealChildProcessLifecycle` unless a test injects its own runtime, so reaching `dispatch()`
 * through the extension stub spawns an actual `pi` child — one process per assertion, for a
 * property that is already observable one layer down: `dispatch()` reads
 * `deps.whyEnabled !== false` off the object `getDispatchDeps` hands all three fronts, and the
 * tests below assert that object's value directly, through the documented `backgroundRuntime`
 * injection seam. The argv a suppressed block does or does not produce is
 * `dispatch-wiring.test.ts`'s subject, not this command's.
 */
import { describe, expect, test } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionStub } from "../helpers/ptc.ts";
import { makeExtensionStub, makeTempDir, removeTempDir, stubContext } from "../helpers/ptc.ts";
import { createBackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import type { BackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";
import { PTC_MODE_CONFIG_FILE, PTC_MODE_ENTRY_TYPE } from "../../src/mode/ptc-mode.ts";
import { PTC_WHY_ENTRY_TYPE } from "../../src/index.ts";

/**
 * The three probes that resolve `full`, pinned so this file's session does not depend on whatever
 * pi happens to be installed on the machine running it (`detectedSurfaceMode`'s four-case table).
 * Copied from `surface-command.test.ts`, which needed the same thing for the same reason.
 */
const FULL_SURFACE_AXES = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "inactive", source: "loadout" },
} as const;

const CONFIG_FILE = PTC_MODE_CONFIG_FILE;

/** The records this command appends, in order. */
const whyEntries = (stub: ExtensionStub) =>
  stub.entries.filter((entry) => entry.customType === PTC_WHY_ENTRY_TYPE);

/** The mode's records, in order — the OTHER switch, kept separable at every assertion below. */
const modeEntries = (stub: ExtensionStub) =>
  stub.entries.filter((entry) => entry.customType === PTC_MODE_ENTRY_TYPE);

/**
 * One session's records in the shape `ctx.sessionManager.getEntries()` returns them, so a test can
 * hand a second session the transcript a first one produced.
 *
 * Derived from a real run rather than written by hand: these entries are what
 * `pi.appendEntry(PTC_WHY_ENTRY_TYPE, ...)` actually recorded, so a change to the record's shape
 * makes the resume tests fail loudly instead of quietly testing a fixture the writer never emits.
 */
const carriedEntries = (stub: ExtensionStub) =>
  stub.entries.map((entry) => ({
    type: "custom",
    customType: entry.customType,
    ...(entry.data === undefined ? {} : { data: entry.data }),
  }));

/** Invoke `/ptc` the way a user types it — the whole argument string, subcommand included. */
async function runPtc(stub: ExtensionStub, args: string): Promise<void> {
  const command = stub.commands.get("ptc");
  expect(command, "the /ptc command is registered").toBeDefined();
  if (command === undefined) throw new Error("unreachable");
  await command.handler(args, stubContext(stub, { mode: "tui" }));
}

interface SessionOptions {
  /** `ptc.json` body; omitted for no file at all, which is the ordinary case. */
  ptc?: unknown;
  /** BG-14 seam: a pre-built runtime, so a test can read `dispatchDeps` back. */
  backgroundRuntime?: BackgroundTaskRuntime;
  /**
   * Run against an EXISTING agent dir instead of a fresh one — a second session over the SAME
   * config file, which is what "a new session starts from `ptc.json` again" actually means.
   *
   * Without it the second session gets a freshly WRITTEN file, which masks the exact defect this
   * case exists to catch: an implementation that persists the decision by editing `ptc.json` is
   * undone by the test's own setup before it can be observed. With it, the file the first session
   * left behind is the file the second one reads.
   */
  reuseDir?: string;
  /**
   * Records this session already carries — a RESUME. `makeExtensionStub` fires `session_start`
   * itself with an empty transcript, so the second firing below is what actually models pi handing
   * a continued session to a fresh extension load. Two firings is also what a real `/reload` looks
   * like, so nothing here depends on an arrangement pi cannot produce.
   */
  resumeFrom?: readonly { type: string; customType: string; data?: unknown }[];
}

/** A real factory over a real agent dir, so `ptc.json` is read off disk rather than injected. */
async function withSession(
  options: SessionOptions,
  fn: (stub: ExtensionStub, dir: string) => Promise<void>,
): Promise<void> {
  const dir = options.reuseDir ?? (await makeTempDir("pi-ptc-why-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (options.ptc !== undefined) {
      // Formatted with a trailing newline, so the byte-for-byte comparison below is against a file
      // a human would have written rather than one `JSON.stringify` produced compactly.
      await writeFile(join(dir, CONFIG_FILE), JSON.stringify(options.ptc, null, 2) + "\n", "utf8");
    }
    const stub = await makeExtensionStub({
      ...FULL_SURFACE_AXES,
      ...(options.backgroundRuntime === undefined
        ? {}
        : { backgroundRuntime: options.backgroundRuntime }),
    });
    if (options.resumeFrom !== undefined) {
      await stub.emit(
        "session_start",
        stubContext(stub, { mode: "tui", entries: [...options.resumeFrom] }),
      );
    }
    await fn(stub, dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (options.reuseDir === undefined) await removeTempDir(dir);
  }
}

describe("/ptc why off and on move the dispatch `why` switch", () => {
  test("off is effective for the NEXT dispatch and durable for the session", async () => {
    /*
     * COUNTERFACTUAL: drop `background.dispatchDeps.whyEnabled = enabled` from `applyWhy` and the
     * second assertion goes red — the record would still be written and the notice would still be
     * printed, which is the shape of "says it worked" with nothing behind it.
     */
    const runtime = createBackgroundTaskRuntime({ concurrency: 1, whyEnabled: true });
    await withSession({ ptc: { whyEnabled: true }, backgroundRuntime: runtime }, async (stub) => {
      expect(runtime.dispatchDeps.whyEnabled, "the session starts from the file's value").toBe(
        true,
      );

      await runPtc(stub, "why off");

      expect(
        runtime.dispatchDeps.whyEnabled,
        "the object every dispatch front reads has moved, without an extension reload",
      ).toBe(false);
      expect(whyEntries(stub), "and the decision is on the record for the session").toMatchObject([
        { data: { enabled: false } },
      ]);
      expect(stub.notifications.at(-1)?.message, "the user is told which way it went").toContain(
        "OFF",
      );
    });
  });

  test("on puts it back, so the switch is not one-way", async () => {
    /*
     * COUNTERFACTUAL: implement `on` as a no-op (or report ON without touching anything) and the
     * first assertion goes red against a runtime left at `false` by the `/ptc why off` before it.
     */
    const runtime = createBackgroundTaskRuntime({ concurrency: 1, whyEnabled: true });
    await withSession({ ptc: { whyEnabled: true }, backgroundRuntime: runtime }, async (stub) => {
      await runPtc(stub, "why off");
      await runPtc(stub, "why on");

      expect(runtime.dispatchDeps.whyEnabled).toBe(true);
      expect(
        whyEntries(stub),
        "both decisions are on the record, in the order they were made",
      ).toEqual([
        { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: false } },
        { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: true } },
      ]);
      expect(stub.notifications.at(-1)?.message).toContain("ON");
    });
  });
});

describe("/ptc why with no argument reports the value AND where it came from", () => {
  test("every file value is reported, and each is named as coming from ptc.json", async () => {
    /*
     * COUNTERFACTUAL: report the value without the source (or hard-code the source to "this
     * session") and every case below still prints the right ON/OFF — so the assertions on
     * `ptc.json` are the only thing holding the provenance half.
     */
    // The literal pairs, not a generated one: a value this loop stops naming is a value whose
    // reporting stopped being checked.
    for (const [ptc, expected] of [
      [{ whyEnabled: true }, "ON"],
      [{ whyEnabled: false }, "OFF"],
      // No `whyEnabled` key at all is the shape almost every user has, and it must read as "the
      // file decided" rather than as "nothing has decided" — there is no third source to name.
      [{ defaultMode: true }, "ON"],
    ] as const) {
      await withSession({ ptc }, async (stub) => {
        await runPtc(stub, "why");

        const said = stub.notifications.at(-1);
        expect(said?.type, "a query is a note, not a warning").toBe("info");
        expect(said?.message, `for ${JSON.stringify(ptc)}`).toContain(expected);
        expect(said?.message, "and the file is named as the source").toContain("ptc.json");
        expect(said?.message, "not the session, which has not spoken").not.toContain(
          "this session",
        );
        expect(whyEntries(stub), "asking is not deciding").toEqual([]);
      });
    }
  });

  test("after `/ptc why off` the source is this session, even though the file still says true", async () => {
    /*
     * COUNTERFACTUAL: report `whyConfig.whyEnabled` instead of the session's override — the
     * correct value would still come from the file in the obvious reading, and the two assertions
     * below are what fail. A query that ignored the session override would also make the switch
     * unobservable after the fact.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      await runPtc(stub, "why off");
      await runPtc(stub, "why");

      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said, "the effective value followed the session").toContain("OFF");
      expect(said, "and the user is told which file does NOT explain this").toContain(
        "this session",
      );
      expect(said, "so they stop looking in the wrong place").not.toContain("ptc.json");
    });
  });
});

describe("repeating a value changes nothing and says nothing alarming", () => {
  test("`/ptc why off` twice writes ONE record and never warns", async () => {
    /*
     * COUNTERFACTUAL: append unconditionally (the obvious implementation) and the entry-count
     * assertion goes red with two records; raise the second call as a `warning` and the type
     * assertion goes red. Idempotence is the user's evidence that this is a state, not an action.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      // `session_start` raises notices of its own (including one `warning`), so "did this command
      // warn" has to be asked of the commands' notices alone.
      const before = stub.notifications.length;

      await runPtc(stub, "why off");
      await runPtc(stub, "why off");

      expect(
        whyEntries(stub),
        "a second record would say what the first already said",
      ).toHaveLength(1);
      expect(
        stub.notifications.slice(before).map((notice) => notice.type),
        "repeating a decision is not a problem",
      ).not.toContain("warning");
      expect(stub.notifications.at(-1)?.message, "but it still answers the question").toContain(
        "OFF",
      );
    });
  });

  test("`/ptc why on` twice likewise, and the provenance does not drift under it", async () => {
    /*
     * COUNTERFACTUAL: make the no-op branch write a record anyway — entry count goes red — or make
     * it report "this session" while the value is still the file's, which is the subtler half: the
     * provenance line would then name a session that never decided anything.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      await runPtc(stub, "why on");
      await runPtc(stub, "why on");

      expect(whyEntries(stub), "the file already said ON; a record would only add a claim").toEqual(
        [],
      );
      await runPtc(stub, "why");
      expect(
        stub.notifications.at(-1)?.message,
        "so the source is still the file, not a session that changed nothing",
      ).toContain("ptc.json");
    });
  });
});

describe("an argument that is not a value changes nothing at all", () => {
  test("`/ptc why maybe` warns, names the accepted values, and writes no record", async () => {
    /*
     * COUNTERFACTUAL: fall through to the bare query instead of rejecting — the user gets a
     * plausible report and no error, which is the failure this test exists to make loud. The
     * "still ptc.json" assertion below catches the worse version, where the bad argument is treated
     * as `off` and a record appears.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      await runPtc(stub, "why maybe");

      const said = stub.notifications.at(-1);
      expect(said?.type, "a rejected argument is a warning, not a note").toBe("warning");
      expect(said?.message, "the accepted values are named").toContain('"on"');
      expect(said?.message, "both of them").toContain('"off"');
      expect(said?.message, "and the argument is echoed so the typo is visible").toContain("maybe");
      expect(whyEntries(stub), "a rejected argument writes nothing").toEqual([]);

      await runPtc(stub, "why");
      expect(
        stub.notifications.at(-1)?.message,
        "and the switch is exactly where the file left it",
      ).toContain("ptc.json");
    });
  });

  test("a rejected argument cannot undo a real decision either", async () => {
    /*
     * COUNTERFACTUAL: parse the argument before validating it (`enabled = value !== "off"`, say)
     * and the record list goes red with a `true` — a typo silently re-enabling a block the user
     * had just turned off is the worst version of this defect.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      await runPtc(stub, "why off");
      await runPtc(stub, "why of");

      expect(whyEntries(stub), "only the one real decision is on the record").toEqual([
        { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: false } },
      ]);
      await runPtc(stub, "why");
      expect(stub.notifications.at(-1)?.message).toContain("OFF");
      expect(stub.notifications.at(-1)?.message).toContain("this session");
    });
  });
});

describe("PTC mode and the `why` switch are different switches", () => {
  test("`/ptc why off` leaves PTC mode ON, its record alone, and its loadout alone", async () => {
    /*
     * COUNTERFACTUAL: have `applyWhy` reuse `exitMode` (the tempting reuse — it already notifies,
     * writes a record and restores the loadout) and all four assertions go red. This is the test
     * that keeps `/ptc off` meaning one thing.
     */
    await withSession({}, async (stub) => {
      const modeBefore = modeEntries(stub);
      const activeBefore = [...stub.active];
      const statusesBefore = [...stub.statuses];
      // The session really did enter the mode: no `ptc.json` means `defaultMode` is true. Without
      // that, "the mode was untouched" would also be true of a session that never entered it.
      expect(modeBefore, "the session entered PTC mode at session_start").toMatchObject([
        { data: { enabled: true } },
      ]);

      await runPtc(stub, "why off");

      expect(modeEntries(stub), "no mode record was written").toEqual(modeBefore);
      expect(stub.active, "and the loadout the mode narrowed is untouched").toEqual(activeBefore);
      expect(stub.statuses, "so the footer still shows the mode").toEqual(statusesBefore);
      expect(stub.statuses.at(-1)?.text, "with the mode's own text in it").toContain("PTC");
    });
  });

  test("`/ptc off` does not silence the block — it only narrows the loadout", async () => {
    /*
     * COUNTERFACTUAL: treat `/ptc off` as a session-wide "off" — clear `whySession` from inside
     * `exitMode` — and both report assertions go red. The asymmetry is the point: one command, two
     * off-switches, and neither knows about the other. (Clearing `dispatchDeps.whyEnabled` there
     * instead would NOT be caught, because the report reads the session record rather than that
     * object; naming the record is what makes this test bite.)
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub) => {
      await runPtc(stub, "why off"); // establish that the session override is in play
      await runPtc(stub, "off"); // `/ptc off` -- the MODE switch.

      expect(modeEntries(stub).at(-1)?.data, "the mode really did go off").toMatchObject({
        enabled: false,
      });

      await runPtc(stub, "why"); // bare query again.
      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said, "the block is still off, and still the session's doing").toContain("OFF");
      expect(said, "which `/ptc off` did not touch").toContain("this session");
      expect(whyEntries(stub), "and the mode switch wrote no second `why` record").toEqual([
        { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: false } },
      ]);
    });
  });
});

describe("a malformed session record falls back to the shipped default, not to off", () => {
  test('"whyEnabled": "false" as a string leaves the block ON', async () => {
    /*
     * The string-typed boolean is the classic way a hand-written or forward-written record goes
     * wrong, and it is the same mistake `readWhyEnabledConfig` is pinned against for the config
     * file: a value that is not a boolean must not be able to remove the feature.
     *
     * COUNTERFACTUAL: read the record as `data?.enabled === true` — the shape `readPersistedMode`
     * uses for the MODE record, and the shape an earlier draft of this reader used. Every
     * non-`true` value then resolves to OFF, this goes red, and the block silently disappears for
     * a session that never asked for that. The mode record is not the precedent: it is a different
     * switch, and this one has an explicit direction.
     */
    await withSession(
      {
        ptc: { whyEnabled: true },
        resumeFrom: [
          { type: "custom", customType: PTC_WHY_ENTRY_TYPE, data: { enabled: "false" } },
        ],
      },
      async (stub) => {
        await runPtc(stub, "why");
        const said = stub.notifications.at(-1)?.message ?? "";
        expect(said, "a non-boolean must not resolve to off").toContain("ON");
        expect(
          said,
          "and it falls back to the file, which is where the answer came from",
        ).toContain("ptc.json");
      },
    );
  });

  test("a record with no payload at all is treated the same way", async () => {
    // Not a separate concern from the string case, but a separate shape: a record that names this
    // package and carries nothing is a writer that did not finish, and it must not read as "off".
    await withSession(
      {
        ptc: { whyEnabled: false },
        resumeFrom: [{ type: "custom", customType: PTC_WHY_ENTRY_TYPE }],
      },
      async (stub) => {
        await runPtc(stub, "why");
        const said = stub.notifications.at(-1)?.message ?? "";
        // The FILE said false here, and a malformed record does not override a valid file value
        // in either direction — it only declines to decide. So the file's OFF stands.
        expect(said).toContain("OFF");
        expect(said).toContain("ptc.json");
      },
    );
  });
});

describe("the switch writes a session record and nothing else", () => {
  test("no file appears in the agent dir, and ptc.json is byte-identical afterwards", async () => {
    /*
     * COUNTERFACTUAL: persist the decision by writing `ptc.json` (the obvious "make it durable"
     * implementation) and the byte comparison goes red. Byte-for-byte rather than "parsed equal"
     * because a writer that reformatted the file would otherwise survive the weaker check.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (stub, dir) => {
      const before = await readdir(dir);
      const original = await readFile(join(dir, CONFIG_FILE), "utf8");

      await runPtc(stub, "why off");
      await runPtc(stub, "why on");
      await runPtc(stub, "why maybe");
      await runPtc(stub, "why");

      expect(await readdir(dir), "no file was created or removed").toEqual(before);
      expect(
        await readFile(join(dir, CONFIG_FILE), "utf8"),
        "and the config this package READS is untouched",
      ).toBe(original);
      expect(whyEntries(stub), "what it did write is in the session, and only the session").toEqual(
        [
          { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: false } },
          { customType: PTC_WHY_ENTRY_TYPE, data: { enabled: true } },
        ],
      );
    });
  });
});

describe("the record has exactly the lifetime of a session", () => {
  test("a resumed session restores the decision, and the restore reaches the dispatch front", async () => {
    /*
     * COUNTERFACTUAL: drop the `applyPersistedWhy` call from `session_start` and both assertions go
     * red — the query would answer from `ptc.json` and the runtime would stay at the file's value.
     * A record that is written but never read is the definition of a persistence that does not
     * persist, and only a resume can tell the two apart.
     */
    const resumed = createBackgroundTaskRuntime({ concurrency: 1, whyEnabled: true });
    let carried: readonly { type: string; customType: string; data?: unknown }[] = [];

    await withSession({ ptc: { whyEnabled: true } }, async (first) => {
      await runPtc(first, "why off");
      carried = carriedEntries(first);
    });

    expect(
      carried.filter((entry) => entry.customType === PTC_WHY_ENTRY_TYPE),
      "the first session really left a record to carry",
    ).toHaveLength(1);

    await withSession(
      { ptc: { whyEnabled: true }, backgroundRuntime: resumed, resumeFrom: carried },
      async (second) => {
        expect(
          resumed.dispatchDeps.whyEnabled,
          "the resumed session's dispatch front starts from the record, not the file",
        ).toBe(false);
        await runPtc(second, "why");
        expect(second.notifications.at(-1)?.message, "and the user sees the same state").toContain(
          "this session",
        );
      },
    );
  });

  test("a NEW session over the same file starts from the file again", async () => {
    /*
     * COUNTERFACTUAL: make the record outlast its session by writing `ptc.json` in `applyWhy` —
     * both assertions go red. This is the whole difference between `/ptc why` and a second
     * spelling of `"whyEnabled"`, and the second session deliberately reuses the FIRST session's
     * agent dir: a fresh temp dir would have its `ptc.json` rewritten by the setup above and the
     * defect would never be observable.
     */
    await withSession({ ptc: { whyEnabled: true } }, async (first, dir) => {
      await runPtc(first, "why off");
      expect(
        first.notifications.at(-1)?.message,
        "precondition: the session really did turn it off",
      ).toContain("OFF");

      await withSession({ reuseDir: dir }, async (fresh) => {
        await runPtc(fresh, "why");
        const said = fresh.notifications.at(-1)?.message ?? "";
        expect(said, "nothing carried over").toContain("ON");
        expect(said, "and the file is in charge again").toContain("ptc.json");
        expect(whyEntries(fresh), "a fresh session has made no decisions of its own").toEqual([]);
      });
    });
  });

  test("the LAST record wins, so `off` then `on` in one session resumes as on", async () => {
    /*
     * COUNTERFACTUAL: scan the entry list FORWARD and return the first match — the two records
     * resume as `off` and the first assertion goes red. A resume that restores the user's first
     * decision and discards the correction they made afterwards is worse than one that restores
     * nothing.
     */
    let carried: readonly { type: string; customType: string; data?: unknown }[] = [];

    await withSession({ ptc: { whyEnabled: true } }, async (first) => {
      await runPtc(first, "why off");
      await runPtc(first, "why on");
      expect(whyEntries(first), "the session holds two decisions").toHaveLength(2);
      carried = carriedEntries(first);
    });

    // The FILE says false here, so the last record is the only thing that can produce ON.
    await withSession({ ptc: { whyEnabled: false }, resumeFrom: carried }, async (second) => {
      await runPtc(second, "why");
      const said = second.notifications.at(-1)?.message ?? "";
      expect(said, "the later decision outranks both the earlier one and the file").toContain("ON");
      expect(said, "and it is named as the session's").toContain("this session");
    });
  });

  test("a resumed session's restore is not re-reported as a session_start notice", async () => {
    /*
     * COUNTERFACTUAL: announce the restore ("the `why` block is OFF for this session") inside
     * `applyPersistedWhy` and the count assertion goes red. A resume that greets the user about a
     * switch they set in the session they are continuing is crying wolf — the same reason the
     * stale-key notice is only raised when there is a stale key.
     */
    let carried: readonly { type: string; customType: string; data?: unknown }[] = [];

    await withSession({ ptc: { whyEnabled: true } }, async (first) => {
      await runPtc(first, "why off");
      carried = carriedEntries(first);
    });

    await withSession({ ptc: { whyEnabled: true }, resumeFrom: carried }, async (second) => {
      expect(
        second.notifications.filter((notice) => notice.message.includes("why")),
        "restoring is not announcing",
      ).toEqual([]);
      await runPtc(second, "why");
      expect(
        second.notifications.filter((notice) => notice.message.includes("why")).length,
        "and the query still answers when asked",
      ).toBe(1);
    });
  });
});
