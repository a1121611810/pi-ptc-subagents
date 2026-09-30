/**
 * Shared helpers for the PTC test suites.
 *
 * Nothing here ends in `.test.ts`, so `scripts/test.mjs` never picks it up as a suite.
 */
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import ptcSubagents from "../../src/index.ts";
import type { CodemodePresence, SurfaceMode } from "../../src/mode/ptc-mode.ts";
import type { Binding, BindingTable } from "../../src/runtime/bindings.ts";
import type { BackgroundTaskRuntime } from "../../src/runtime/background-runtime.ts";

/** Timeout applied to tests that spawn real workers, so a deadlock fails instead of hanging. */
export const RUN_TIMEOUT_MS = 20_000;

/** Create a realpath-resolved temp directory (macOS `/var` → `/private/var` otherwise). */
export async function makeTempDir(prefix = "pi-ptc-test-"): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A binding whose `execute` is the supplied function. */
export function makeBinding(name: string, execute: Binding["execute"]): Binding {
  return { name, execute };
}

/**
 * A recording extension-API stub: registers tools/commands/handlers and records the calls that
 * only a live pi session would otherwise make (tool loadout changes, status, notifications,
 * persisted entries). Tests drive it by emitting events, so the mode logic is exercised through
 * the same entry points pi uses.
 */
export interface ExtensionStub {
  tools: Map<string, ToolDefinition>;
  commands: Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >;
  handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
  /** The live tool loadout the stub reports from `getActiveTools`. */
  active: string[];
  /** Every loadout written through `setActiveTools`, in order. */
  activeWrites: string[][];
  entries: { customType: string; data?: unknown }[];
  notifications: { message: string; type?: string }[];
  statuses: { key: string; text: string | undefined }[];
  /** Custom messages sent through `pi.sendMessage`, in order. */
  sentMessages: {
    customType: string;
    content: string;
    display?: boolean;
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
  }[];
  /** User messages sent through `pi.sendUserMessage`, in order. */
  sentUserMessages: { content: string; options?: unknown }[];
  api: ExtensionAPI;
  /** Fire every handler registered for `event`, in registration order, and collect results. */
  emit(event: string, ctx: ExtensionContext): Promise<unknown[]>;
}

/**
 * pi's default session surface (`agent-session.js`: `["read", "bash", "edit", "write"]`).
 * The stub models this rather than every bindable name, because a double that reports more tools
 * than a real session has would hide exactly the class of bug where the mode misreads an ordinary
 * session as restricted.
 */
export const DEFAULT_SESSION_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

