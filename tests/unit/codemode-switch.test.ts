/**
 * ADR-0027 — the codemode SWITCH, as distinct from the codemode PROBE.
 *
 * The probe asks "is the directory on disk". The switch asks "will pi load it". pi 0.99.0 added
 * `-builtin:<name>`, which made those two different questions with different answers, and the
 * first version of this feature conflated them: a user who disabled pi's codemode kept getting
 * `codemode_ptc` surface and therefore no `ptc_run_code`, with nothing to orchestrate in its place.
 *
 * Every case below is pinned to pi's OWN resolution, read from
 * `dist/core/package-manager.js` (`isEnabledByOverrides` + the built-in loop) rather than to the
 * prose in `docs/settings.md`, and the four-case table is asserted as a table so a change to any
 * one cell fails on its own.
 */
import { describe, expect, test } from "vitest";
import {
  detectedSurfaceMode,
  detectSurfaceMode,
  normalizePatternPath,
  probeCodemodePresence,
  readCodemodeSwitch,
  resolveCodemodeSwitch,
} from "../../src/mode/ptc-mode.ts";
import type { CodemodePresence, CodemodeSwitch } from "../../src/mode/ptc-mode.ts";
import { makeStubInAgentDir, makeTempDir, removeTempDir } from "../helpers/ptc.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const PRESENT: CodemodePresence = { present: true, how: "found" };
const ABSENT: CodemodePresence = { present: false, how: "not-found" };
/**
 * ADR-0029's third axis, stated here because the switch is not enough on its own to reach `codemode_ptc`.
 *
 * `source: "loadout"` is the only provenance a real session can produce: `session_start` reads
 * activation from `pi.getActiveTools()`, so the user file, the project file and `argv` are no
 * longer consulted and there is nothing left to name. `"cli"`, `"project"`, `"user"` and
 * `"default"` were sources of the deleted settings/argv mirror.
 */
const ACTIVE = { activation: "active", source: "loadout" } as const;
/**
 * A loadout pi would report for the `ACTIVE` axis above.
 *
 * `detectSurfaceMode` takes it as its second argument now — that read is the ACTIVE third axis —
 * so a call that pins `codemodeActivation` passes it for coherence rather than because it decides.
 */
const LOADOUT_WITH_CODEMODE = ["read", "bash", "edit", "write", "codemode"];

/**
 * pi's own `normalizePath` (the oracle for the `normalizePatternPath` block below), loaded at
 * MODULE scope so the test bodies hold no guard.
 *
 * A `skipIf` whose body early-returns is the F3 opt-in-gate false pass
 * `tests/test-meta-discipline.test.ts` exists to catch, and
 * `codemode-switch-differential.test.ts` already sets the precedent for reaching a pi INTERNAL
 * module here: `dist/utils/paths.js` is not in the package's `exports` map, so it is walked up
 * from the repo root rather than resolved by specifier, and imported by absolute file URL.
 * `undefined` reports SKIPPED, which is visibly not green.
 */
