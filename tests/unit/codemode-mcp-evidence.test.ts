/**
 * ADR-0033 — MCP auto-enable evidence for the codemode ACTIVATION probe.
 *
 * pi's MCP extension activates `codemode` itself: MCP tools default to exposure `codemode`
 * (`dist/extensions/mcp/index.d.ts:9-14`), and `ensureDiscoveryActive` then calls
 * `pi.setActiveTools([...active, "codemode"])` for every session with an enabled
 * `codemode`-exposure server (`dist/extensions/mcp/index.js:352-389`). That call records itself
 * in no settings file, so the ADR-0029 loadout mirror answers `inactive` and the surface defaults
 * to `full` while codemode really is active — two orchestration surfaces in one request, the
 * defect ADR-0025 exists to remove.
 *
 * **This is a weaker guarantee than ADR-0027's switch oracle, and deliberately so**, for the same
 * reason ADR-0029's activation mirror is: `validateMcpServerConfig`, `loadMcpConfig` and
 * `ensureDiscoveryActive` are not exported, so there is nothing to drive differentially. Every
 * expectation below is a literal justified against the cited lines, and the reader is expected to
 * re-check those lines when pi moves.
 *
 * What makes the weaker guarantee sufficient is the failure asymmetry, and this evidence is built
 * to keep it one-sided: the server mirror is a strict SUBSET of pi's checks (the `oauth` /
 * `auth.provider` rules are deliberately not mirrored), so a disagreement can only ever claim
 * activation pi will not perform — which lands in the `subagents` surface with no orchestrator,
 * where the ADR-0025 decision-4 warning measures the real loadout and fires loudly. The direction
 * this ADR exists to close, under-reporting into a silent double surface, is not reachable.
 *
 * Connection success is deliberately NOT an input on either side: pi computes the activation "from
 * the config, so the tool is active before the servers connect" (`index.js:353-354`), which is
 * what makes a config mirror exact rather than approximate.
 */
import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodemodeActivationResolution,
  type McpConfigFileInput,
  applyMcpAutoEnableEvidence,
  detectedSurfaceMode,
  readCodemodeActivation,
  resolveCodemodeActivation,
  resolveMcpAutoEnableEvidence,
} from "../../src/mode/ptc-mode.ts";
import { makeTempDir, removeTempDir } from "../helpers/ptc.ts";

const PI = ["node", "pi"];
const GLOBAL_PATH = "/agent/mcp.json";
const PROJECT_PATH = "/project/.pi/mcp.json";

/** A file as the resolver takes it: raw content, or absent when `body` is undefined. */
function file(path: string, body: unknown): McpConfigFileInput {
  return { path, raw: body === undefined ? undefined : JSON.stringify(body) };
}

/** The evidence alone, so a test states only the half it is exercising. */
function evidence(
  global?: unknown,
  project?: unknown,
): ReturnType<typeof resolveMcpAutoEnableEvidence> {
  return resolveMcpAutoEnableEvidence(file(GLOBAL_PATH, global), file(PROJECT_PATH, project));
}

/** A stdio server — the shape `config.js:1-17` documents, and the only transport most users have. */
const stdioServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
};

/** A loadout-mirror answer to union the evidence onto. */
function loadout(
  overrides: Partial<CodemodeActivationResolution> = {},
): CodemodeActivationResolution {
  return { activation: "inactive", source: "default", ...overrides };
}

