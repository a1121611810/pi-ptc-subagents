/**
 * The `optInBindings` key: the user-facing half of #73.
 *
 * `bash` leaves the default PTC surface, so the way back is a one-line key in the agent dir's
 * `ptc.json`. That makes this reader the only path by which a shell reaches a model-written
 * program, and its failure direction is the thing worth pinning: **a broken key grants nothing.**
 *
 * The tempting wrong implementation is to fall back to "the value we understood" or to treat an
 * unreadable list as "no restriction stated, so allow everything". Both would make a typo — the
 * single most likely way this key gets written — the thing that hands out a shell. Every invalid
 * case below therefore asserts BOTH halves: the error is reported AND nothing is granted. A test
 * that only checked the error would pass against an implementation that logged a warning and then
 * did the dangerous thing, which is the shape this file exists to rule out.
 *
 * Success cases are pinned to {@link OPT_IN_BINDING_NAMES} rather than to a hardcoded list, so
 * adding an opt-in later cannot leave this file asserting a set that no longer exists.
 */
import { describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OPT_IN_BINDING_NAMES } from "../../src/runtime/bindings.ts";
import { readOptInBindingsConfig } from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/**
 * Named as a literal rather than imported from the module, so a change to the module's own
 * constant cannot quietly move the file this test writes. Same reasoning as
 * `legacy-surface-key.test.ts`, which reads the same file.
 */
const CONFIG_FILE = "ptc.json";

/** Write `contents` as the agent dir's `ptc.json`, hand the dir to `check`, clean up. */
async function withPtcJson(contents: string, check: (agentDir: string) => void): Promise<void> {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, CONFIG_FILE), contents, "utf8");
    check(dir);
  } finally {
    await removeTempDir(dir);
  }
}

describe("readOptInBindingsConfig: the granting path", () => {
  test("no file at all grants nothing, and says so by source", async () => {
    const dir = await makeTempDir();
    try {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a file with no optInBindings key grants nothing", async () => {
    // `defaultMode` living in the same file must not be mistaken for an opt-in grant: this key is
    // read on its own, and a `ptc.json` that only turns the mode on leaves the surface narrowed.
    await withPtcJson(JSON.stringify({ defaultMode: false }), (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("an empty list is a file that grants nothing, not a broken file", async () => {
    // The two are told apart deliberately: `[]` is a decision, and reporting it as invalid would
    // nag a user who deliberately spelled out "I want the narrow surface".
    await withPtcJson(JSON.stringify({ optInBindings: [] }), (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("file");
      expect(config.error).toBeUndefined();
    });
  });

  test("every name in OPT_IN_BINDING_NAMES is grantable, and only those", async () => {
    const all = [...OPT_IN_BINDING_NAMES];
    expect(all.length).toBeGreaterThan(0);
    await withPtcJson(JSON.stringify({ optInBindings: all }), (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.source).toBe("file");
      expect(config.error).toBeUndefined();
      expect([...config.optInBindings]).toEqual(all);
    });
  });

  // There is deliberately NO "emitted in BUILTIN order" test here. With one opt-in name,
  // `[...OPT_IN_BINDING_NAMES].reverse()` is the identity, so such a test would pass whether or not
  // `resolveOptInBindingNames` normalised order — it could not fail, and a test that cannot fail
  // is worse than no test because it reads as coverage. The property becomes observable the moment
  // a second opt-in name exists; add it then, and assert against `BUILTIN_BINDING_NAMES` rather
  // than a hand-written list. Deduplication, which IS observable with one name, is pinned above.

  test("a duplicate entry is granted once", async () => {
    await withPtcJson(JSON.stringify({ optInBindings: ["bash", "bash"] }), (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.source).toBe("file");
      expect([...config.optInBindings]).toEqual(["bash"]);
    });
  });
});

describe("readOptInBindingsConfig: every broken KEY grants nothing AND says why", () => {
  /**
   * The shared half of every key-level invalid case. Called for each fixture below rather than
   * repeated, so that adding a new broken shape cannot skip the "grants nothing" assertion — the
   * direction that matters is the easy one to leave out.
   */
  function expectGrantsNothingAndReports(contents: string, expectIn: RegExp): Promise<void> {
    return withPtcJson(contents, (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("invalid");
      expect(config.error).toMatch(expectIn);
    });
  }

  test("a non-array value", () =>
    expectGrantsNothingAndReports(
      JSON.stringify({ optInBindings: "bash" }),
      /"optInBindings" must be an array of binding names, received string/,
    ));

  test("a non-string entry", () =>
    expectGrantsNothingAndReports(
      JSON.stringify({ optInBindings: ["bash", 7] }),
      /"optInBindings" entries must be strings, received number/,
    ));

  test("an unknown name", () =>
    expectGrantsNothingAndReports(
      JSON.stringify({ optInBindings: ["teleport"] }),
      /unknown PTC opt-in binding "teleport"/,
    ));

  test("a known builtin that was never an opt-in", () =>
    // `read` is in the default set already. Accepting it would make the key look broken to a user
    // who added it by mistake, and would mean `optIns` reported success while changing nothing.
    expectGrantsNothingAndReports(
      JSON.stringify({ optInBindings: ["read"] }),
      /unknown PTC opt-in binding "read"/,
    ));

  test("one bad name among good ones grants none of them", () =>
    // All-or-nothing is the point. Granting the valid entry would leave a user who misspelled one
    // name with a surface they did not ask for and no way to tell which half was applied.
    expectGrantsNothingAndReports(
      JSON.stringify({ optInBindings: ["bash", "nope"] }),
      /unknown PTC opt-in binding "nope"/,
    ));
});

/**
 * A file too broken to parse is `readDefaultModeConfig`'s to report, not this reader's.
 *
 * Asserted as a boundary rather than left implied, because the alternative — reporting it here too
 * — puts the identical sentence on screen once per reader for ONE broken file, which trains the user
 * to ignore the notice that matters. Both still grant nothing; the difference is only which reader
 * says so.
 *
 * This file pins the reader's half (it returns `source: "default"` and no `error`); the other half —
 * that a broken file produces exactly ONE notice on screen — is pinned end to end by
 * `tests/extension.test.ts > a broken ptc.json is reported once, never once per reader`, which
 * drives a real `session_start`. The split is deliberate: this file cannot see the notice, and the
 * extension test cannot see the return value, so neither assertion stands alone.
 */
describe("readOptInBindingsConfig: a broken FILE is silent here, and still grants nothing", () => {
  test("unparseable JSON", async () => {
    await withPtcJson("{ not json", (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("a file that is not a JSON object", async () => {
    await withPtcJson(JSON.stringify(["bash"]), (dir) => {
      const config = readOptInBindingsConfig(dir);
      expect(config.optInBindings).toEqual([]);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });
});

describe("readOptInBindingsConfig: the error names the valid opt-ins", () => {
  test("the message carries OPT_IN_BINDING_NAMES, so the notice can list what to write", async () => {
    // The `session_start` notice interpolates the constant rather than the file's value, so this
    // asserts the pairing that makes the notice useful: the rejected name AND the accepted set,
    // in one message the user can act on without reading the source.
    expect(OPT_IN_BINDING_NAMES.length).toBeGreaterThan(0);
    await withPtcJson(JSON.stringify({ optInBindings: ["teleport"] }), (dir) => {
      const { error } = readOptInBindingsConfig(dir);
      expect(error).toMatch(/unknown PTC opt-in binding "teleport"/);
      expect(error).toMatch(new RegExp(`opt-in bindings: ${OPT_IN_BINDING_NAMES.join(", ")}`));
    });
  });
});
