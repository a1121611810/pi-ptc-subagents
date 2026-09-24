/**
 * ChildProcessLifecycle: the seam between `pi.dispatch` and the OS process.
 *
 * BG-03 extracts the spawn / kill / JSONL-parse / exit-wait dance that used to live
 * inline in `src/runtime/dispatch.ts` into a typed interface with two adapters:
 *
 *   - `RealChildProcessLifecycle`  - wraps `node:child_process.spawn`; this is what the
 *                                    production foreground `pi.dispatch` path uses.
 *   - `MockChildProcessLifecycle`  - in-memory event queue + exit signal; lets unit tests
 *                                    drive the dispatch code without spawning anything.
 *
 * Both adapters expose the same five methods (`spawn`, `kill`, `events`, `exit`,
 * `stderr`), so the foreground dispatch can construct a `DispatchResult` regardless of
 * which adapter it was handed. The adapter-specific state lives in `ChildHandle.opaque`
 * - each adapter owns the shape of its own opaque and never reaches across the seam.
 *
 * The interface does NOT cover abort-signal handling: the foreground `dispatch()` keeps
 * its existing SIGTERM -> SIGKILL dance in this iteration (it sets `aborted=true` which
 * `decideCloseOutcome` reads), and the background dispatch will layer its own lifecycle
 * on top of the same handle later.
 *
 * `ParsedAgentEvent` / `parseAgentEvent` move here from `dispatch.ts` - they were the
 * only data shape tied to the stdout stream, and they belong with the adapter that
 * produces them rather than with the dispatcher that consumes them.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
//  ULID
// ---------------------------------------------------------------------------

/**
 * String id for a child handle. Background-dispatch (ADR-0022) carries these as
 * `taskId`; for the foreground path we need uniqueness within one process, and across
 * a restart, since these persist under `<sessionDir>`.
 *
 * A real ULID: 26 chars of Crockford base32, `TTTTTTTTTTRRRRRRRRRRRRRRRR` — 10 chars
 * (48 bits) of ms-epoch followed by 16 chars (80 bits) of crypto randomness. The
 * alphabet omits I, L, O and U; its ordering means lexical sort equals creation order.
 * 80 bits from `randomBytes` (not `Math.random()`) makes two ids minted in the same
 * millisecond distinct, and a per-ms counter makes them strictly increasing.
 */
export type ULID = string;

/** Crockford base32 alphabet (ULID spec) - deliberately omits I, L, O, U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic state: ms of the last id plus its random tail, for same-ms increments. */
let lastMs = -1;
let lastRandom: Uint8Array<ArrayBufferLike> = new Uint8Array(10);

/** Encode a 48-bit ms timestamp as 10 Crockford chars (most-significant first). */
function encodeTime(ms: number): string {
  let out = "";
  let v = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** Encode 80 bits of entropy as 16 Crockford chars (5 bits per char). */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length && out.length < 16; i++) {
    acc = (acc << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
  }
  return out.padEnd(16, "0");
}

/** Increment an 80-bit big-endian byte tail by one (wraps at 2^80, never in practice). */
function incrementRandom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if ((out[i] ?? 0) < 0xff) {
      out[i] = (out[i] ?? 0) + 1;
      return out;
    }
    out[i] = 0;
  }
  return out;
}

/** Generate a fresh `ULID` for one child handle. Monotonic within a millisecond. */
export function createULID(): ULID {
  const now = Date.now();
  // Never let a backwards clock step (NTP) break the lexical-ordering invariant.
  const ms = now > lastMs ? now : lastMs;
  const bytes = ms === lastMs ? incrementRandom(lastRandom) : new Uint8Array(randomBytes(10));
  lastMs = ms;
  lastRandom = bytes;
  return encodeTime(ms) + encodeRandom(bytes);
}

// ---------------------------------------------------------------------------
//  ParsedAgentEvent - moved from dispatch.ts (BG-03)
// ---------------------------------------------------------------------------