function piPathsPath(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "utils",
      "paths.js",
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const PI_PATHS_FILE = piPathsPath();

const PI_NORMALIZE_PATH: ((input: string) => string) | undefined = await (async () => {
  if (PI_PATHS_FILE === undefined) return undefined;
  try {
    const mod = (await import(/* @vite-ignore */ PI_PATHS_FILE)) as {
      normalizePath?: (input: string) => string;
    };
    return typeof mod.normalizePath === "function" ? mod.normalizePath : undefined;
  } catch {
    return undefined;
  }
})();

/**
 * The SWITCH axis of the table, asserted as a table rather than case by case.
 *
 * ADR-0029 added a third axis, so every cell here states the activation too. It is `active`
 * throughout because this file is about the switch: the cell where a loaded codemode is not
 * callable belongs to the activation table, and pinning it here would make these assertions about
 * a column they do not vary.
 */
const TABLE: ReadonlyArray<readonly [CodemodePresence, CodemodeSwitch, string]> = [
  [PRESENT, "absent", "codemode_ptc"],
  [PRESENT, "enabled", "codemode_ptc"],
  [PRESENT, "disabled", "full_ptc"],
  [ABSENT, "absent", "full_ptc"],
  [ABSENT, "enabled", "full_ptc"],
  [ABSENT, "disabled", "full_ptc"],
];

describe("ADR-0027 codemode switch", () => {
  test("the switch axis of the table, each cell asserted on its own", () => {
    const actual = TABLE.map(
      ([presence, sw]) =>
        `${presence.present ? "on-disk" : "absent"}/${sw}=>${detectedSurfaceMode(presence, sw, "active")}`,
    );
    expect(actual).toEqual([
      "on-disk/absent=>codemode_ptc",
      "on-disk/enabled=>codemode_ptc",
      "on-disk/disabled=>full_ptc",
      "absent/absent=>full_ptc",
      "absent/enabled=>full_ptc",
      "absent/disabled=>full_ptc",
    ]);
  });

  test("disabling codemode is the only SWITCH value that turns a present codemode into full_ptc", () => {
    // The counterfactual this whole feature exists for: with `disabled` dropped, a user who
    // turned codemode off would silently keep losing ptc_run_code.
    //
    // "only switch value", not "only value": ADR-0029 added a second way to reach `full_ptc` for a
    // present codemode -- an inactive one -- and claiming otherwise here would be a title that
    // has quietly stopped being true.
    const withoutDisabled = TABLE.filter(([, sw]) => sw !== "disabled").map(([presence, sw]) =>
      detectedSurfaceMode(presence, sw, "active"),
    );
    expect(new Set(withoutDisabled)).toEqual(new Set(["codemode_ptc", "full_ptc"]));
    expect(detectedSurfaceMode(PRESENT, "disabled", "active")).toBe("full_ptc");
  });
});

describe("resolveCodemodeSwitch precedence", () => {
  test("nothing anywhere means pi's default, which is to load it", () => {
    expect(resolveCodemodeSwitch(["node", "pi"], undefined, undefined)).toEqual({
      switch: "absent",
      source: "default",
    });
  });

  test("a project entry beats a user entry", () => {
    const resolved = resolveCodemodeSwitch(
      ["node", "pi"],
      { extensions: ["-builtin:codemode"] },
      { extensions: ["+builtin:codemode"] },
    );
    expect(resolved).toEqual({ switch: "disabled", source: "project" });
  });

  test("a user entry is used when the project says nothing", () => {
    const resolved = resolveCodemodeSwitch(
      ["node", "pi"],
      { extensions: ["./some/other/ext.ts"] },
      { extensions: ["-builtin:codemode"] },
    );
    expect(resolved).toEqual({ switch: "disabled", source: "user" });
  });

  test("the last matching entry in one array wins", () => {
    // pi writes into a Map as it iterates (`applyAutoloadDisabledPatterns`), so a later entry
    // overwrites an earlier one rather than being ignored. This is the PROJECT array's rule;
    // the user array is resolved by a different function — see the next test.
    expect(
      resolveCodemodeSwitch(
        ["node", "pi"],
        { extensions: ["-builtin:codemode", "+builtin:codemode"] },
        undefined,
      ).switch,
    ).toBe("enabled");
    expect(
      resolveCodemodeSwitch(
        ["node", "pi"],
        { extensions: ["+builtin:codemode", "-builtin:codemode"] },
        undefined,
      ).switch,
    ).toBe("disabled");
  });

  test("the USER array applies pi's bucket precedence instead: `-` beats `+` wherever it sits", () => {
    // pi resolves the two arrays by DIFFERENT functions, and this test exists because reading
    // them as one is the bug it pins:
    //   project -> `applyAutoloadDisabledPatterns` (package-manager.js:741), which writes into a
    //              Map as it iterates, so the LAST matching entry wins;
    //   user    -> `isEnabledByOverrides` (package-manager.js:742), which splits the array into
    //              `!` / `+` / `-` buckets and applies them in that order, so position is
    //              irrelevant and `-` always beats `+` (:531-540).
    // Reading the user array with last-match-wins resolves `["-","+"]` to `enabled` where pi
    // resolves it to `disabled` — and that is the exact failure ADR-0027 exists to prevent.
    for (const extensions of [
      ["-builtin:codemode", "+builtin:codemode"],
      ["+builtin:codemode", "-builtin:codemode"],
    ]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, { extensions }).switch,
        JSON.stringify(extensions),
      ).toBe("disabled");
    }
  });

  test("a bare `+` still enables in the user array, with no `-` to outrank it", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: ["+builtin:codemode"] })
        .switch,
    ).toBe("enabled");
  });

  test("a `!` glob aimed at codemode disables it, because pi matches that bucket with minimatch", () => {
    // pi's `!` bucket goes through `matchesAnyPattern`, which is `minimatch` against the rel path,
    // the basename AND the full posix path (package-manager.js:482-490). So `!builtin:cod*`
    // disables `builtin:codemode` in pi, where an exact-name comparison would not have matched.
    // Erring toward `disabled` is also the direction this package already chose everywhere else:
    // "a probe that cannot answer must not be allowed to answer yes" — `codemode_ptc` as a failure
    // mode takes away the session's orchestrator (FALLBACK_SURFACE_MODE).
    for (const entry of ["!builtin:cod*", "!builtin:*codemode", "!*codemode"]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: [entry] }).switch,
        entry,
      ).toBe("disabled");
    }
  });

  test("a `!` entry that cannot match codemode does not disable it", () => {
    // Three groups, all of which must leave codemode alone: entries naming another builtin, a
    // near-miss, and the bare-prefix form. Swallowing any of them would cost a user who disabled
    // `mcp` their `ptc_run_code`.
    //
    // `!builtin:` is the case that separates glob from exact. minimatch treats a pattern with no
    // metacharacter as an EXACT match, not a prefix match, so it does NOT catch `builtin:codemode`
    // — measured against pi's own resolver, which reports `enabled: true` for it. An earlier
    // version of this test asserted the opposite and passed, because the implementation compared
    // literal PREFIXES for every `!` entry and so over-matched here; the two errors cancelled.
    for (const entry of [
      "!builtin:mcp",
      "!builtin:llama.cpp",
      "!builtin:tool-*",
      "!builtin:",
      "!builtin:codemodX",
    ]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: [entry] }).switch,
        entry,
      ).toBe("absent");
    }
  });

  test("entries that do not name codemode are ignored", () => {
    const resolved = resolveCodemodeSwitch(
      ["node", "pi"],
      { extensions: ["-builtin:mcp", "./x.ts", "-builtin:tool-search"] },
      undefined,
    );
    expect(resolved).toEqual({ switch: "absent", source: "default" });
  });

  test("a non-array extensions value does not decide anything", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi"], { extensions: "-builtin:codemode" }, undefined),
    ).toEqual({
      switch: "absent",
      source: "default",
    });
  });
});

