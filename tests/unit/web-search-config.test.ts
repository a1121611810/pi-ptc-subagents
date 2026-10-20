/**
 * The `webDsSearch` key: the DeepSeek search module's switch and quota (ADR-0048).
 *
 * **The switch is off unless the file says otherwise**, and that is the direction worth
 * pinning: the capability has a network egress and a per-call bill, so the absence of a
 * decision must not be read as a decision to allow it. The quota is the one number here that
 * fails OPEN to its default, because a quota that silently dropped to zero would be
 * UNLIMITED — the opposite of what a broken number should do.
 *
 * Every invalid case below therefore asserts BOTH halves: the error is reported AND the safe
 * value is kept. A test that only checked the error would pass against an implementation that
 * warned and then did the dangerous thing, which is the shape this file exists to rule out.
 *
 * The file's own parse failure is NOT this reader's to report: `readDefaultModeConfig` owns it
 * and announces it at `session_start`, and a second copy of the same sentence for one broken
 * file trains the user to ignore the notice that matters.
 */
import { describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SEARCH_MAX_CALLS_PER_SESSION,
  readWebSearchConfig,
} from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/**
 * Named as a literal rather than imported from the module, so a change to the module's own
 * constant cannot quietly move the file this test writes. Same reasoning as
 * `opt-in-bindings-config.test.ts`.
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

describe("readWebSearchConfig: the switch is off unless the file says otherwise", () => {
  test("no file at all leaves the capability off, and says so by source", async () => {
    const dir = await makeTempDir();
    try {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.maxCallsPerSession).toBe(DEFAULT_SEARCH_MAX_CALLS_PER_SESSION);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a file with no webDsSearch key leaves it off", async () => {
    await withPtcJson(JSON.stringify({ defaultMode: true }), (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("an enabled switch and a quota are read from the file", async () => {
    await withPtcJson(
      JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 7 } }),
      (dir) => {
        const config = readWebSearchConfig(dir);
        expect(config.enabled).toBe(true);
        expect(config.maxCallsPerSession).toBe(7);
        expect(config.source).toBe("file");
        expect(config.error).toBeUndefined();
      },
    );
  });

  test("an enabled switch with no quota keeps the default quota", async () => {
    await withPtcJson(JSON.stringify({ webDsSearch: { enabled: true } }), (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(true);
      expect(config.maxCallsPerSession).toBe(DEFAULT_SEARCH_MAX_CALLS_PER_SESSION);
      expect(config.source).toBe("file");
    });
  });

  test("a quota of zero means unlimited, and is not mistaken for 'unset'", async () => {
    await withPtcJson(
      JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 0 } }),
      (dir) => {
        const config = readWebSearchConfig(dir);
        expect(config.maxCallsPerSession).toBe(0);
        expect(config.source).toBe("file");
      },
    );
  });
});

describe("readWebSearchConfig: every broken KEY is reported AND the safe value is kept", () => {
  test("a non-boolean switch leaves the capability OFF", async () => {
    await withPtcJson(JSON.stringify({ webDsSearch: { enabled: "yes" } }), (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("invalid");
      expect(config.error).toContain("enabled");
    });
  });

  test("a non-object value leaves the capability OFF", async () => {
    await withPtcJson(JSON.stringify({ webDsSearch: true }), (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("invalid");
      expect(config.error).toContain("webDsSearch");
    });
  });

  test("an array value leaves the capability OFF", async () => {
    await withPtcJson(JSON.stringify({ webDsSearch: [] }), (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("invalid");
    });
  });

  test("a broken quota keeps the DEFAULT quota, never zero", async () => {
    // The dangerous direction: a quota that silently became 0 would be UNLIMITED.
    await withPtcJson(
      JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: -1 } }),
      (dir) => {
        const config = readWebSearchConfig(dir);
        expect(config.maxCallsPerSession).toBe(DEFAULT_SEARCH_MAX_CALLS_PER_SESSION);
        expect(config.source).toBe("invalid");
        expect(config.error).toContain("maxCallsPerSession");
      },
    );
  });

  test("a fractional quota is refused rather than rounded", async () => {
    await withPtcJson(
      JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 1.5 } }),
      (dir) => {
        const config = readWebSearchConfig(dir);
        expect(config.maxCallsPerSession).toBe(DEFAULT_SEARCH_MAX_CALLS_PER_SESSION);
        expect(config.source).toBe("invalid");
      },
    );
  });

  test("a broken switch and a broken quota are both reported, and both keep their safe value", async () => {
    await withPtcJson(
      JSON.stringify({ webDsSearch: { enabled: "yes", maxCallsPerSession: "lots" } }),
      (dir) => {
        const config = readWebSearchConfig(dir);
        expect(config.enabled).toBe(false);
        expect(config.maxCallsPerSession).toBe(DEFAULT_SEARCH_MAX_CALLS_PER_SESSION);
        expect(config.source).toBe("invalid");
        expect(config.error).toContain("enabled");
        expect(config.error).toContain("maxCallsPerSession");
      },
    );
  });
});

describe("readWebSearchConfig: a file too broken to parse is NOT this reader's to report", () => {
  test("unparseable JSON leaves the capability OFF and reports nothing", async () => {
    // `readDefaultModeConfig` owns the file's parse failure and announces it at session_start.
    // A second copy of the same sentence for one broken file trains the user to ignore the
    // notice that matters.
    await withPtcJson("{ this is not json", (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });

  test("a JSON file that is not an object leaves the capability OFF and reports nothing", async () => {
    await withPtcJson("[1, 2, 3]", (dir) => {
      const config = readWebSearchConfig(dir);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("default");
      expect(config.error).toBeUndefined();
    });
  });
});