/**
 * One line of the child's stdout, parsed as JSON. The child emits the events described
 * in examples/extensions/subagent/index.ts (message_end, tool_result_end, error).
 * Anything unparseable is dropped: the line is one event the host cannot interpret,
 * and the run continues.
 */
export interface ParsedAgentEvent {
  type: string;
  message?: {
    role?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  message_text?: string;
}

/**
 * Parse one JSONL line into a `ParsedAgentEvent`. Returns `null` for empty lines and
 * for JSON.parse failures (both are non-events the host cannot act on).
 */
export function parseAgentEvent(line: string): ParsedAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as ParsedAgentEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  ChildProcessLifecycle interface
// ---------------------------------------------------------------------------

/**
 * Opaque per-handle state owned by the adapter that produced it. The dispatch code
 * never reads `opaque` directly; it only hands the handle back to adapter methods
 * (`kill`, `events`, `exit`, `stderr`).
 */
export interface ChildHandle {
  readonly id: ULID;
  readonly opaque: unknown;
}

/**
 * Spawn options shared by both adapters. `promptFile` / `sessionDir` / `sessionId` /
 * `sessionName` / `argv_extra` are the R1 fields the background dispatch will consume
 * (ADR-0022). The foreground `pi.dispatch` path passes only `cwd` / `env` / `signal`
 * / `promptFile`.
 */
export interface ChildSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  promptFile: string;
  sessionDir?: string;
  sessionId?: string;
  sessionName?: string;
  argv_extra?: readonly string[];
}

/** Process-exit shape the `close` event on `node:child_process.ChildProcess` produces. */
export interface ChildExitValue {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The lifecycle contract. Implementations:
 *   - `RealChildProcessLifecycle` - wraps `node:child_process.spawn` (production).
 *   - `MockChildProcessLifecycle` - in-memory queue + exit signal (tests).
 */
export interface ChildProcessLifecycle {
  /**
   * Launch one child process. The first element of `argv` is the executable; the rest
   * are forwarded as command-line arguments. Returns an opaque handle the caller uses
   * to talk to the same child via the other methods.
   *
   * `opts.env` is the full environment for the child; the caller is responsible for
   * merging anything the child needs (e.g. `PI_PTC_DEPTH`) on top of `process.env`.
   */
  spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle;

  /**
   * Send `signal` to the child iff it is still attached. Absorbs "process already gone"
   * throws so callers can fire-and-forget on cancel. Mirrors `safeKill` below.
   */
  kill(handle: ChildHandle, signal: "SIGTERM" | "SIGKILL"): void;

  /**
   * Async iterator over the child's stdout events. Yields one `ParsedAgentEvent` per
   * JSONL line. The iterator ends after the child closes; callers should `await` it
   * fully before reading `exit()`.
   */
  events(handle: ChildHandle): AsyncIterable<ParsedAgentEvent>;

  /**
   * Resolve when the child closes, with `(code, signal)` matching `node:child_process`'s
   * `close` event. A clean exit is `(0, null)`; a signal kill is `(null, <signal>)`;
   * a spawn failure surfaces as `(null, null)` once the error event has propagated.
   */
  exit(handle: ChildHandle): Promise<ChildExitValue>;