describe("resolveCodemodeSwitch command line", () => {
  test("-ne disables it", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi", "-ne"], undefined, {
        extensions: ["+builtin:codemode"],
      }),
    ).toEqual({
      switch: "disabled",
      source: "cli",
    });
  });

  test("--no-extensions disables it", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi", "--no-extensions"], undefined, undefined).switch,
    ).toBe("disabled");
  });

  test("-e builtin:codemode wins over -ne, because that is the order pi resolves them in", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi", "-ne", "-e", "builtin:codemode"], undefined, undefined),
    ).toEqual({ switch: "enabled", source: "cli" });
  });

  test("--extension is read the same way -e is", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi", "--extension", "builtin:codemode"], undefined, undefined)
        .switch,
    ).toBe("enabled");
  });

  test("the attached short form is NOT honoured, because pi rejects it outright", () => {
    // `pi -ebuiltin:codemode` answers "Error: Unknown option" (measured on 1.0.0), and
    // `dist/cli/args.js` only ever reads `args[++i]` after a bare `-e`. Recognising it here
    // would make this package believe a session is running that pi refused to start.
    expect(
      resolveCodemodeSwitch(["node", "pi", "-ebuiltin:codemode"], undefined, undefined),
    ).toEqual({
      switch: "absent",
      source: "default",
    });
  });

  test("-e naming a different extension does not enable codemode", () => {
    expect(
      resolveCodemodeSwitch(["node", "pi", "-e", "builtin:mcp"], undefined, undefined),
    ).toEqual({
      switch: "absent",
      source: "default",
    });
  });

  test("argv[0] is never read as a flag", () => {
    // `-e` in position 0 is the interpreter name slot; treating it as a flag would let a
    // process launched as `-e` flip the answer.
    expect(resolveCodemodeSwitch(["-e", "builtin:codemode"], undefined, undefined).switch).toBe(
      "absent",
    );
  });
});