describe("the evidence matrix", () => {
  test("a server with no exposure key is the default case and auto-enables codemode", () => {
    // `exposureOf` returns `entry.config.exposure ?? "codemode"` (index.js:60-62), and
    // `configuredExposures` puts that plus the per-tool overrides in one set (:64-66); the
    // activation needs that set to contain "codemode" (:361). This is pi's DEFAULT config — no
    // `exposure` written at all — so it is the case an MCP user hits without trying.
    expect(evidence({ mcpServers: { fs: stdioServer } })).toEqual({ autoEnablesCodemode: true });
    expect(evidence({ mcpServers: { fs: stdioServer } }).autoEnablesCodemode).toBe(true);
  });

  test("an http server and a stdio server agree, because the transport is not the question", () => {
    // pi accepts either transport into the registry (`validateMcpServerConfig` :136-167); what the
    // evidence reads afterwards is exposure alone, so both shapes must resolve the same way.
    expect(evidence({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } })).toEqual({
      autoEnablesCodemode: true,
    });
    expect(evidence({ mcpServers: { fs: { command: "npx" } } })).toEqual({
      autoEnablesCodemode: true,
    });
  });

  test("a disabled server contributes nothing, exactly as in pi's isEnabled", () => {
    // `isEnabled` is `config.enabled !== false` (index.js:57-59) and `ensureDiscoveryActive` iterates
    // `if (isEnabled(server))` (:356-359). Counterfactual: drop the `enabled === false` skip and
    // this turns red, and with it the promise that a user who disabled every server gets no
    // delegation.
    expect(evidence({ mcpServers: { fs: { ...stdioServer, enabled: false } } })).toEqual({
      autoEnablesCodemode: false,
    });
  });

  test("autoEnableCodemode false is the user's way to keep codemode off, and it wins", () => {
    // The top-level key (default true, `config.js:23-24`) gates pi's own activation
    // (`index.js:371`). It must apply even with a codemode-exposure server present.
    expect(evidence({ autoEnableCodemode: false, mcpServers: { fs: stdioServer } })).toEqual({
      autoEnablesCodemode: false,
    });
  });

  test("servers that reach the model directly need no codemode", () => {
    // `needsCodemode` is false for a `direct` or `deferred` set (:355-362): direct tools are
    // declared to the model, and `deferred` activates `tool_search` instead (:374-375).
    for (const exposure of ["direct", "deferred", "hidden"]) {
      expect(
        evidence({ mcpServers: { fs: { ...stdioServer, exposure } } }),
        `${exposure} exposure does not auto-enable codemode`,
      ).toEqual({ autoEnablesCodemode: false });
    }
  });

  test("a per-tool codemode exposure counts, because configuredExposures unions both sources", () => {
    // `configuredExposures` = the server's own exposure UNION `toolExposure` values (:64-66), so
    // one overridden tool is enough for `needsCodemode` — a `deferred` server with a single
    // `codemode` tool still needs codemode reachable.
    expect(
      evidence({
        mcpServers: {
          fs: { ...stdioServer, exposure: "deferred", toolExposure: { read_file: "codemode" } },
        },
      }),
    ).toEqual({ autoEnablesCodemode: true });
  });

  test("the codemode-deferred alias resolves to codemode", () => {
    // pi rewrites this alias during validation (`mcp-servers.js:9`, `resolveExposureAliases` :74-82),
    // so an old config written before the rename still auto-enables.
    expect(
      evidence({ mcpServers: { fs: { ...stdioServer, exposure: "codemode-deferred" } } }),
    ).toEqual({
      autoEnablesCodemode: true,
    });
    expect(
      evidence({
        mcpServers: { fs: { ...stdioServer, toolExposure: { t: "codemode-deferred" } } },
      }),
    ).toEqual({
      autoEnablesCodemode: true,
    });
  });

  test("a server pi would drop contributes nothing, for each reason it drops one", () => {
    // Each of these is a `validateMcpServerConfig` return value, so pi never registers the server
    // and never reads an exposure from it (`config.js:56-59` skips the entry on an error string).
    // Naming the charset (`mcp-servers.js:18`), the transport requirement (:168) and the `sse`
    // rejection (:134-135) so the three are not one undifferentiated "invalid" case.
    const dropped: Record<string, unknown> = {
      "a name outside the charset": { "bad name!": stdioServer },
      "neither command nor url": { fs: { description: "no transport" } },
      "a url that is not http(s)": { fs: { url: "ftp://example.com/mcp" } },
      "a non-boolean enabled": { fs: { ...stdioServer, enabled: "yes" } },
      "an exposure outside the four": { fs: { ...stdioServer, exposure: "script" } },
      "a toolExposure outside the four": { fs: { ...stdioServer, toolExposure: { t: "always" } } },
      "legacy sse transport": { fs: { type: "sse", url: "https://example.com/mcp" } },
      "args that are not strings": { fs: { ...stdioServer, args: [1] } },
      "a non-positive timeout": { fs: { ...stdioServer, timeout: 0 } },
    };
    for (const [why, servers] of Object.entries(dropped)) {
      expect(evidence({ mcpServers: servers }), `${why} contributes no exposure`).toEqual({
        autoEnablesCodemode: false,
      });
    }
  });

  test("a project server replaces the global one of the same name", () => {
    // pi's `servers.set(name, …)` in read order — global then project (`config.js:79-81`, `:70`) —
    // so the project entry wins outright. Both directions are stated: the project can turn the
    // evidence OFF, and it can turn it back ON for a globally-deferred server.
    expect(
      evidence(
        { mcpServers: { docs: { ...stdioServer, exposure: "deferred" } } },
        { mcpServers: { docs: stdioServer } },
      ),
    ).toEqual({ autoEnablesCodemode: true });
    expect(
      evidence(
        { mcpServers: { docs: stdioServer } },
        { mcpServers: { docs: { ...stdioServer, exposure: "deferred" } } },
      ),
    ).toEqual({ autoEnablesCodemode: false });
  });

  test("a project autoEnableCodemode overrides the global one, in both directions", () => {
    // The last boolean read wins, which is what makes the project file the override
    // (`config.js:50-51`, project read second at `:81`).
    expect(
      evidence(
        { autoEnableCodemode: true, mcpServers: { fs: stdioServer } },
        { autoEnableCodemode: false },
      ),
    ).toEqual({ autoEnablesCodemode: false });
    expect(
      evidence(
        { autoEnableCodemode: false, mcpServers: { fs: stdioServer } },
        { autoEnableCodemode: true },
      ),
    ).toEqual({ autoEnablesCodemode: true });
  });

  test("a project name that would share a namespace with a global one is dropped", () => {
    // Names differing only in `-` / `_` share `mcp__<server>` (`mcpNamespace`, `mcp-servers.js:20-22`),
    // and pi drops the LATER server (`config.js:60-64`). The global `docs-x` here is
    // `deferred`-exposure, so honouring the project entry instead would turn the evidence ON — the
    // assertion is therefore red against a mirror that ignores the clash rule.
    expect(
      evidence(
        { mcpServers: { "docs-x": { ...stdioServer, exposure: "deferred" } } },
        { mcpServers: { docs_x: stdioServer } },
      ),
    ).toEqual({ autoEnablesCodemode: false });
  });

  test("an unreadable file is reported, and the other file still decides", () => {
    // pi pushes the parse error and skips the file (`config.js:39-44`), so the project's servers
    // are unaffected — a global file that will not parse must not zero out a real project
    // configuration. Counterfactual: return early from the resolver instead of folding per file,
    // and the project server below stops counting.
    const resolved = resolveMcpAutoEnableEvidence(
      { path: GLOBAL_PATH, raw: "{ not json" },
      file(PROJECT_PATH, { mcpServers: { fs: stdioServer } }),
    );
    expect(resolved.autoEnablesCodemode, "the project file still decides").toBe(true);
    expect(resolved.error, "and the broken file is named").toContain("not valid JSON");
    expect(resolved.error).toContain(GLOBAL_PATH);
  });

  test("when BOTH files are broken, the answer names both", () => {
    // pi keeps an `errors` ARRAY (`config.js:78`) and pushes one entry per failing file (`config.js:40-53`),
    // so two
    // broken files produce two reported problems; a single carried string with last-write-wins hid
    // one of them, and the user was told one of their files was fine. Spec #106 decision 3's "no
    // silent probe input" is a statement about BOTH inputs.
    //
    // Counterfactual: make `state.error` overwrite again and this goes red on the global path.
    const resolved = resolveMcpAutoEnableEvidence(
      { path: GLOBAL_PATH, raw: "{ bad global" },
      { path: PROJECT_PATH, raw: "{ bad project" },
    );
    expect(resolved.error, "the project file is reported").toContain(PROJECT_PATH);
    expect(resolved.error, "and so is the global file, which was being overwritten").toContain(
      GLOBAL_PATH,
    );
  });

  test("a non-object mcp.json is reported, not parsed", () => {
    // pi's shape check (`config.js:46-48`) is on the PARSED value: a top-level array, or
    // `mcpServers` that is not an object, contributes nothing and is named.
    for (const bad of [JSON.stringify([]), JSON.stringify({ mcpServers: 7 })]) {
      const resolved = resolveMcpAutoEnableEvidence(
        { path: GLOBAL_PATH, raw: bad },
        file(PROJECT_PATH, undefined),
      );
      expect(resolved.autoEnablesCodemode).toBe(false);
      expect(resolved.error).toContain(GLOBAL_PATH);
    }
  });

  test("a non-boolean autoEnableCodemode is reported, and pi's default still applies", () => {
    // pi pushes an error and leaves the state UNSET (`config.js:52-53`), so the value keeps pi's
    // default of true. A mirror that treated the bad value as false would silently drop codemode
    // for exactly the user whose file pi itself rejects loudly.
    const resolved = evidence({ autoEnableCodemode: "false", mcpServers: { fs: stdioServer } });
    expect(resolved.autoEnablesCodemode).toBe(true);
    expect(resolved.error).toContain("must be a boolean");
  });

  test("absent files are the normal case and produce no evidence and no error", () => {
    // pi's `existsSync` guard (`config.js:36-37`): a user with no MCP at all must resolve to
    // exactly `{ autoEnablesCodemode: false }`, with nothing to report.
    expect(evidence(undefined, undefined)).toEqual({ autoEnablesCodemode: false });
    expect(evidence({}, {})).toEqual({ autoEnablesCodemode: false });
  });
});

