/**
 * ADR-0029 — the codemode ACTIVATION probe.
 *
 * pi registers `codemode` with `defaultActive: false`, so "pi ships it" and "pi loads it" are both
 * true on an ordinary session that configured nothing, and neither means the model can call it.
 * This file pins the three ways a loadout can say otherwise.
 *
 * **This is a weaker guarantee than ADR-0027's switch oracle, and deliberately so.**
 * `resolveDefaultTools` / `mergeDefaultTools` / `isToolModifier` are module-local functions inside
 * pi's `settings-manager.js` and are NOT exported, so there is nothing to drive differentially the
 * way `codemode-switch-differential.test.ts` drives pi's real `DefaultPackageManager`. Every
 * expectation below is therefore a literal, justified against the cited line numbers, and the
 * reader is expected to re-check those lines when pi moves. What makes that sufficient is not the
 * mirror's exactness but the failure asymmetry ADR-0029 rests on: over-reporting activation is
 * caught by the `session_start` measurement, and under-reporting only costs the delegation.
 */
import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CODEMODE_TOOL_NAME,
  detectedSurfaceMode,
  readCodemodeActivation,
  resolveCodemodeActivation,
} from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

const PI = ["node", "pi"];
const NO_SETTINGS = { activation: "inactive", source: "default" } as const;

/** Both settings scopes at once, so a test states only the half it is exercising. */
function settings(overrides: { project?: unknown; user?: unknown } = {}): {
  activation: "active" | "inactive";
  source: "cli" | "project" | "user" | "default" | "invalid";
} {
  return resolveCodemodeActivation(PI, overrides.project, overrides.user);
}

describe("resolveCodemodeActivation precedence", () => {
  test("nothing configured is inactive, and that is pi's own default rather than a guess", () => {
    // pi's default active names are `["read","bash","edit","write"]` (settings-manager.js:35) and
    // codemode is not one of them, so "nobody said anything" resolves to inactive. This is the
    // cell that is the default on a real install, so it is the one that must not be guessed the
    // other way.
    expect(settings()).toEqual(NO_SETTINGS);
    expect(resolveCodemodeActivation(PI, {}, {})).toEqual(NO_SETTINGS);
    // An explicit null is not "configured" either — pi reads the key's absence the same way.
    expect(
      resolveCodemodeActivation(PI, { defaultTools: undefined }, { defaultTools: undefined }),
    ).toEqual(NO_SETTINGS);
  });

  test("the command line outranks both settings files", () => {
    // `--tools` is an allowlist that REPLACES the default loadout (agent-session.js:183 sets
    // `usesDefaultTools` false from it), so when it is present the settings are not consulted at
    // all. Both directions are stated against settings that say the OPPOSITE, so a probe that
    // silently preferred either one would turn this red:
    //   --tools names codemode, settings remove it   -> active
    //   --tools omits codemode, settings add it      -> inactive
    expect(
      resolveCodemodeActivation(
        ["node", "pi", "--tools", "read,codemode"],
        { defaultTools: ["-codemode"] },
        { defaultTools: ["-codemode"] },
      ),
    ).toEqual({ activation: "active", source: "cli" });
    expect(
      resolveCodemodeActivation(
        ["node", "pi", "--tools", "read,write"],
        { defaultTools: ["+codemode"] },
        { defaultTools: ["+codemode"] },
      ),
    ).toEqual({ activation: "inactive", source: "cli" });
    // A short flag, and the comma/trim/blank handling pi does at args.js:110.
    expect(
      resolveCodemodeActivation(["node", "pi", "-t", " read , codemode ,, "], undefined, undefined),
    ).toEqual({ activation: "active", source: "cli" });
  });

  test("a dangling --tools is ignored, because pi requires a following argument", () => {
    // `dist/cli/args.js:110` guards with `i + 1 < args.length`, so a trailing `--tools` is not a
    // flag at all. Reading it as one would take the next argument — or nothing — as the list.
    expect(resolveCodemodeActivation(["node", "pi", "--tools"], undefined, undefined)).toEqual(
      NO_SETTINGS,
    );
  });
});