describe("readCodemodeSwitch over real files", () => {
  test("a project settings file is read from <cwd>/.pi/settings.json", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await mkdir(join(root, ".pi"), { recursive: true });
      await writeFile(
        join(root, ".pi", "settings.json"),
        JSON.stringify({ extensions: ["-builtin:codemode"] }),
      );
      const resolved = readCodemodeSwitch(root, root, ["node", "pi"]);
      expect(resolved).toEqual({ switch: "disabled", source: "project" });
    } finally {
      await removeTempDir(root);
    }
  });

  test("a user settings file is read from <agentDir>/settings.json", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ extensions: ["-builtin:codemode"] }),
      );
      const resolved = readCodemodeSwitch(root, root, ["node", "pi"]);
      expect(resolved).toEqual({ switch: "disabled", source: "user" });
    } finally {
      await removeTempDir(root);
    }
  });

  test("a malformed settings file falls through to the next source and says so", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(join(root, "settings.json"), "{ this is not json");
      const resolved = readCodemodeSwitch(root, root, ["node", "pi"]);
      // The switch is pi's default (loaded) -- the one answer that is right without the file.
      expect(resolved.switch).toBe("absent");
      expect(resolved.source).toBe("invalid");
      expect(resolved.error).toContain("is not valid JSON");
    } finally {
      await removeTempDir(root);
    }
  });

  test("an absent settings file is not an error", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      expect(readCodemodeSwitch(root, root, ["node", "pi"])).toEqual({
        switch: "absent",
        source: "default",
      });
    } finally {
      await removeTempDir(root);
    }
  });
});

describe("the switch is what decides, over real files", () => {
  // The describes this replaces asserted a conflict between a PINNED surface and the table. There
  // is no pinned surface any more, so there is nothing to disagree with anything: the table is the
  // only input. What is left to pin is that the table really is reached through the files, which
  // is the claim these two make in the only form that still exists.
  test("a user settings file that disables codemode answers `full_ptc` with no key to disagree with", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ extensions: ["-builtin:codemode"] }),
      );
      // `detectSurfaceMode` returns all four fields and nothing else: there is no `source` and no
      // `detected`, because nothing can override the answer and so nothing needs reporting as
      // overridden. `toEqual` on the whole object is what pins the absence.
      expect(
        detectSurfaceMode(root, LOADOUT_WITH_CODEMODE, PRESENT, undefined, ACTIVE, root),
      ).toEqual({
        surfaceMode: "full_ptc",
        codemode: PRESENT,
        codemodeSwitch: { switch: "disabled", source: "user" },
        codemodeActivation: ACTIVE,
      });
    } finally {
      await removeTempDir(root);
    }
  });

  test("the same agent dir with codemode enabled answers `codemode_ptc`", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ extensions: ["+builtin:codemode"] }),
      );
      expect(
        detectSurfaceMode(root, LOADOUT_WITH_CODEMODE, PRESENT, undefined, ACTIVE, root)
          .surfaceMode,
      ).toBe("codemode_ptc");
    } finally {
      await removeTempDir(root);
    }
  });

  test("a `surfaceMode` key in ptc.json is not an input at all", async () => {
    // The direct counterfactual: a reader that still honoured the key would answer `codemode_ptc`
    // here, where the switch says `disabled`. Every historical value is stated because the key is
    // reported as a whole and a filter to one of them would leave the others unannounced.
    for (const stale of ["off", "subagents", "full"]) {
      const root = await makeTempDir("pi-ptc-switch-");
      try {
        await writeFile(join(root, "ptc.json"), JSON.stringify({ surfaceMode: stale }));
        await writeFile(
          join(root, "settings.json"),
          JSON.stringify({ extensions: ["-builtin:codemode"] }),
        );
        expect(
          detectSurfaceMode(root, LOADOUT_WITH_CODEMODE, PRESENT, undefined, ACTIVE, root)
            .surfaceMode,
          stale,
        ).toBe("full_ptc");
      } finally {
        await removeTempDir(root);
      }
    }
  });
});