/** Build the stub and run the extension factory against it. */
export function makeExtensionStub(
  options: {
    active?: readonly string[];
    sessionDir?: string;
    /** BG-14 test seam: use a pre-built background runtime instead of constructing one. */
    backgroundRuntime?: BackgroundTaskRuntime;
    /**
     * ADR-0025: which surface the factory should build. An unspecified value is PINNED to
     * `full`, not read from disk -- seven test files build this factory, and without the pin they
     * would inherit the developer's real `~/.pi/agent/ptc.json`.
     *
     * `"from-file"` is the escape hatch that keeps the production path observable: it passes no
     * override at all, so the factory really does call `readSurfaceModeConfig(getAgentDir())`.
     * Without it, that call had no test anywhere -- a review round mutated it to a hardcoded
     * `"full"` and the whole suite stayed green.
     */
    surfaceMode?: SurfaceMode | "from-file";
    /**
     * ADR-0026: the codemode probe result the factory is told to believe. Only meaningful with
     * `surfaceMode: "from-file"`, because an explicit surface never consults the probe.
     */
    codemode?: CodemodePresence;
    /**
     * Tools pi's registry knows about that are NOT in the active loadout.
     *
     * pi's `getAllTools()` answers EVERY configured tool, active or not (ADR-0026 decision 6:
     * `codemode` ships `defaultActive: false`, so on a real install it is registered and
     * inactive at the same time). The stub used to answer with the active set plus what the
     * factory registered, which is the same list twice over -- it could not express the shipped
     * state at all, so every test that asked "does pi know codemode" was really asking "is
     * codemode active". `session_start`'s registry cross-check reads `getAllTools()` and the
     * decision-4 warning reads `getActiveTools()`, and with one name for both, only the
     * active-codemode case was reachable.
     */
    registeredInactive?: readonly string[];
  } = {},
): ExtensionStub {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const activeWrites: string[][] = [];
  const entries: { customType: string; data?: unknown }[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  const sentMessages: ExtensionStub["sentMessages"] = [];
  const sentUserMessages: ExtensionStub["sentUserMessages"] = [];
  const active = [...(options.active ?? DEFAULT_SESSION_TOOLS), "ptc_run_code", "ptc_workflow"];
  const registeredInactive = options.registeredInactive ?? [];

  const stub: ExtensionStub = {
    tools,
    commands,
    handlers,
    active,
    activeWrites,
    entries,
    notifications,
    statuses,
    sentMessages,
    sentUserMessages,
    api: undefined as unknown as ExtensionAPI,
    async emit(event, ctx) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? [])
        results.push(await handler({ type: event }, ctx));
      return results;
    },
  };

  const api = {
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (
      name: string,
      spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, spec);
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    getActiveTools: () => [...active],
    // ADR-0026: the factory-time filesystem probe cannot see --no-extensions or
    // --exclude-tools codemode, so session_start cross-checks it against pi's own registry.
    // The stub registry is the active set, plus what the factory registered, plus whatever
    // the caller declared as registered-but-inactive -- which is the state a real pi is in
    // for `codemode`, and the only way a test can tell "pi does not know this tool" apart
    // from "pi knows it but did not activate it".
    getAllTools: () =>
      [...new Set([...active, ...registeredInactive, ...tools.keys()])].map((name) => ({ name })),
    setActiveTools: (names: string[]) => {
      active.splice(0, active.length, ...names);
      activeWrites.push([...names]);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, ...(data === undefined ? {} : { data }) });
    },
    sendMessage: (
      message: { customType: string; content: string; display?: boolean },
      options?: ExtensionStub["sentMessages"][number]["options"],
    ) => {
      sentMessages.push({
        customType: message.customType,
        content: message.content,
        ...(message.display === undefined ? {} : { display: message.display }),
        ...(options === undefined ? {} : { options }),
      });
    },
    sendUserMessage: (content: string, options?: unknown) => {
      sentUserMessages.push({ content, ...(options === undefined ? {} : { options }) });
    },
  } as unknown as ExtensionAPI;

  stub.api = api;
  ptcSubagents(api, {
    ...(options.backgroundRuntime === undefined
      ? {}
      : { backgroundRuntime: options.backgroundRuntime }),
    // ADR-0025: the surface is PINNED to `full` unless the caller asks for something else,
    // and `"from-file"` is the only way to reach the production read. Both halves are load-bearing
    // and the second was learned the hard way in review round 2: an earlier version passed NO
    // override when the caller said nothing, which let the factory-driven test files inherit the developer's
    // real `~/.pi/agent/ptc.json` -- 31 failures with a `surfaceMode: off` dir set, against 4
    // before. An unspecified surface is a pin, never a read. (The count is deliberately not written here: round 2 put "eight" in a comment and round 3 found "seven" in another, and both were wrong. grep it.)
    ...(options.surfaceMode === "from-file"
      ? options.codemode === undefined
        ? {}
        : { codemode: options.codemode }
      : { surfaceMode: options.surfaceMode ?? "full" }),
  });
  return stub;
}

/**
 * Run the extension factory against a recording stub and return the tools it registered,
 * keyed by registered name. This is the registration path pi itself takes, so the definitions
 * under test are the ones the model would actually call.
 *
 * The stub reports every built-in as active, so integration tests exercise the full surface;
 * enablement-policy tests wire restricted `getBindingSourceNames` getters into the factories
 * directly instead.
 */
export function captureRegisteredTools(): Map<string, ToolDefinition> {
  return makeExtensionStub().tools;
}

/**
 * A minimal `ExtensionContext` for mode tests: the fields the mode reads are `mode`, `ui`
 * (notify / setStatus / theme) and `sessionManager.getEntries()`.
 */
export function modeContext(
  options: {
    mode?: string;
    entries?: { type: string; customType: string; data?: unknown }[];
    sessionDir?: string;
    notify?: (message: string, type?: string) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  } = {},
): ExtensionContext {
  return {
    mode: options.mode ?? "tui",
    ui: {
      notify: options.notify ?? (() => {}),
      setStatus: options.setStatus ?? (() => {}),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionDir: () => options.sessionDir,
    },
  } as unknown as ExtensionContext;
}

/**
 * A context wired to a stub's recorders, so a test can read what the mode announced in
 * `stub.notifications` / `stub.statuses` instead of threading its own callbacks around.
 */
