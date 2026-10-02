/**
 * ADR-0030 — `/ptc surface`, the runtime half of the surface setting.
 *
 * The surface is read once, in the extension factory, and pi has no `unregisterTool`, so a change
 * cannot apply to a running session. The one thing that DOES re-run every factory is a reload
 * (`DefaultResourceLoader.reload()` → `clearExtensionCache()`, then re-resolve and re-load), which
 * is also what pi's own `/reload` does. This file pins the two halves of that: the write, which
 * must never damage the file it is editing, and the command, which must reload rather than leave
 * the user to discover that nothing happened.
 */
import { describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setSurfaceMode, SURFACE_MODES } from "../../src/mode/ptc-mode.ts";
import { makeExtensionStub, makeTempDir, removeTempDir, stubContext } from "../helpers/ptc.ts";

const FILE = "ptc.json";

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

const readConfig = async (dir: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dir, FILE), "utf8"));

describe("setSurfaceMode", () => {
  test("every value in the set is accepted, and the file it writes reads back as that value", async () => {
    // The literal set, not the constant: a value dropped from SURFACE_MODES has to turn this red
    // rather than follow the constant that is under test.
    for (const value of ["off", "subagents", "full"] as const) {
      await withAgentDir(async (dir) => {
        const written = setSurfaceMode(dir, value);
        expect(written.ok, value).toBe(true);
        if (!written.ok) return;
        expect(written.changed, value).toBe(true);
        expect(written.previous, value + ": nothing was there before").toBeUndefined();
        expect(await readConfig(dir), value).toEqual({ surfaceMode: value });
      });
    }
    expect([...SURFACE_MODES]).toEqual(["off", "subagents", "full"]);
  });

  test("the other key in the file survives", async () => {
    // `defaultMode` is ADR-0010's key and lives in the same file. A writer that emitted
    // `{"surfaceMode": …}` wholesale would silently reset the user's mode preference, and nothing
    // else in the suite would notice.
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, FILE), JSON.stringify({ defaultMode: false }), "utf8");
      const written = setSurfaceMode(dir, "full");
      expect(written.ok).toBe(true);
      expect(await readConfig(dir)).toEqual({ defaultMode: false, surfaceMode: "full" });
    });
  });

  test("the previous value is reported, so the command can say what it replaced", async () => {
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, FILE), JSON.stringify({ surfaceMode: "off" }), "utf8");
      const written = setSurfaceMode(dir, "subagents");
      expect(written.ok && written.previous).toBe("off");
    });
  });

  test("setting the value that is already there writes nothing at all", async () => {
    // The consequence that matters is on the command side — no write means no reload, and a reload
    // replaces every extension instance in the session for nothing. Asserted here as content
    // equality so the "did it rewrite" question has an answer that is not `changed`.
    await withAgentDir(async (dir) => {
      const original = JSON.stringify({ defaultMode: true, surfaceMode: "full" }, null, 2) + "\n";
      await writeFile(join(dir, FILE), original, "utf8");
      const written = setSurfaceMode(dir, "full");
      expect(written.ok && written.changed).toBe(false);
      expect(written.ok && written.previous).toBe("full");
      expect(await readFile(join(dir, FILE), "utf8")).toBe(original);
    });
  });

  test("a malformed file is reported and left byte-for-byte alone", async () => {
    // The failure this most easily gets wrong: a rewrite here would replace a file the user may be
    // mid-edit on with a valid document that dropped whatever was in it, and the loss would be
    // invisible. Both the reason and the fact of preservation are asserted.
    for (const [body, expected] of [
      ["{ not json", "not valid JSON"],
      ["[]", "JSON object"],
      ["null", "JSON object"],
      ['"subagents"', "JSON object"],
      ["3", "JSON object"],
    ] as const) {
      await withAgentDir(async (dir) => {
        await writeFile(join(dir, FILE), body, "utf8");
        const written = setSurfaceMode(dir, "full");
        expect(written.ok, body).toBe(false);
        if (written.ok) return;
        expect(written.error, body).toContain(expected);
        expect(written.error, body).toContain("left alone");
        expect(await readFile(join(dir, FILE), "utf8"), body).toBe(body);
      });
    }
  });

  test("a value outside the set is refused, and names the set", async () => {
    for (const bad of [7, null, "FULL", "sub-agent", "detect", ""]) {
      await withAgentDir(async (dir) => {
        const written = setSurfaceMode(dir, bad);
        expect(written.ok, JSON.stringify(bad)).toBe(false);
        if (written.ok) return;
        expect(written.error).toContain("off | subagents | full");
        // And nothing was created on the way to refusing.
        await expect(readFile(join(dir, FILE), "utf8")).rejects.toThrow();
      });
    }
  });

  test("a value already in the file that is not in the set is still replaced, not refused", async () => {
    // A hand-edited `surfaceMode: "detect"` is read as invalid by the READER (which falls back to
    // the detected default and says so), so the writer replacing it is the repair, not the damage.
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, FILE), JSON.stringify({ surfaceMode: "detect" }), "utf8");
      const written = setSurfaceMode(dir, "full");
      expect(written.ok && written.changed).toBe(true);
      expect(await readConfig(dir)).toEqual({ surfaceMode: "full" });
    });
  });
});