describe("the registration the switch actually produces", () => {
  test("codemode on disk but disabled registers the PTC surfaces", async () => {
    // The regression this file exists for, asserted at the level the user sees it: the set of
    // tools a model can call. Asserting only on `detectedSurfaceMode` would pass even if the
    // factory stopped consulting the switch.
    //
    // Activation is stated as `active` on purpose: with the switch disabled the answer is `full_ptc`
    // whatever the loadout says, so this cell stays `full_ptc` even when codemode IS callable. That
    // makes it the one case where the switch overrides a working activation — and the only way
    // that assertion can be reached is by a reader that really read the switch.
    const { stub, dir } = await makeStubInAgentDir({
      codemode: PRESENT,
      codemodeSwitch: { switch: "disabled", source: "user" },
      codemodeActivation: ACTIVE,
    });
    try {
      const names = [...stub.tools.keys()];
      expect(names).toContain("ptc_run_code");
      expect(names).toContain("ptc_workflow");
      expect(names).not.toContain("pi_task_codemode");
    } finally {
      await removeTempDir(dir);
    }
  });

  test("codemode on disk and loaded registers only the subagent face", async () => {
    // ADR-0029: "loaded" is no longer enough. These cells also need codemode in the LOADOUT, and
    // that axis is STATED rather than written into a settings file: the surface is read from
    // `pi.getActiveTools()` at `session_start`, so a `defaultTools` entry in the agent dir no
    // longer decides anything. `ACTIVE` below is that statement.
    for (const sw of ["absent", "enabled"] as const) {
      const { stub, dir } = await makeStubInAgentDir({
        codemode: PRESENT,
        codemodeSwitch: { switch: sw, source: "default" },
        codemodeActivation: ACTIVE,
      });
      try {
        const names = [...stub.tools.keys()];
        expect(names, sw).toContain("pi_task_codemode");
        // The program pair IS registered on this line, at `codemode` reach — callable from a
        // pi `codemode` script, which is what a loaded-and-enabled codemode provides. What must
        // NOT hold is the pair being declared to the model, which is the duplicate surface this
        // line exists to avoid; that is asserted by reach, not by presence.
        for (const name of ["ptc_run_code", "ptc_workflow"] as const) {
          const definition = stub.tools.get(name) as { exposure?: string } | undefined;
          expect(definition?.exposure ?? "direct", `${name} reach, ${sw}`).toBe("codemode");
        }
      } finally {
        await removeTempDir(dir);
      }
    }
  });

  test("loaded but not activated registers the PTC surfaces instead (ADR-0029)", async () => {
    // The cell that is the DEFAULT on a real 1.0.0 install, and the one that used to produce a
    // session holding `pi_task_codemode` with no orchestrator. Asserted here at the registration
    // rather than only on the resolved surface: a factory that stopped consulting the activation
    // probe would keep `detectedSurfaceMode` correct and still register the wrong tool set.
    const { stub, dir } = await makeStubInAgentDir({
      codemode: PRESENT,
      codemodeSwitch: { switch: "absent", source: "default" },
    });
    try {
      const names = [...stub.tools.keys()];
      expect(names).toContain("ptc_run_code");
      expect(names).toContain("ptc_workflow");
      expect(names).not.toContain("pi_task_codemode");
    } finally {
      await removeTempDir(dir);
    }
  });

  test("no codemode at all registers the PTC surfaces", async () => {
    const { stub, dir } = await makeStubInAgentDir({
      codemode: ABSENT,
      codemodeSwitch: { switch: "absent", source: "default" },
      codemodeActivation: ACTIVE,
    });
    try {
      // Naming a tool pi does not have cannot conjure it: a loadout that says `+codemode` on a pi
      // without one is a configuration with nothing to point at, not a surface change.
      expect([...stub.tools.keys()]).toContain("ptc_run_code");
      expect([...stub.tools.keys()]).not.toContain("pi_task_codemode");
    } finally {
      await removeTempDir(dir);
    }
  });
});

/**
 * pi 1.2.0 wraps the extensions pattern in normalizePath before matching
 * (dist/core/package-manager.js:483 and :498, helper at dist/utils/paths.js:59-83); 1.0.0
 * posixises the pattern directly. The rewrite turns a bare ~ into the home directory, a leading
 * ~/ into a path under it, and a file:// URL into its path.
 *
 * The measured drift surface is EMPTY, and the reason is worth pinning because the obvious model
 * of the match says otherwise. pi matches a built-in extension on the LITERAL string
 * builtin:codemode (BUILTIN_PATH_PREFIX + name, source-info.js:2, applied at
 * package-manager.js:741-742), with baseDir = agentDir (USER) or join(cwd, CONFIG_DIR_NAME)
 * (PROJECT) - so the three minimatch axes are a ..-prefixed relative path and the literal twice.
 * Every rewrite produces an ABSOLUTE path, and an absolute pattern matches neither a relative
 * path nor that literal. An earlier probe modelled the entry as extensions/codemode/index.js
 * under agentDir and reported two flipping shapes (!~/.pi/** and the fully-spelled extension
 * path); that model was wrong about pi, and re-probing the real axes with 20 tilde shapes across
 * both buckets drifts in zero of them.
 *
 * These tests therefore pin the INVARIANCE, not a change: every tilde and file-URL shape keeps
 * 1.0.0's answer under the 1.2.0 matcher. They exist so that a future pi which matches a built-in
 * on a path under agentDir - the one change that would make the rewrite observable - turns them
 * red here and in tests/unit/codemode-switch-differential.test.ts rather than silently shifting
 * the detected surface.
 *
 * ## What these tests are NOT, stated here because round 1 measured the difference
 *
 * They cannot tell "the tilde rewrite ran" from "the tilde rewrite was deleted", and the three
 * shapes below are not evidence that it ran. Measured: deleting BOTH tilde branches of
 * `normalizePatternPath` leaves every test in this block green. `switch === "absent"` is the
 * right answer either way, so these are characterization of an invariant (constraint #6), and they
 * are labelled as such — which is why the rewrite itself is pinned directly, against pi, in the
 * `normalizePatternPath` block below.
 */
