/**
 * ADR-0029 — the codemode ACTIVATION probe.
 *
 * pi registers `codemode` with `defaultActive: false`, so "pi ships it" and "pi loads it" are both
 * true on an ordinary session that configured nothing, and neither means the model can call it.
 * This file pins how the third question is answered.
 *
 * **The answer is read from pi, not reconstructed from its files.** That used to be the other way
 * round, and the difference was not tidiness. Reading `<cwd>/.pi/settings.json` off disk could not
 * know whether pi had been told to trust the project, so a project that pi declined to read could
 * still put this package on a surface whose orchestration tools nothing could reach — which is
 * #131. The probe now takes pi's own active tool set, which pi has already filtered.
 *
 * The fixture rule below is the one that matters for a probe whose input is a list: the candidate
 * lists differ in exactly one entry, so an implementation that answered from anything other than
 * the list it was handed — from a file, from a default, from "was anything configured" — turns
 * red rather than agreeing by luck.
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

/** pi's default active tool names (`settings-manager.js:35`). None of them is `codemode`. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;
const ACTIVE_CODEMODE = [...DEFAULT_TOOLS, CODEMODE_TOOL_NAME];

describe("resolveCodemodeActivation reads pi's loadout", () => {
  test("a loadout that names codemode is active, and one that does not is not", () => {
    // The two lists differ in exactly one entry, and the answer differs with it. An implementation
    // that returned a constant, or consulted anything but the argument, passes one and fails the
    // other — so this pair is the counterfactual for the whole probe.
    expect(resolveCodemodeActivation(ACTIVE_CODEMODE)).toEqual({
      activation: "active",
      source: "loadout",
    });
    expect(resolveCodemodeActivation([...DEFAULT_TOOLS])).toEqual({
      activation: "inactive",
      source: "loadout",
    });
  });

  test("an empty loadout is inactive rather than an error", () => {
    // pi can report nothing active — `--no-tools` with no allowlist empties the list — and "the
    // model can call nothing" is a fact this probe can report, not a failure of the probe.
    expect(resolveCodemodeActivation([])).toEqual({
      activation: "inactive",
      source: "loadout",
    });
  });

  test("absence is not a default this probe invents", () => {
    // pi registers `codemode` inactive, so a session that configured nothing does not have it and
    // the answer is `inactive`. This is the cell that is the default on a real install, and it is
    // the one that must not be guessed the other way: guessing it up hands the model a surface
    // whose tools it cannot call.
    expect(resolveCodemodeActivation([...DEFAULT_TOOLS]).activation).toBe("inactive");
    expect(resolveCodemodeActivation(ACTIVE_CODEMODE).activation).toBe("active");
  });

  test("the probe asks about the same name the host registers", () => {
    // A probe pointed at the wrong string is inert: every case above would still pass while the
    // real `codemode` went unnamed.
    expect(CODEMODE_TOOL_NAME).toBe("codemode");
  });
});

describe("readCodemodeActivation does not read settings files", () => {
  test("a project settings file naming codemode does not activate it (#131)", async () => {
    // THE counterfactual for this change. pi applies project trust before it hands over its
    // loadout, so a `defaultTools` this package can see on disk is not evidence of anything: pi
    // may have declined to read that project entirely. An implementation that re-read the file
    // here would report `active` for a project whose settings pi ignored, and the surface would be
    // `subagents` with orchestration tools nothing can reach.
    const agentDir = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ defaultTools: ["+codemode"] }),
        "utf8",
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultTools: ["+codemode"] }),
        "utf8",
      );
      // Both files say `+codemode`; the loadout pi reported says otherwise. The loadout wins,
      // because it is the one that was already filtered.
      expect(readCodemodeActivation(agentDir, cwd, [...DEFAULT_TOOLS])).toEqual({
        activation: "inactive",
        source: "loadout",
      });
      // And when the loadout agrees, the answer is active — so the file above is not what decided
      // it, and a probe that ignored its argument entirely would still fail the case above.
      expect(readCodemodeActivation(agentDir, cwd, ACTIVE_CODEMODE)).toEqual({
        activation: "active",
        source: "loadout",
      });
    } finally {
      await removeTempDir(cwd);
      await removeTempDir(agentDir);
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
});