  /**
   * Resolve with the accumulated stderr text once the child has closed. Returns `""`
   * when the child wrote nothing. Spawn failures append a `[spawn-error] ...` marker
   * (same convention as the pre-BG-03 dispatch code) so callers can distinguish a
   * failed spawn from a clean non-zero exit.
   */
  stderr(handle: ChildHandle): Promise<string>;
}

// ---------------------------------------------------------------------------
//  safeKill - moved from dispatch.ts; used by RealChildProcessLifecycle
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the bits of `node:child_process`'s ChildProcess that
 * `safeKill` touches - narrow on purpose so tests can pass plain objects.
 *
 * `pid` is optional on `ChildProcess` (`pid?: number`); a fresh process whose
 * pid has not yet been assigned reports `undefined`, and the kill must be a
 * no-op rather than a TS error. `killed` is intentionally absent: callers read
 * it on the real ChildProcess directly, not through this helper's contract.
 */
export interface Killable {
  pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

/**
 * Send `signal` to `proc` iff the process is still attached, swallowing
 * "process already gone" throws. Returns whether a kill was actually issued.
 *
 * `proc.pid === undefined` happens for processes spawned without a usable
 * pid (rare, but TS-strict demands the guard); `proc.kill` throwing happens
 * for processes that exited between the guard and the syscall (the OS hands
 * back ESRCH). Both are "no-op successfully" for our purposes.
 */
export function safeKill(proc: Killable, signal: NodeJS.Signals): boolean {
  if (proc.pid === undefined) return false;
  try {
    proc.kill(signal);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Shared internal state (used by both adapters)
// ---------------------------------------------------------------------------

/**
 * Per-handle bookkeeping. Both adapters share this shape: an event queue, a list of
 * waiters blocked on the next event, an exit value + list of exit waiters, and a
 * stderr buffer. `RealChildHandleState` adds `proc` and the JSONL line buffer;
 * `MockChildHandleState` adds the test-only argv/opts recorder + kill-signal log.
 */
interface BaseHandleState {
  /** Parsed events ready to be yielded. */
  events: ParsedAgentEvent[];
  /** Consumers blocked in `events()` waiting for the next event (or `null` = drained). */
  eventWaiters: Array<(ev: ParsedAgentEvent | null) => void>;
  /** Set true once `exit()` should resolve. */
  exited: boolean;
  /** Exit value once `exited` flips true. */
  exitValue: ChildExitValue | null;
  /** Consumers blocked in `exit()` waiting for the close. */
  exitWaiters: Array<(v: ChildExitValue) => void>;
  /** stderr waiters - resolves with the full stderr text once the child closes. */
  stderrWaiters: Array<(v: string) => void>;
  /** stderr buffer; only the real adapter writes to this. */
  stderr: string;
}

function pushEvent(state: BaseHandleState, ev: ParsedAgentEvent): void {
  if (state.eventWaiters.length > 0) {
    const w = state.eventWaiters.shift();
    if (w) w(ev);
    return;
  }
  state.events.push(ev);
}

function markExited(state: BaseHandleState, value: ChildExitValue): void {
  if (state.exited) return;
  state.exited = true;
  state.exitValue = value;
  for (const w of state.exitWaiters) w(value);
  state.exitWaiters = [];
  // Wake any event waiters with `null` so their `for-await` loop ends.
  const waiters = state.eventWaiters;
  state.eventWaiters = [];
  for (const w of waiters) w(null);
  for (const w of state.stderrWaiters) w(state.stderr);
  state.stderrWaiters = [];
}

// ---------------------------------------------------------------------------
//  RealChildProcessLifecycle
// ---------------------------------------------------------------------------

/** Internal real-adapter state. Lives in `ChildHandle.opaque`. */
interface RealChildHandleState extends BaseHandleState {
  proc: ReturnType<typeof spawn>;
  /** In-progress JSONL line carried between stdout chunks. */
  lineBuffer: string;
}

/**
 * Production adapter: wraps `node:child_process.spawn`. One instance is shared across
 * all dispatches in a process (it carries no per-dispatch state of its own).
 */
export class RealChildProcessLifecycle implements ChildProcessLifecycle {
  spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    if (argv.length === 0) {
      throw new TypeError("RealChildProcessLifecycle.spawn: argv must include the command");
    }
    const command = argv[0] as string;
    const args = argv.slice(1);

    const proc = spawn(command, args, {
      cwd: opts.cwd,
      // ADR-0016: shell:false keeps argv as passed by the platform exec syscall; shell:true
      // would re-tokenize on whitespace and break the prompt path with spaces.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
    });

    const state: RealChildHandleState = {
      proc,
      events: [],
      eventWaiters: [],
      exited: false,
      exitValue: null,
      stderrWaiters: [],
      exitWaiters: [],
      stderr: "",
      lineBuffer: "",
    };
    const handle: ChildHandle = { id: createULID(), opaque: state };

    const stdout = proc.stdout;
    if (stdout) {
      stdout.on("data", (data: Buffer) => {
        state.lineBuffer += data.toString("utf-8");
        let nl = state.lineBuffer.indexOf("\n");
        while (nl >= 0) {
          const line = state.lineBuffer.slice(0, nl);
          state.lineBuffer = state.lineBuffer.slice(nl + 1);
          const ev = parseAgentEvent(line);
          if (ev) pushEvent(state, ev);
          nl = state.lineBuffer.indexOf("\n");
        }
      });
    }

    const stderrStream = proc.stderr;
    if (stderrStream) {
      stderrStream.on("data", (data: Buffer) => {
        state.stderr += data.toString("utf-8");
      });
    }

    proc.on("close", (code, signal) => {
      // Drain any final JSONL line that didn't end with a newline (the child may exit
      // mid-line; the existing dispatch code treated anything in the buffer at close as
      // a last-chance event, so we do the same).
      const trailing = state.lineBuffer.trim();
      if (trailing.length > 0) {
        const ev = parseAgentEvent(trailing);
        if (ev) pushEvent(state, ev);
        state.lineBuffer = "";
      }
      markExited(state, { code, signal });
    });

    proc.on("error", (err) => {
      // ENOENT and friends arrive here, not at the synchronous `spawn()` call. The
      // marker is what the foreground dispatch looks for in stderr to label the
      // outcome as `started: false` instead of a normal non-zero exit.
      state.stderr += "[spawn-error] " + err.message + "\n";
      // If the child hasn't closed yet (it may or may not, depending on the OS), make
      // sure exit() resolves so the caller doesn't hang.
      if (!state.exited) {
        markExited(state, { code: null, signal: null });
      }
    });

    return handle;
  }

  kill(handle: ChildHandle, signal: "SIGTERM" | "SIGKILL"): void {
    const state = handle.opaque as RealChildHandleState;
    safeKill(state.proc, signal);
  }

  events(handle: ChildHandle): AsyncIterable<ParsedAgentEvent> {
    const state = handle.opaque as RealChildHandleState;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (state.events.length > 0) {
            const ev = state.events.shift();
            if (ev !== undefined) yield ev;
            continue;
          }
          if (state.exited) return;
          const ev = await new Promise<ParsedAgentEvent | null>((resolve) => {
            state.eventWaiters.push(resolve);
          });
          if (ev === null) return;
          yield ev;
        }
      },
    };
  }