describe("tildes cannot move the answer: the invariant, characterized (pi 1.2.0)", () => {
  // Every shape pi's normalizePath rewrites, plus the ones it must not touch. Each expectation is
  // shared by 1.0.0 and 1.2.0 - that is the claim, and it is deliberately NOT that the rewrite
  // is exercised (see the header above).
  test("no tilde shape reaches the USER bucket's !-glob against the codemode entry", () => {
    // The probe's full tilde family: bare ~, ~/*, ~*, the agent-dir shapes a user would write to
    // exclude their own pi config, and the fully-spelled extension path. All expand to absolute
    // paths; none can name the literal the entry is matched on.
    for (const pattern of [
      "~",
      "~/*",
      "~*",
      "~/skills/pdf",
      "~/.pi",
      "~/.pi/",
      "~/.pi/*",
      "~/.pi/**",
      "~/.pi/agent/*",
      "~/.pi/agent/**",
      "~/.pi/agent/extensions/codemode/index.js",
      "~/.pi/agent/extensions/codemode/**",
      "~/**",
      "~user",
    ]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: ["!" + pattern] }).switch,
        "pattern: " + pattern,
      ).toBe("absent");
    }
  });

  test("no tilde shape reaches the PROJECT bucket either", () => {
    // Same family against the project array. The base dir is <cwd>/.pi here, so a home-directory
    // expansion is even further from the entry than on the USER axis.
    for (const pattern of ["~/.pi/**", "~/.pi/agent/**", "~/extensions/codemode/index.js", "~/*"]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], { extensions: ["!" + pattern] }, undefined).switch,
        "pattern: " + pattern,
      ).toBe("absent");
    }
  });

  test("the forms normalizePath must NOT rewrite keep their literal meaning", () => {
    // The guard on the other side: ~user and ~* are not tilde-home rewrites (pi only rewrites a
    // bare "~" or a leading "~/"), so a copy that over-expanded would start treating them as
    // paths under the home directory and could match a relative axis it must not.
    //
    // NOT a counterfactual for the tilde branches, and it does not become one by being written
    // here: the expected answer is `absent` for the same reason in every case above, so a build
    // that expanded `~user` would still pass this. Round 1 measured that. What DOES distinguish an
    // over-expanding copy is in the `normalizePatternPath` block below ("the forms pi does NOT
    // rewrite pass through untouched"), which compares the rewritten string itself.
    for (const pattern of ["~user/.pi/**", "~*/**"]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: ["!" + pattern] }).switch,
        "pattern: " + pattern,
      ).toBe("absent");
    }
  });

  test("a malformed file:// URL throws, exactly as pi 1.2.0 does", () => {
    // The ONE shape in this block that is a real counterfactual for the rewrite, and the reason
    // the finding that produced this block did not flag it: removing the `file://` branch turns
    // this red, because a throw cannot be reached by any other path here. The two tilde branches
    // have no such witness on this input surface.
    // Measured against pi 1.2.0's real resolver (DefaultPackageManager.resolve with a settings
    // stub): "extensions": ["!file://~/x"] makes pi throw
    // TypeError: File URL host must be "localhost" or empty on darwin
    // because fileURLToPath refuses a non-empty non-localhost host, and "~" is not a host. The
    // mirror inherits the same throw through the same helper, which is the faithful answer: a
    // hand-edited settings file this malformed breaks pi itself, and this package must not
    // answer a question pi never got to ask. (The repo already records one such deliberate
    // divergence in the other direction - extensions: [42] throws in pi and resolves here - and
    // that one was chosen because pi never starts; here pi DOES start and dies, and there is no
    // session left for a softer answer to matter to.)
    expect(() =>
      resolveCodemodeSwitch(["node", "pi"], undefined, {
        extensions: ["!file://~/.pi/agent/extensions/codemode/index.js"],
      }),
    ).toThrow(/File URL host/);
  });

  test("the + and - buckets stay exact: a tilde path is never equal to the entry literal", () => {
    // matchesAnyExactPattern compares STRINGS after normalisation, so an expanded tilde path is
    // never equal to "builtin:codemode". This is why the rewrite can be adopted unconditionally:
    // the exact buckets' answers cannot move, and the glob buckets' cannot either (above).
    //
    // This one is worth naming explicitly, because the word "exact" invites the same misreading
    // the tilde tests invited: the assertion is that the string comparison does not land, NOT that
    // an expansion happened before it. Deleting the tilde branch keeps this green — the pattern is
    // then unexpanded and STILL unequal to the literal. The expansion is pinned in the block below.
    for (const pattern of ["~/.pi/agent/extensions/codemode/index.js"]) {
      expect(
        resolveCodemodeSwitch(["node", "pi"], undefined, {
          extensions: ["+" + pattern, "-" + pattern],
        }).switch,
        "pattern: " + pattern,
      ).toBe("absent");
    }
  });

  test("a plain !builtin:codemode still disables through the !-glob bucket, before and after", () => {
    // The one !-bucket shape that DOES match - a literal, no tilde - so the bucket is proven
    // live. Without this, the four invariance tests above would also pass on a copy that dropped
    // the !-glob bucket entirely.
    expect(
      resolveCodemodeSwitch(["node", "pi"], undefined, { extensions: ["!builtin:codemode"] }),
    ).toEqual({ switch: "disabled", source: "user" });
  });
});

