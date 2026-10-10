/**
 * ADR-0027 — the codemode SWITCH, as distinct from the codemode PROBE.
 *
 * The probe asks "is the directory on disk". The switch asks "will pi load it". pi 0.99.0 added
 * `-builtin:<name>`, which made those two different questions with different answers, and the
 * first version of this feature conflated them: a user who disabled pi's codemode kept getting
 * `subagents` surface and therefore no `ptc_run_code`, with nothing to orchestrate in its place.
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
  probeCodemodePresence,
  readCodemodeSwitch,
  resolveCodemodeSwitch,
} from "../../src/mode/ptc-mode.ts";
import type { CodemodePresence, CodemodeSwitch } from "../../src/mode/ptc-mode.ts";
import { makeStubInAgentDir, makeTempDir, removeTempDir } from "../helpers/ptc.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRESENT: CodemodePresence = { present: true, how: "found" };
const ABSENT: CodemodePresence = { present: false, how: "not-found" };
/** ADR-0029's third axis, stated here because the switch is not enough on its own to reach `subagents`. */
const ACTIVE = { activation: "active", source: "default" } as const;

/**
 * The SWITCH axis of the table, asserted as a table rather than case by case.
 *
 * ADR-0029 added a third axis, so every cell here states the activation too. It is `active`
 * throughout because this file is about the switch: the cell where a loaded codemode is not
 * callable belongs to the activation table, and pinning it here would make these assertions about
 * a column they do not vary.
 */
const TABLE: ReadonlyArray<readonly [CodemodePresence, CodemodeSwitch, string]> = [
  [PRESENT, "absent", "subagents"],
  [PRESENT, "enabled", "subagents"],
  [PRESENT, "disabled", "full"],
  [ABSENT, "absent", "full"],
  [ABSENT, "enabled", "full"],
  [ABSENT, "disabled", "full"],
];

describe("ADR-0027 codemode switch", () => {
  test("the switch axis of the table, each cell asserted on its own", () => {
    const actual = TABLE.map(
      ([presence, sw]) =>
        `${presence.present ? "on-disk" : "absent"}/${sw}=>${detectedSurfaceMode(presence, sw, "active")}`,
    );
    expect(actual).toEqual([
      "on-disk/absent=>subagents",
      "on-disk/enabled=>subagents",
      "on-disk/disabled=>full",
      "absent/absent=>full",
      "absent/enabled=>full",
      "absent/disabled=>full",
    ]);
  });

  test("disabling codemode is the only SWITCH value that turns a present codemode into full", () => {
    // The counterfactual this whole feature exists for: with `disabled` dropped, a user who
    // turned codemode off would silently keep losing ptc_run_code.
    //
    // "only switch value", not "only value": ADR-0029 added a second way to reach `full` for a
    // present codemode -- an inactive one -- and claiming otherwise here would be a title that
    // has quietly stopped being true.
    const withoutDisabled = TABLE.filter(([, sw]) => sw !== "disabled").map(([presence, sw]) =>
      detectedSurfaceMode(presence, sw, "active"),
    );
    expect(new Set(withoutDisabled)).toEqual(new Set(["subagents", "full"]));
    expect(detectedSurfaceMode(PRESENT, "disabled", "active")).toBe("full");
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
    // "a probe that cannot answer must not be allowed to answer yes" — `subagents` as a failure
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
  test("a user settings file that disables codemode answers `full` with no key to disagree with", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ extensions: ["-builtin:codemode"] }),
      );
      // `detectSurfaceMode` returns all four fields and nothing else: there is no `source` and no
      // `detected`, because nothing can override the answer and so nothing needs reporting as
      // overridden. `toEqual` on the whole object is what pins the absence.
      expect(detectSurfaceMode(root, PRESENT, undefined, ACTIVE, root)).toEqual({
        surfaceMode: "full",
        codemode: PRESENT,
        codemodeSwitch: { switch: "disabled", source: "user" },
        codemodeActivation: ACTIVE,
      });
    } finally {
      await removeTempDir(root);
    }
  });

  test("the same agent dir with codemode enabled answers `subagents`", async () => {
    const root = await makeTempDir("pi-ptc-switch-");
    try {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ extensions: ["+builtin:codemode"] }),
      );
      expect(detectSurfaceMode(root, PRESENT, undefined, ACTIVE, root).surfaceMode).toBe(
        "subagents",
      );
    } finally {
      await removeTempDir(root);
    }
  });

  test("a `surfaceMode` key in ptc.json is not an input at all", async () => {
    // The direct counterfactual: a reader that still honoured the key would answer `subagents`
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
        expect(detectSurfaceMode(root, PRESENT, undefined, ACTIVE, root).surfaceMode, stale).toBe(
          "full",
        );
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
    // Activation is stated as `active` on purpose: with the switch disabled the answer is `full`
    // whatever the loadout says, so this cell stays `full` even when codemode IS callable. That
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
      expect(names).not.toContain("ptc_subagent");
    } finally {
      await removeTempDir(dir);
    }
  });

  test("codemode on disk and loaded registers only the subagent face", async () => {
    // ADR-0029: "loaded" is no longer enough. These cells also need codemode in the LOADOUT, and
    // that axis is now STATED rather than written into a settings file the stub would not read —
    // `makeExtensionStub` always supplies `codemodeActivation`, so a `defaultTools` entry in the
    // agent dir resolves to nothing here and would leave this passing for the wrong reason if it
    // were left implicit.
    for (const sw of ["absent", "enabled"] as const) {
      const { stub, dir } = await makeStubInAgentDir({
        codemode: PRESENT,
        codemodeSwitch: { switch: sw, source: "default" },
        codemodeActivation: ACTIVE,
      });
      try {
        const names = [...stub.tools.keys()];
        expect(names, sw).toContain("ptc_subagent");
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
    // session holding `ptc_subagent` with no orchestrator. Asserted here at the registration
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
      expect(names).not.toContain("ptc_subagent");
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
      expect([...stub.tools.keys()]).not.toContain("ptc_subagent");
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("probeCodemodePresence is unchanged by this feature", () => {
  test("it still answers a filesystem question, not a settings one", () => {
    // Guards the split: if someone folds the switch back into the probe, this is the test that
    // notices the probe grew a second responsibility.
    expect(probeCodemodePresence(["node", ""])).toEqual({ present: false, how: "no-entry" });
  });
});