export function stubContext(
  stub: ExtensionStub,
  options: {
    mode?: string;
    entries?: { type: string; customType: string; data?: unknown }[];
    sessionDir?: string;
  } = {},
): ExtensionContext {
  return modeContext({
    ...options,
    notify: (message, type) =>
      stub.notifications.push({ message, ...(type === undefined ? {} : { type }) }),
    setStatus: (key, text) => stub.statuses.push({ key, text }),
  });
}

/**
 * Minimal execution context for tool tests.
 *
 * The tool layer reads exactly one field — `cwd` (see `src/tools/common.ts`) — but the real
 * parameter type is pi's `ExtensionContext`, so tests pass this narrowed object through a cast
 * rather than fabricating a whole session.
 */
export function toolContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/**
 * A valid 1×1 PNG, base64-encoded.
 *
 * Tests that need "an image" use real PNG bytes so the whole path — `read`'s magic-byte detection,
 * the worker's JSON round trip, the host's hoist (ADR-0014) — is exercised on a decodable image
 * rather than on a stand-in string.
 */
export const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/**
 * A valid 1×1 PNG as a fresh `ArrayBuffer`.
 *
 * This is the compatibility path in `captureImages`: a binding that produces raw `ArrayBuffer`
 * bytes (rather than the `data: <base64>` shape pi's own tools emit) has its bytes encoded to
 * base64 once, host-side. Tests feed it through a real worker so the normalisation is exercised
 * end to end. The `ArrayBuffer` is allocated per call so two tests get distinct buffers.
 */