/**
 * `normalizePatternPath` itself, differentially checked against pi's own `normalizePath`.
 *
 * ## Why this block exists at all (review round 1, finding X3)
 *
 * The four tests above reach `normalizePatternPath` only through `resolveCodemodeSwitch`, and
 * every one of them asserts `switch === "absent"`. That is the CORRECT answer with or without the
 * tilde rewrite — pi matches a built-in on the literal `builtin:codemode`, which no tilde or
 * `file://` expansion can name (the measurement is in the section comment of
 * `src/mode/ptc-mode.ts`, and the "no tilde shape" probe above is its in-repo reproduction). So
 * those tests CANNOT distinguish "the rewrite ran" from "the rewrite was deleted": cutting BOTH the
 * `~` and the `~/` branches left all 39 of them green. They are genuine characterization tests of an
 * invariant — pi's answer does not move — and they are kept for that, but on their own they were
 * the reason three branches of production code had no coverage at all.
 *
 * This block closes that gap by testing the rewrite where it is WRITTEN. `normalizePatternPath`
 * is exported for exactly this purpose, and the oracle is pi's real `normalizePath` from the
 * installed `@earendil-works/pi-coding-agent`, reached by absolute path because it is an internal
 * module outside the package's `exports` map.
 *
 * WHY THE RATIONALE LIVES HERE AND NOT ONLY IN THE SECTION COMMENT ABOVE THE FUNCTION: this block
 * is the test that proves the rewrite runs, so it is also where a reader learns the rewrite was
 * previously untested. Adding prose above `detectedSurfaceMode` in `src/mode/ptc-mode.ts` moves
 * it, and `docs/adr/0029:29` plus the `tests/doc-integrity.test.ts` ledger pin its line number and
 * assert that line holds `export function detectedSurfaceMode(`. Measured this round: a 7-line
 * comment addition moved the pin from 1127 to 1134 and turned the gate red until ADR-0029 and the
 * ledger were re-pointed. So comment length in that region is coupled to a doc gate, and the net
 * offset must be re-verified whenever it changes. */