describe("the union with the loadout mirror", () => {
  test("inactive loadout plus MCP evidence is active, and the source names the evidence", () => {
    // pi's MCP extension appends `codemode` to whatever the loadout resolved
    // (`pi.setActiveTools([...active, ...activate])`, index.js:377-378), so the two sources union
    // rather than compete — including against a CLI allowlist that excluded codemode.
    expect(applyMcpAutoEnableEvidence(loadout(), { autoEnablesCodemode: true })).toEqual({
      activation: "active",
      source: "mcp",
    });
  });

  test("an active loadout keeps its own provenance, which names the file the user edited", () => {
    // `"mcp"` would point a notice at an mcp.json the user may not have touched; the loadout
    // answer is the configured one, so it stays the source reported.
    const configured = { activation: "active", source: "user" } as const;
    expect(applyMcpAutoEnableEvidence(configured, { autoEnablesCodemode: true })).toEqual(
      configured,
    );
  });

  test("no evidence leaves the loadout answer exactly as it was", () => {
    const inactive = loadout();
    expect(applyMcpAutoEnableEvidence(inactive, { autoEnablesCodemode: false })).toEqual(inactive);
  });

  test("a settings error on the incoming answer survives the union", () => {
    // The same argument the `mcpError` carry makes, applied to the OTHER error field: a broken
    // `settings.json` is a probe failure whatever the evidence says, and the `"mcp"` branch used to
    // build a fresh object and drop it. Latent rather than live — `resolveCodemodeActivation` never
    // sets `error` today — which is exactly why it needs a test: `readCodemodeActivation` re-derives
    // `error` afterwards and would mask a refactor that loses the signal.
    //
    // Counterfactual: return a literal `{ activation, source }` again and this goes red.
    const broken = "…/settings.json is not valid JSON (…)";
    expect(
      applyMcpAutoEnableEvidence(loadout({ error: broken }), { autoEnablesCodemode: true }),
    ).toEqual({
      activation: "active",
      source: "mcp",
      error: broken,
    });
  });

  test("an mcp.json we could not read is carried on the answer, whichever way it went", () => {
    // The file contributed nothing, and that has to be visible: without the carry, "codemode will
    // stay inactive" is indistinguishable from "we could not tell", and only one of those is a
    // decision. Counterfactual: drop `mcpError` from the two returns below and this goes red.
    expect(
      applyMcpAutoEnableEvidence(loadout(), {
        autoEnablesCodemode: false,
        error: `${GLOBAL_PATH} is not valid JSON`,
      }),
    ).toEqual({
      activation: "inactive",
      source: "default",
      mcpError: `${GLOBAL_PATH} is not valid JSON`,
    });
    expect(
      applyMcpAutoEnableEvidence(loadout(), {
        autoEnablesCodemode: true,
        error: `${GLOBAL_PATH} is not valid JSON`,
      }),
    ).toEqual({
      activation: "active",
      source: "mcp",
      mcpError: `${GLOBAL_PATH} is not valid JSON`,
    });
  });
});

