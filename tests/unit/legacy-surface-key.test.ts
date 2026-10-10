/**
 * The `surfaceMode` key this package no longer acts on.
 *
 * `surfaceMode` shipped in v1.6.0 and could pin one of three surfaces. The surface is now DETECTED
 * (ADR-0026 / ADR-0029), so the key is inert — and a user who set `"off"` to keep this package out
 * of their sessions would find it back on after upgrading with nothing to explain why.
 * `readLegacySurfaceKey` exists so `session_start` can say so. **It reports; it does not restore.**
 *
 * The distinction is the whole point of the file, so it is stated as an expectation rather than a
 * comment: a test that only checked "a stale key is detected" would still pass against an
 * implementation that honoured `"off"`, and honouring it is the switch this change deletes
 * (`ptc-mode.ts`'s doc comment on the function says the same thing).
 *
 * ## What counts as a legacy key
 *
 * A `ptc.json` that parses as a JSON OBJECT and has a `surfaceMode` key whose value is not
 * `undefined`. Anything else returns `undefined`, including the two cases that cannot be blamed on
 * the key: a file that will not parse, and a file that is not an object. Neither is reported here
 * because a file too broken to read has no `surfaceMode` to be stale about, and the parse failure
 * belongs to whoever owns that file — `defaultMode` still lives in it, and `readDefaultModeConfig`
 * is what reports that. Those two are asserted here so the boundary is pinned rather than implied.
 */
import { describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLegacySurfaceKey } from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/**
 * The file the key is looked for in, named as a literal rather than imported from the module, so
 * that a change to the module's own constant cannot quietly move the file this test writes.
 */
const CONFIG_FILE = "ptc.json";

/** Write `contents` as the agent dir's `ptc.json`, hand the realpath'd dir to `check`, clean up. */
async function withPtcJson(contents: string, check: (agentDir: string) => void): Promise<void> {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, CONFIG_FILE), contents, "utf8");
    check(dir);
  } finally {
    await removeTempDir(dir);
  }
}

describe("readLegacySurfaceKey: what is reported", () => {
  test("a surfaceMode is reported with the file it was found in, for every value it ever took", () => {
    // All three historical values, not just `"off"`. `"subagents"` and `"full"` are also stale
    // after the switch was removed, and a mirror that filtered to a single value -- or that only
    // looked for the one that disables the package -- would pass a one-case test and miss the
    // other two. The path is the realpath'd temp dir plus the file name, because a notice that
    // names a path the user cannot open is not a notice.
    return Promise.all(
      (["off", "subagents", "full"] as const).map(async (value) => {
        await withPtcJson(JSON.stringify({ surfaceMode: value }), (dir) => {
          expect(readLegacySurfaceKey(dir), value).toStrictEqual({
            path: join(dir, CONFIG_FILE),
            value,
          });
        });
      }),
    );
  });

  test("a non-string value is reported as what it is, not rendered into a string", () => {
    // `"surfaceMode": 123` is a hand-edited file, not one of the three legal values, and the
    // whole point of reporting is that the user is TOLD rather than left guessing. Rendering it
    // (`String(value)`, or JSON-stringifying the object form) would make the notice claim a value
    // the file does not contain, so the assertion is on the number, not on a string of it.
    return withPtcJson(JSON.stringify({ surfaceMode: 123 }), (dir) => {
      const key = readLegacySurfaceKey(dir);
      expect(key?.value).toBe(123);
      expect(key).toStrictEqual({ path: join(dir, CONFIG_FILE), value: 123 });
    });
  });

  test("a value that is falsy but present is still a value, and is still reported", () => {
    // `""` is `!== undefined`, so it is a stale key like any other. A reader written as
    // `if (!value) return undefined` -- the natural shape when the three legal values are all
    // non-empty strings -- would swallow it, and would swallow any future falsy value with it.
    return withPtcJson(JSON.stringify({ surfaceMode: "" }), (dir) => {
      expect(readLegacySurfaceKey(dir)).toStrictEqual({
        path: join(dir, CONFIG_FILE),
        value: "",
      });
    });
  });
});

describe("readLegacySurfaceKey: what is not reported", () => {
  test("an agent dir with no ptc.json reports nothing", async () => {
    // The IO failure path (ENOENT) and the ordinary case at the same time: most agent dirs have
    // no `ptc.json` at all, so an absent file has to be silent rather than a reported error.
    const dir = await makeTempDir();
    try {
      expect(readLegacySurfaceKey(dir)).toBeUndefined();
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a ptc.json with no surfaceMode key reports nothing", async () => {
    // `{}` is the file `readDefaultModeConfig` writes for a user who set `defaultMode`, and it is
    // the common case for anyone who never touched the removed switch. The other key is present
    // precisely so the check is on the KEY rather than on the file being non-empty.
    for (const body of ["{}", JSON.stringify({ defaultMode: true })]) {
      await withPtcJson(body, (dir) => {
        expect(readLegacySurfaceKey(dir), body).toBeUndefined();
      });
    }
  });

  test("a ptc.json that is not a JSON object reports nothing", async () => {
    // `[]` and `null` are both values `JSON.parse` accepts, so both reach the object check rather
    // than the catch. A reader that stopped at `typeof parsed === "object"` would look up
    // `surfaceMode` on an array (always `undefined`, harmless here) and would then try to read
    // `surfaceMode` off `null` -- which throws, and an uncaught throw inside `session_start` is a
    // far worse outcome than a missed notice.
    for (const body of ["[]", "null"]) {
      await withPtcJson(body, (dir) => {
        expect(readLegacySurfaceKey(dir), body).toBeUndefined();
      });
    }
  });

  test("a ptc.json that will not parse reports nothing, and reports nothing by not guessing", () => {
    // Two things are pinned at once. The unparseable file returns `undefined` (the parse failure
    // belongs to `readDefaultModeConfig`), and the second body is a TRUNCATED object that
    // literally contains `"surfaceMode": "off"` in its text -- so a reader that went looking for
    // the key as a substring, or that reported on a failed parse, would announce a stale key the
    // user could never have set in a file pi never read.
    return Promise.all(
      ["{ not json", '{ "surfaceMode": "off"'].map(async (body) => {
        await withPtcJson(body, (dir) => {
          expect(readLegacySurfaceKey(dir), body).toBeUndefined();
        });
      }),
    );
  });
});