describe("defaultTools resolution, pinned to pi's own rules", () => {
  test("a list of only modifiers starts from pi's four defaults, so +codemode activates it", () => {
    // `resolveDefaultTools` (settings-manager.js:55): plain names ARE the list, so an all-modifier
    // list has nothing to start from and starts from DEFAULT_TOOL_NAMES instead. Without this,
    // `["+codemode"]` would resolve to a loadout containing ONLY codemode -- which would still be
    // "active" here, but for the wrong reason, and the `-` cases below would invert.
    expect(settings({ user: { defaultTools: ["+codemode"] } })).toEqual({
      activation: "active",
      source: "user",
    });
  });

  test("a list of plain names REPLACES the defaults, and names codemode directly", () => {
    expect(
      settings({ user: { defaultTools: ["read", "bash", "edit", "write", "codemode"] } }),
    ).toEqual({ activation: "active", source: "user" });
  });

  test("-codemode removes it, and removing what is not there is not an error", () => {
    // Both no-ops in pi's loop (`index === -1` skips the splice), and both resolve to inactive.
    expect(settings({ user: { defaultTools: ["-codemode"] } })).toEqual({
      activation: "inactive",
      source: "user",
    });
    expect(settings({ user: { defaultTools: ["+codemode", "-codemode"] } })).toEqual({
      activation: "inactive",
      source: "user",
    });
  });

  test("a non-string entry is dropped rather than rejected, the way getDefaultTools drops it", () => {
    // `getDefaultTools` (settings-manager.js:1021) filters to strings before resolving, and the
    // settings files are not validated. A mirror that threw here would make a malformed value
    // crash the factory, which is a louder failure than the one pi has.
    expect(settings({ user: { defaultTools: ["+codemode", 42, null] } })).toEqual({
      activation: "active",
      source: "user",
    });
  });

  test("a defaultTools that is not an array resolves to pi's defaults", () => {
    // `getDefaultTools` (settings-manager.js:1021) filters a non-array to `[]` and then calls
    // `resolveDefaultTools([])`, whose ternary takes the `entries.length === 0` branch — so the
    // result is an EMPTY list, not the four defaults. Empty or not, codemode is not in it.
    //
    // (That branch is worth stating because it is the one that looks like a default and is not:
    // only an all-modifier list that is NON-empty starts from `DEFAULT_TOOL_NAMES`.)
    expect(settings({ user: { defaultTools: "codemode" } })).toEqual({
      activation: "inactive",
      source: "user",
    });
  });

  test("the base an all-modifier list starts from is the four built-ins and not codemode", () => {
    // This is the case that pins `PI_DEFAULT_TOOL_NAMES` as a SET rather than as a fallback:
    // `["+codemode"]` proves codemode is addable, and `["-codemode"]` proves it is removable, but
    // both leave the question "is codemode in the base already?" open — and the answer decides
    // every modifier that is not about codemode. Adding codemode to the base turns this red,
    // which is the only reason the constant is pinned here rather than left to inspection.
    for (const modifier of ["+read", "+grep", "-bash", "+edit"]) {
      expect(settings({ user: { defaultTools: [modifier] } }), modifier).toEqual({
        activation: "inactive",
        source: "user",
      });
    }
    // And the positive control: the same shape, naming codemode, does activate it.
    expect(settings({ user: { defaultTools: ["+codemode"] } })).toEqual({
      activation: "active",
      source: "user",
    });
  });
});