  exit(handle: ChildHandle): Promise<ChildExitValue> {
    const state = handle.opaque as RealChildHandleState;
    if (state.exited && state.exitValue) return Promise.resolve(state.exitValue);
    return new Promise((resolve) => {
      state.exitWaiters.push(resolve);
    });
  }

  stderr(handle: ChildHandle): Promise<string> {
    const state = handle.opaque as RealChildHandleState;
    if (state.exited) return Promise.resolve(state.stderr);
    return new Promise((resolve) => {
      state.stderrWaiters.push(resolve);
    });
  }
}

// ---------------------------------------------------------------------------
//  MockChildProcessLifecycle
// ---------------------------------------------------------------------------

/** Internal mock-adapter state. Lives in `ChildHandle.opaque`. */
interface MockChildHandleState extends BaseHandleState {
  /** The argv + opts the spawn was called with; tests assert against this. */
  recordedArgv: readonly string[];
  recordedOpts: ChildSpawnOptions;
  /** Every signal handed to `kill()`, in order. */
  killSignals: Array<"SIGTERM" | "SIGKILL">;
}

/**
 * Test adapter. Lets unit tests drive the dispatch code without spawning anything.
 *
 * Test API:
 *   - `pushEvent(handle, event)` - append one event to the queue.
 *   - `resolveExit(handle, code, signal)` - close the child.
 *   - `setStderr(handle, text)` - set the stderr buffer (read by `stderr()`).
 *   - `getRecordedArgv(handle)` - what was passed to `spawn`.
 *   - `getRecordedOpts(handle)` - the opts the spawn was called with.
 *   - `getKillSignals(handle)` - every signal handed to `kill()`.
 */