export function onePixelPngBytes(): ArrayBuffer {
  return Uint8Array.from(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")).buffer;
}

/**
 * The decoded PNG content as a `Uint8Array` view (for byte-equality assertions).
 */
export const ONE_PIXEL_PNG_UINT8: Uint8Array = Uint8Array.from(
  Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
);

/** Build a binding table; keys become the `tools.<name>` namespace in the worker. */
export function makeBindings(entries: Record<string, Binding["execute"]>): BindingTable {
  const table = new Map<string, Binding>();
  for (const [name, execute] of Object.entries(entries))
    table.set(name, makeBinding(name, execute));
  return table;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
//  A recording `pi` on PATH -- the only observation seam the FOREGROUND
//  `dispatch()` branch can be given. See `installRecordingPi`.
// ---------------------------------------------------------------------------

/**
 * What the recording `pi` child does: append one JSON line per invocation, wait out the
 * hold, then answer with the single event line pi's JSONL mode emits and exit 0.
 *
 * The argv is recorded whole rather than a count, so a test can assert on WHICH dispatch
 * reached a child (which task text, which prompt file) and not only how many did.
 */
const RECORDING_PI_SOURCE = [
  '"use strict";',
  "const fs = require('node:fs');",
  "fs.appendFileSync(__LOG__, JSON.stringify(process.argv.slice(2)) + '\\n');",
  "const answer = JSON.stringify({",
  "  type: 'message_end',",
  "  message: { role: 'assistant', content: [{ type: 'text', text: __TEXT__ }] },",
  "});",
  "setTimeout(() => {",
  // Written in the write callback, not before it: `process.exit` truncates a pipe that has
  // not drained, and the host reads the child's final text out of exactly this line.
  "  process.stdout.write(answer + '\\n', () => process.exit(0));",
  "}, __HOLD_MS__);",
  "",
].join("\n");

/** A `pi` first on PATH that records every invocation and answers pi's JSONL shape. */
export interface RecordingPi {
  /** The directory prepended to PATH; it holds the `pi` executable and its script. */
  readonly dir: string;
  /** The argv of every child launched so far, in spawn order. */
  spawns(): Promise<readonly string[][]>;
  /** How many children were actually launched. Zero is a measurement, not an absence. */
  count(): Promise<number>;
  /**
   * The invocations recorded once the log has stopped growing, or the budget runs out.
   *
   * A "no child was launched" assertion has to outlast the launch it is looking for. A spawn
   * is fire-and-forget from the dispatch call's point of view, and a child that has only just
   * been forked writes its line tens of milliseconds later -- measured: a mutant that launched
   * a child and THEN returned the refusal passed a count read straight after the call. So a
   * test asserting an absence waits for the log to settle first; a test asserting a presence
   * can read {@link spawns} directly, because the calls it counts have already completed.
   */
  settle(): Promise<readonly string[][]>;
  /** Put PATH back exactly as it was and delete the directory. Idempotent. */
  restore(): Promise<void>;
}

/**
 * Put a recording `pi` at the front of PATH, so a test can count what a FOREGROUND
 * `dispatch()` really spawned.
 *
 * ## Why this exists rather than an injected mock lifecycle
 *
 * `dispatchBackground` takes its lifecycle from `deps.lifecycle`, so a test can hand it a
 * `MockChildProcessLifecycle` and count spawns through it. The foreground branch does not:
 * it uses the module-level `DISPATCH_LIFECYCLE` (`src/runtime/dispatch.ts`) and never reads
 * `deps.lifecycle`. There is no seam to inject, and none can be added from a test file --
 * round 4 named this as the reason no test could see a foreground spawn.
 *
 * What the foreground branch does do is spawn the command `"pi"` (`PI_COMMAND`) with
 * `env: { ...process.env }`. So the observation that needs no production change is the
 * executable itself: a real `pi`-named program at the front of PATH. The child really runs,
 * the spawn really is the production one, and the log is written by the child. That is
 * closer to an end-to-end measurement than a mock would be, at the cost of one `node`
 * startup per dispatch.
 *
 * The stub answers the JSONL line shape `src/runtime/child-process-lifecycle.ts` parses (one
 * `message_end` carrying assistant text, then exit 0), so a dispatched call settles as
 * `fulfilled` carrying that text. A real pi would need a provider and credentials; the
 * assertions this seam supports are about how many children were launched, not about what a
 * model would have said.
 *
 * `holdMs` keeps each child alive. A foreground dispatch holds its slot until the child
 * closes, so a burst only measures an admission count while the children are still running --
 * otherwise the number is a race against process startup.
 *
 * PATH is process-wide, so a test must `restore()` it (in a `finally`). Vitest gives each
 * test FILE its own worker, so this cannot leak into another file.
 */
export async function installRecordingPi(
  options: {
    /** How long each child stays alive before answering. Default 0: answer immediately. */
    holdMs?: number;
    /** The text the child puts in its assistant message. Default `"PONG"`. */
    text?: string;
  } = {},
): Promise<RecordingPi> {
  const dir = await makeTempDir("pi-ptc-recording-pi-");
  const logPath = join(dir, "spawns.jsonl");
  const scriptPath = join(dir, "recording-pi.cjs");
  const source = RECORDING_PI_SOURCE.replace("__LOG__", JSON.stringify(logPath))
    .replace("__TEXT__", JSON.stringify(options.text ?? "PONG"))
    .replace("__HOLD_MS__", String(options.holdMs ?? 0));
  // A `.cjs` file is CommonJS whatever the nearest package.json says, and the `pi`
  // executable is an extensionless shell wrapper around it, so module resolution is not a
  // factor here. `process.execPath` is the node actually running the test.
  await writeFile(scriptPath, source, "utf8");
  const piPath = join(dir, "pi");
  await writeFile(
    piPath,
    "#!/bin/sh\nexec " +
      JSON.stringify(process.execPath) +
      " " +
      JSON.stringify(scriptPath) +
      ' "$@"\n',
    "utf8",
  );
  await chmod(piPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined ? dir : dir + delimiter + previousPath;
  let restored = false;

  const spawns = async (): Promise<readonly string[][]> => {
    let raw: string;
    try {
      raw = await readFile(logPath, "utf8");
    } catch {
      // No file at all is a real measurement -- nothing was launched -- not a broken fixture.
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  };

  // Polls until the count has held steady for a full quiet window, so the line a just-forked
  // child writes is counted rather than raced. The window is generous on purpose: the child is
  // a shell wrapper that execs node, so two startups stand between the spawn and the write
  // (measured: a 100 ms window still lost the race, 500 ms does not). The iteration cap bounds
  // the wait for a child that never comes up at all.
  const QUIET_READS = 5;
  const POLL_MS = 100;
  const settle = async (): Promise<readonly string[][]> => {
    let previous = -1;
    let steady = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
      const current = (await spawns()).length;
      steady = current === previous ? steady + 1 : 0;
      previous = current;
      if (steady >= QUIET_READS) break;
    }
    return await spawns();
  };

  return {
    dir,
    spawns,
    count: async () => (await spawns()).length,
    settle,
    restore: async () => {
      if (restored) return;
      restored = true;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await removeTempDir(dir);
    },
  };
}
