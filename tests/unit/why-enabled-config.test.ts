/**
 * The `whyEnabled` key: ADR-0043's switch for the dispatch caller's reason.
 *
 * Unlike `optInBindings`, whose failure direction is "a broken key grants nothing", this key's
 * failure direction is the mirror image: **a broken key leaves the block ON.** A default-on switch
 * that resolved a parse failure to `false` would let a typo — by far the most likely way this key
 * gets written — silently remove a feature the user never asked to remove, and the symptom would
 * appear on the child's prompt rather than anywhere near the file that caused it.
 *
 * So every invalid case below asserts BOTH halves: the error is reported AND the value stays on.
 * A test that only checked the error would pass against an implementation that warned and then did
 * the wrong thing, which is the shape this file exists to rule out.
 *
 * The file name is written as a literal rather than imported, so a change to the module's own
 * constant cannot quietly move the file these tests write. Same reasoning as
 * `opt-in-bindings-config.test.ts` and `legacy-surface-key.test.ts`.
 */
import { describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readWhyEnabledConfig } from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

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

describe("readWhyEnabledConfig: the block is on unless a file says otherwise", () => {
  test("no file at all leaves the block on, and says so by source", async () => {
    const dir = await makeTempDir();
    try {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a file with no whyEnabled key leaves the block on", async () => {
    // The neighbouring keys live in the same file, and `defaultMode: false` in particular turns a
    // different thing off. A reader that picked up a sibling's value would let a user who never
    // wrote this key change dispatch behaviour by editing an unrelated one.
    await withPtcJson(JSON.stringify({ defaultMode: false }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("an explicit false turns the block off, and is reported as coming from the file", async () => {
    await withPtcJson(JSON.stringify({ whyEnabled: false }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(false);
      expect(config.source).toBe("file");
      expect(config.error).toBeUndefined();
    });
  });

  test("an explicit true is honoured rather than treated as absence", async () => {
    // `"whyEnabled": true` written by hand must read the same as an absent key in BEHAVIOUR and
    // differently in PROVENANCE, so `source` is what tells the two apart when `/ptc why` reports
    // where the effective value came from.
    await withPtcJson(JSON.stringify({ whyEnabled: true }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("file");
      expect(config.error).toBeUndefined();
    });
  });
});

describe("readWhyEnabledConfig: every broken KEY leaves the block ON and says why", () => {
  test("a non-boolean value stays on, and the error names the path, the key and what arrived", async () => {
    // `"whyEnabled": "false"` is the classic string-typed boolean: JSON has no other way to write
    // one, so a hand-edited file produces it. Reading it as truthy or as absent would both be
    // guesses; the contract is on-plus-a-warning.
    await withPtcJson(JSON.stringify({ whyEnabled: "false" }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("invalid");
      expect(config.error).toContain(join(dir, CONFIG_FILE));
      expect(config.error).toContain('"whyEnabled"');
      expect(config.error).toContain("string");
    });
  });

  test("a number is the same class of mistake as a string", async () => {
    await withPtcJson(JSON.stringify({ whyEnabled: 0 }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("invalid");
      expect(config.error).toContain("number");
    });
  });

  test("an explicit null is reported, not read as absent", async () => {
    // `null` reads as "no value" to a `=== undefined` check, which would make it indistinguishable
    // from the key never having been written — and would silently drop the chance to warn.
    await withPtcJson(JSON.stringify({ whyEnabled: null }), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("invalid");
      expect(config.error).toContain('"whyEnabled"');
    });
  });
});

describe("readWhyEnabledConfig: a broken FILE leaves the block ON and says nothing", () => {
  test("unparseable JSON is `defaultMode`'s to report, not this reader's", async () => {
    /*
     * COUNTERFACTUAL: raise a "not valid JSON" error here and `tests/extension.test.ts` goes red
     * on "a broken ptc.json is reported once, never once per reader" — `readDefaultModeConfig`
     * raises the identical sentence for the same file, and two identical warnings train a user to
     * ignore warnings. The block still has to stay ON; that is what is asserted below.
     */
    await withPtcJson("{ whyEnabled: false", (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("a file that is not a JSON object is the same boundary", async () => {
    // A JSON array or a bare string parses cleanly, so a `parsed.something` read on it would
    // silently yield `undefined` — the file's being the wrong SHAPE would go unreported by the
    // reader that owns the parse, and reported twice by the two that do not own it.
    await withPtcJson(JSON.stringify([false]), (dir) => {
      const config = readWhyEnabledConfig(dir);
      expect(config.whyEnabled).toBe(true);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });
});