describe("/ptc surface", () => {
  async function run(_dir: string, args: string): Promise<ReturnType<typeof makeExtensionStub>> {
    const stub = makeExtensionStub({ surfaceMode: "from-file" });
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    const command = stub.commands.get("ptc");
    expect(command, "the /ptc command is registered").toBeDefined();
    if (command === undefined) throw new Error("unreachable");
    await command.handler(args, stubContext(stub, { mode: "tui" }));
    return stub;
  }

  test("with no value it reports the surface and its source, and does not reload", async () => {
    await withAgentDir(async (dir) => {
      // `full`, not `off`: an `off` surface returns from the factory before the command is
      // registered (there is nothing to toggle and nothing to say), so `/ptc surface` cannot be
      // the way back out of it. That asymmetry is deliberate and ADR-0025's, and it is why this
      // test cannot use the value it is reporting on.
      await writeFile(join(dir, FILE), JSON.stringify({ surfaceMode: "full" }), "utf8");
      const stub = await run(dir, "surface");
      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said).toContain('"full"');
      expect(said).toContain("from file");
      expect(stub.reloads, "a report must not reload").toEqual([]);
    });
  });

  test("setting a value writes it and reloads, and says so BEFORE reloading", async () => {
    // The order is the assertion. `ctx.reload()` invalidates this command context
    // (`runner.js:482`), so a notification emitted after it is stale by contract — the message
    // would be delivered by a torn-down UI channel, or not at all.
    await withAgentDir(async (dir) => {
      const stub = await run(dir, "surface full");
      expect(await readConfig(dir)).toEqual({ surfaceMode: "full" });
      expect(stub.reloads, "exactly one reload").toHaveLength(1);
      expect(stub.reloads[0], "the notice was already raised when the reload happened").toBe(
        stub.notifications.length,
      );
      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said).toContain("ptc.json");
      expect(said).toContain('"full"');
    });
  });

  test("a value outside the set warns, changes nothing, and does not reload", async () => {
    await withAgentDir(async (dir) => {
      const stub = await run(dir, "surface nonsense");
      const last = stub.notifications.at(-1);
      expect(last?.type, "an unusable value is a warning, not a note").toBe("warning");
      expect(last?.message).toContain("off | subagents | full");
      expect(last?.message).toContain("Nothing was changed");
      expect(stub.reloads, "a refused write must not reload").toEqual([]);
      await expect(readFile(join(dir, FILE), "utf8")).rejects.toThrow();
    });
  });

  test("a malformed file warns and leaves it alone rather than replacing it", async () => {
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, FILE), "{ not json", "utf8");
      const stub = await run(dir, "surface full");
      const last = stub.notifications.at(-1);
      expect(last?.type).toBe("warning");
      expect(last?.message).toContain("not valid JSON");
      expect(stub.reloads).toEqual([]);
      expect(await readFile(join(dir, FILE), "utf8")).toBe("{ not json");
    });
  });

  test("setting the surface it already has reloads nothing", async () => {
    // A reload replaces every extension instance in the session. Doing that because the user
    // re-typed a value that was already set is a cost with no benefit, and it drops in-flight
    // state that the user did not ask to lose.
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, FILE), JSON.stringify({ surfaceMode: "full" }), "utf8");
      const stub = await run(dir, "surface full");
      expect(stub.reloads, "no change means no reload").toEqual([]);
      expect(stub.notifications.at(-1)?.message).toContain("already");
    });
  });

  test("switching away from full says that a running PTC mode cannot survive it", async () => {
    // Not a hypothetical: `decideModeEntry` policy 3 refuses to enter without ptc_run_code or
    // ptc_workflow, so a `subagents` or `off` surface ends the mode on the next session_start.
    // The user asked for a surface, not for their mode to stop, so the coupling is stated.
    await withAgentDir(async () => {
      const stub = makeExtensionStub({ surfaceMode: "from-file" });
      const enter = stub.commands.get("ptc");
      expect(enter).toBeDefined();
      if (enter === undefined) throw new Error("unreachable");
      await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
      const on = stub.commands.get("ptc");
      if (on === undefined) throw new Error("unreachable");
      await on.handler("on", stubContext(stub, { mode: "tui" }));
      stub.notifications.length = 0;

      await on.handler("surface subagents", stubContext(stub, { mode: "tui" }));
      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said).toContain("PTC mode was ON");
      expect(said).toContain("/ptc on");
      expect(said, "and it says what subagents needs").toContain("codemode");
    });
  });

  test("the existing subcommands still work, so this is an addition and not a replacement", async () => {
    await withAgentDir(async (dir) => {
      const stub = await run(dir, "");
      const said = stub.notifications.at(-1)?.message ?? "";
      expect(said, "no argument is still the mode report").toContain("PTC mode is");
    });
  });
});