export class MockChildProcessLifecycle implements ChildProcessLifecycle {
  private readonly states = new Map<ChildHandle, MockChildHandleState>();
  /** Monotonic counter used as the handle id; unique across this mock instance. */
  private idCounter = 0;

  spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    this.idCounter += 1;
    const handle: ChildHandle = {
      id: ("MOCK-" + this.idCounter.toString(36).padStart(6, "0").toUpperCase()) as ULID,
      opaque: undefined,
    };
    const state: MockChildHandleState = {
      recordedArgv: argv,
      recordedOpts: opts,
      events: [],
      eventWaiters: [],
      exited: false,
      exitValue: null,
      stderrWaiters: [],
      exitWaiters: [],
      stderr: "",
      killSignals: [],
    };
    (handle as { opaque: unknown }).opaque = state;
    this.states.set(handle, state);
    return handle;
  }

  kill(handle: ChildHandle, signal: "SIGTERM" | "SIGKILL"): void {
    const state = this.states.get(handle);
    if (!state) return;
    state.killSignals.push(signal);
  }

  events(handle: ChildHandle): AsyncIterable<ParsedAgentEvent> {
    const state = this.requireState(handle);
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (state.events.length > 0) {
            const ev = state.events.shift();
            if (ev !== undefined) yield ev;
            continue;
          }
          if (state.exited) return;
          const ev = await new Promise<ParsedAgentEvent | null>((resolve) => {
            state.eventWaiters.push(resolve);
          });
          if (ev === null) return;
          yield ev;
        }
      },
    };
  }

  exit(handle: ChildHandle): Promise<ChildExitValue> {
    const state = this.requireState(handle);
    if (state.exited && state.exitValue) return Promise.resolve(state.exitValue);
    return new Promise((resolve) => {
      state.exitWaiters.push(resolve);
    });
  }

  stderr(handle: ChildHandle): Promise<string> {
    const state = this.requireState(handle);
    if (state.exited) return Promise.resolve(state.stderr);
    return new Promise((resolve) => {
      state.stderrWaiters.push(resolve);
    });
  }

  // -- Test-only API -------------------------------------------------------

  /** Append one event to the queue. Throws if the handle is unknown. */
  pushEvent(handle: ChildHandle, event: ParsedAgentEvent): void {
    const state = this.requireState(handle);
    pushEvent(state, event);
  }

  /** Close the child. Resolves pending `exit()` / `events()` / `stderr()`. */
  resolveExit(handle: ChildHandle, code: number | null, signal: NodeJS.Signals | null): void {
    const state = this.requireState(handle);
    markExited(state, { code, signal });
  }

  /** Replace the stderr buffer; resolves pending `stderr()` if the child has closed. */
  setStderr(handle: ChildHandle, text: string): void {
    const state = this.requireState(handle);
    state.stderr = text;
    if (state.exited) {
      const waiters = state.stderrWaiters;
      state.stderrWaiters = [];
      for (const w of waiters) w(text);
    }
  }

  /** Returns a copy of the argv the spawn was called with. */
  getRecordedArgv(handle: ChildHandle): readonly string[] {
    return [...this.requireState(handle).recordedArgv];
  }

  /** Returns a copy of the opts the spawn was called with. */
  getRecordedOpts(handle: ChildHandle): ChildSpawnOptions {
    return { ...this.requireState(handle).recordedOpts };
  }

  /** Returns the kill signals handed to `kill()`, in order. */
  getKillSignals(handle: ChildHandle): Array<"SIGTERM" | "SIGKILL"> {
    return [...this.requireState(handle).killSignals];
  }

  /** Number of handles this mock has spawned (test introspection). */
  get spawnCount(): number {
    return this.states.size;
  }

  private requireState(handle: ChildHandle): MockChildHandleState {
    const state = this.states.get(handle);
    if (!state) {
      throw new Error("MockChildProcessLifecycle: unknown handle " + handle.id);
    }
    return state;
  }
}