describe("readCodemodeActivation over real files", () => {
  test("an agent-dir mcp.json resolves the activation, and the detected surface follows it", async () => {
    // The end-to-end claim of ADR-0033, on files rather than inputs: the same session that
    // resolved `full` before (ADR-0029's default cell) now resolves `subagents`, because the
    // mcp.json names a server whose tools are only reachable from codemode scripts. Without the
    // union, `detectedSurfaceMode` answers `full` and the two surfaces coexist.
    const agentDir = await makeTempDir();
    try {
      await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } } }),
        "utf8",
      );
      const resolved = readCodemodeActivation(agentDir, agentDir, PI);
      expect(resolved).toEqual({ activation: "active", source: "mcp" });
      expect(
        detectedSurfaceMode({ present: true, how: "found" }, "absent", resolved.activation),
        "the surface the session actually gets",
      ).toBe("subagents");
    } finally {
      await removeTempDir(agentDir);
    }
  });

  test("the project mcp.json is read from <cwd>/.pi, where pi looks for it", async () => {
    // `loadMcpConfig` reads `join(options.cwd, CONFIG_DIR_NAME, "mcp.json")` after the agent-dir
    // file (`config.js:79-81`). The path matters: a mirror that looked in the agent dir twice
    // would answer the same on this test's inputs and differ on a real project's.
    const agentDir = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      expect(
        readCodemodeActivation(agentDir, cwd, PI),
        "nothing configured is still the default",
      ).toEqual({
        activation: "inactive",
        source: "default",
      });
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "mcp.json"),
        JSON.stringify({ mcpServers: { docs: stdioServer } }),
        "utf8",
      );
      expect(readCodemodeActivation(agentDir, cwd, PI)).toEqual({
        activation: "active",
        source: "mcp",
      });
    } finally {
      await removeTempDir(cwd);
      await removeTempDir(agentDir);
    }
  });

  test("a broken mcp.json is reported, and the activation still resolves on the settings alone", async () => {
    // The failure path: no silent probe input, and no half-applied decision. The settings
    // mirror's own verdict is unchanged — it is the evidence that is missing, not the answer.
    const agentDir = await makeTempDir();
    try {
      await writeFile(join(agentDir, "mcp.json"), "{ not json", "utf8");
      const resolved = readCodemodeActivation(agentDir, agentDir, PI);
      expect(resolved.activation).toBe("inactive");
      expect(resolved.source, "the loadout mirror still decides the source").toBe("default");
      expect(resolved.mcpError, "and the probe says which input it lost").toContain(
        "not valid JSON",
      );
      expect(resolved.mcpError).toContain("mcp.json");
      expect(resolved.error, "distinct from a broken settings file").toBeUndefined();
    } finally {
      await removeTempDir(agentDir);
    }
  });

  test("a session with no MCP resolves exactly as it did before this evidence existed", async () => {
    // The regression that has to hold for every existing user: two absent mcp.json files must be
    // invisible to the answer, so ADR-0029's default cell is untouched.
    const agentDir = await makeTempDir();
    try {
      expect(readCodemodeActivation(agentDir, agentDir, PI)).toEqual({
        activation: "inactive",
        source: "default",
      });
      expect(resolveCodemodeActivation(PI, undefined, undefined)).toEqual({
        activation: "inactive",
        source: "default",
      });
    } finally {
      await removeTempDir(agentDir);
    }
  });

  test("a file that exists but cannot be READ is reported, unlike one that does not exist", async () => {
    // The pair pi keeps apart and a naive `catch { return undefined }` collapses: an absent file
    // is skipped silently (`config.js:36-37`), while pi's read and parse share one `try`
    // (`:39-44`) and an unreadable file is pushed as an error. A DIRECTORY named `mcp.json` is
    // the reproducible unreadable case on any platform — `readFileSync` throws EISDIR.
    //
    // Counterfactual: collapse the two again and this goes red, which is the F1 the review caught:
    // the probe would report "codemode stays inactive" for a file it never managed to read, and
    // the user would have no way to tell that decision from a failed probe.
    const agentDir = await makeTempDir();
    try {
      await mkdir(join(agentDir, "mcp.json"), { recursive: true });
      const resolved = readCodemodeActivation(agentDir, agentDir, PI);
      expect(resolved.activation, "an unreadable file decides nothing").toBe("inactive");
      expect(resolved.mcpError, "and says so instead of looking absent").toContain(
        "could not be read",
      );
      expect(resolved.mcpError).toContain("mcp.json");
      expect(
        resolveMcpAutoEnableEvidence(
          { path: GLOBAL_PATH, raw: undefined },
          file(PROJECT_PATH, undefined),
        ),
        "an absent file is silent, which is what pi does",
      ).toEqual({ autoEnablesCodemode: false });
    } finally {
      await removeTempDir(agentDir);
    }
  });
});

describe("the one rule pi keeps per scope", () => {
  test("a project may not put auth on a URL server, and pi drops exactly that", () => {
    // `config.js:66-69`, the scope rule that lives in the file reader rather than in the
    // validator: a project entry with both `url` and `auth` is dropped, so a repository cannot
    // choose where its credential goes. Stated in both directions — the global file accepts the
    // same server, so a mirror that simply refused `auth` everywhere would fail the first
    // assertion, and one that ignored the scope would fail the second.
    const projectScoped = {
      mcpServers: { docs: { url: "https://example.com/mcp", auth: { provider: "acme" } } },
    };
    expect(evidence(projectScoped), "the same server in the global file counts").toEqual({
      autoEnablesCodemode: true,
    });
    expect(evidence(undefined, projectScoped), "in a project file pi drops it").toEqual({
      autoEnablesCodemode: false,
    });
  });
});