describe("normalizePatternPath is pi's own normalizePath, narrowed (pi 1.2.0)", () => {
  /** pi's expansion target, read from the same `homedir()` the implementation reads. */
  const HOME = homedir();

  test("a bare ~ becomes the home directory", () => {
    expect(normalizePatternPath("~")).toBe(HOME);
  });

  test("a leading ~/ becomes a path under the home directory", () => {
    expect(normalizePatternPath("~/")).toBe(HOME);
    expect(normalizePatternPath("~/foo")).toBe(join(HOME, "foo"));
    // The shape a user would actually write to exclude their own pi config.
    expect(normalizePatternPath("~/.pi/agent/**")).toBe(join(HOME, ".pi", "agent", "**"));
    // `join` normalises the `..`, exactly as pi's own `join` does.
    expect(normalizePatternPath("~/a/../b")).toBe(join(HOME, "b"));
  });

  test("a file:// URL becomes its path", () => {
    expect(normalizePatternPath("file:///a/b")).toBe("/a/b");
    // A well-formed URL with a localhost host is still a path.
    expect(normalizePatternPath("file://localhost/a/b")).toBe("/a/b");
  });

  test("the forms pi does NOT rewrite pass through untouched", () => {
    // `~user` and `~*` are not tilde-home rewrites: pi only expands a bare `~` or a leading `~/`.
    // A copy that over-expanded would turn these into paths under HOME.
    expect(normalizePatternPath("~user/x")).toBe("~user/x");
    expect(normalizePatternPath("~*/**")).toBe("~*/**");
    expect(normalizePatternPath("plain/path")).toBe("plain/path");
    // A bare `~` NOT at the start is not expanded either.
    expect(normalizePatternPath("./~/.pi")).toBe("./~/.pi");
  });

  test("a malformed file:// URL throws, as pi's fileURLToPath does", () => {
    // `~` is not a valid URL host, so `file://~/x` is malformed and fileURLToPath refuses it.
    // The throw is inherited on purpose (see the section comment in src/mode/ptc-mode.ts).
    expect(() => normalizePatternPath("file://~/x")).toThrow(/File URL host/);
  });

  test.skipIf(PI_NORMALIZE_PATH === undefined)(
    "every rewrite agrees with the installed pi's own normalizePath, case for case",
    () => {
      const piNormalize = PI_NORMALIZE_PATH;
      if (piNormalize === undefined) throw new Error("unreachable: guarded by test.skipIf");
      // The full tilde family from the invariance tests above, plus the file-URL and no-rewrite
      // forms. Each one is compared against pi, so this is a differential oracle (constraint #4
      // source: the real implementation), not a restatement of ours.
      const shapes = [
        "~",
        "~/",
        "~/foo",
        "~/.pi",
        "~/.pi/",
        "~/.pi/*",
        "~/.pi/**",
        "~/.pi/agent/*",
        "~/.pi/agent/**",
        "~/.pi/agent/extensions/codemode/index.js",
        "~/*",
        "~/**",
        "~*",
        "~user",
        "~user/.pi/**",
        "~*/**",
        "~/a b/c",
        "~/a/../b",
        "~/./x",
        "./~/.pi",
        "plain/path",
        "file:///a/b",
        "file://localhost/a/b",
      ];
      const divergences: string[] = [];
      for (const shape of shapes) {
        let ours: string;
        try {
          ours = normalizePatternPath(shape);
        } catch {
          // A shape pi also rejects is agreement, not a divergence.
          try {
            piNormalize(shape);
            divergences.push(JSON.stringify(shape) + ": we threw, pi did not");
          } catch {
            continue;
          }
          continue;
        }
        const theirs = piNormalize(shape);
        if (ours !== theirs) {
          divergences.push(
            JSON.stringify(shape) +
              ": ours=" +
              JSON.stringify(ours) +
              " pi=" +
              JSON.stringify(theirs),
          );
        }
      }
      expect(divergences, "every shape above must rewrite the way pi rewrites it").toEqual([]);
    },
  );

  test.skipIf(PI_NORMALIZE_PATH === undefined)(
    "the table above still describes pi: each local expectation is re-measured",
    () => {
      // Guards the oracle in the other direction. If pi's rewrite ever changes, the hard-coded
      // expectations in the tests above are re-measured here rather than left to drift — the same
      // "is the table still true?" guard codemode-switch-differential.test.ts runs for its table.
      const piNormalize = PI_NORMALIZE_PATH;
      if (piNormalize === undefined) throw new Error("unreachable: guarded by test.skipIf");
      const stale: string[] = [];
      for (const shape of ["~", "~/", "~/foo", "~/.pi/agent/**", "~/a/../b"]) {
        if (piNormalize(shape) !== normalizePatternPath(shape)) {
          stale.push(JSON.stringify(shape) + ": pi now says " + JSON.stringify(piNormalize(shape)));
        }
      }
      expect(stale, "re-measure these against the installed pi and update the table").toEqual([]);
    },
  );
});

describe("probeCodemodePresence is unchanged by this feature", () => {
  test("it still answers a filesystem question, not a settings one", () => {
    // Guards the split: if someone folds the switch back into the probe, this is the test that
    // notices the probe grew a second responsibility.
    expect(probeCodemodePresence(["node", ""])).toEqual({ present: false, how: "no-entry" });
  });
});