describe("project over user, by pi's own merge rule", () => {
  test("a project list of only modifiers concatenates onto the user list", () => {
    // `mergeDefaultTools` (settings-manager.js:43): the project list is the override and the user
    // list the base, from `deepMergeSettings(globalSettings, projectSettings)` (`:196`). A project
    // can therefore add codemode without restating the user list.
    expect(
      settings({ user: { defaultTools: ["read"] }, project: { defaultTools: ["+codemode"] } }),
    ).toEqual({ activation: "active", source: "project" });
  });

  test("a project list containing a plain name replaces the user list outright", () => {
    // Same function, other branch: plain names decide a list rather than edit one, so their
    // presence makes the project's list the whole answer and the user's is discarded. Here the
    // project says `read` alone, so codemode is NOT active even though the user asked for it.
    expect(
      settings({ user: { defaultTools: ["+codemode"] }, project: { defaultTools: ["read"] } }),
    ).toEqual({ activation: "inactive", source: "project" });
  });

  test("the project wins in the other direction too", () => {
    expect(
      settings({ user: { defaultTools: ["read"] }, project: { defaultTools: ["codemode"] } }),
    ).toEqual({ activation: "active", source: "project" });
  });
});

describe("readCodemodeActivation over real files", () => {
  test("a user settings file that names codemode is read, and the project file that overrides it wins", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ defaultTools: ["+codemode"] }),
        "utf8",
      );
      // The project scope lives under `<cwd>/.pi`, so `cwd` is a second temp dir here.
      const cwd = await makeTempDir();
      try {
        expect(readCodemodeActivation(dir, cwd, PI)).toEqual({
          activation: "active",
          source: "user",
        });
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await writeFile(
          join(cwd, ".pi", "settings.json"),
          JSON.stringify({ defaultTools: ["-codemode"] }),
          "utf8",
        );
        expect(readCodemodeActivation(dir, cwd, PI)).toEqual({
          activation: "inactive",
          source: "project",
        });
      } finally {
        await removeTempDir(cwd);
      }
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a settings file that is not a JSON object is reported, and the answer still resolves", async () => {
    // The failure path the repo's testing constraints ask for: a broken file must never
    // half-apply, and it must never be silent. The switch is still resolvable — it falls through
    // to the other scope — so the probe reports `invalid` with the reason rather than guessing.
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "settings.json"), "{ not json", "utf8");
      const resolved = readCodemodeActivation(dir, dir, PI);
      expect(resolved.activation, "the answer still resolves").toBe("inactive");
      expect(resolved.source, "and the broken file is named as the reason").toBe("invalid");
      expect(resolved.error).toContain("not valid JSON");
      expect(resolved.error).toContain("settings.json");
    } finally {
      await removeTempDir(dir);
    }
  });

  test("an absent settings file is the default, not an error", async () => {
    const dir = await makeTempDir();
    try {
      expect(readCodemodeActivation(dir, dir, PI)).toEqual(NO_SETTINGS);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("the fifth cell of the detected table", () => {
  test("present and loadable but not callable is full, and activation is the only difference", () => {
    // The counterfactual for the whole ADR: with the activation argument held at `active`, this
    // exact presence/switch pair resolves to `subagents`. Dropping the third check from
    // `detectedSurfaceMode` turns both assertions red.
    const presence = { present: true, how: "found" } as const;
    expect(detectedSurfaceMode(presence, "absent", "active")).toBe("subagents");
    expect(detectedSurfaceMode(presence, "absent", "inactive")).toBe("full");
    // And a disabled extension is `full` either way, which is what makes the switch the
    // stronger of the two signals.
    expect(detectedSurfaceMode(presence, "disabled", "active")).toBe("full");
    expect(detectedSurfaceMode(presence, "disabled", "inactive")).toBe("full");
  });

  test("the probe asks about the same name the host registers", () => {
    // A mirror pointed at the wrong string is inert: every case above would still pass while the
    // real `codemode` went unnamed. pi's own constant is `CODEMODE_TOOL_NAME` in
    // `dist/extensions/codemode/tool.d.ts`, and the factory reads the same literal.
    expect(CODEMODE_TOOL_NAME).toBe("codemode");
  });
});
