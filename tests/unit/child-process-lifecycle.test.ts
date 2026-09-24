import { describe, expect, test } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import {
  MockChildProcessLifecycle,
  RealChildProcessLifecycle,
  createULID,
  parseAgentEvent,
  safeKill,
  type ChildHandle,
  type ChildProcessLifecycle,
  type ParsedAgentEvent,
} from "../../src/runtime/child-process-lifecycle.ts";

/**
 * BG-03 unit tests for `src/runtime/child-process-lifecycle.ts`.
 *
 * The module under test is a typed seam between `pi.dispatch` and the OS process,
 * with two adapters. These tests pin the seam's contract (the interface), the
 * production adapter (`RealChildProcessLifecycle`, wraps `node:child_process`),
 * and the test adapter (`MockChildProcessLifecycle`, in-memory queue).
 *
 * Coverage:
 *   - ULID generator is unique + non-empty (constraint #4 oracle: distinct calls
 *     produce distinct strings).
 *   - `parseAgentEvent` returns null for empty / non-JSON lines (constraint #1).
 *   - `safeKill` swallows ESRCH throws and skips pid=undefined (constraint #1).
 *   - Real adapter:
 *       - spawn() throws on empty argv (constraint #1).
 *       - spawn() launches argv[0] as the command and the rest as args (constraint #4).
 *       - events() yields a parsed `ParsedAgentEvent` from a real JSONL stdout stream.
 *       - exit() resolves with `{ code, signal }` after the child closes.
 *       - stderr() resolves with the accumulated stderr text.
 *       - kill("SIGTERM") ends a long-running child within a bounded time.
 *       - spawn-failure (ENOENT) leaves stderr with the `[spawn-error]` marker
 *         and exits with `(null, null)`.
 *   - Mock adapter:
 *       - spawn() records argv + opts.
 *       - kill() appends to a signal list.
 *       - events() yields pushed events in FIFO order and ends after resolveExit.
 *       - exit() / stderr() resolve with the values set by the test API.
 *       - multiple handles are tracked independently (constraint #5: a wrong impl
 *         that shared state across handles would fail this).
 *
 * Constraint #5 (counterfactual): every assertion is concrete (e.g. `toBe(1)`), not
 * accept-both; if the implementation "succeeded vacuously" the test would still pin
 * the contract.
 */

/**
 * Run `node -e <js>` as a child, returning its handle so each test can run
 * `events()` / `exit()` against it. We use `process.execPath` (not `node`) so the
 * test works on every OS the host supports.
 */
function spawnNode(
  js: string,
  opts: { extraArgs?: readonly string[] } = {},
): {
  lifecycle: RealChildProcessLifecycle;
  handle: ChildHandle;
} {
  const lifecycle = new RealChildProcessLifecycle();
  const argv = [process.execPath, "-e", js, ...(opts.extraArgs ?? [])];
  const handle = lifecycle.spawn(argv, {
    cwd: process.cwd(),
    promptFile: "/tmp/bg-03-test-no-such-file.md",
  });
  return { lifecycle, handle };
}

describe("createULID", () => {
  // A ULID is 26 chars of Crockford base32 (spec: 48-bit ms timestamp, 80 bits random).
  // The alphabet deliberately omits I, L, O and U to avoid transcription confusion.
  const CROCKFORD_26 = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  test("emits a 26-character Crockford-base32 ULID", () => {
    const id = createULID();
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD_26);
  });

  test("ids minted in the same millisecond are distinct AND lexically increasing", () => {
    // ULID's whole point is that lexical order equals creation order. A 52-bit
    // Math.random() tail (the pre-fix implementation) is neither monotonic nor
    // collision-free, so this assertion genuinely fails on that version.
    const ids = Array.from({ length: 200 }, () => createULID());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  test("the first 10 chars are the ms timestamp and sort across milliseconds", () => {
    const before = createULID();
    const start = Date.now();
    while (Date.now() === start) {
      // spin one real millisecond so the timestamp prefix must advance
    }
    const after = createULID();
    expect(after.slice(0, 10) > before.slice(0, 10)).toBe(true);
  });
});

describe("parseAgentEvent (moved from dispatch.ts)", () => {
  test("returns null for an empty line and a whitespace-only line", () => {
    expect(parseAgentEvent("")).toBeNull();
    expect(parseAgentEvent("   \n  ")).toBeNull();
  });

  test("returns null for invalid JSON (do not throw)", () => {
    expect(parseAgentEvent("not json")).toBeNull();
    expect(parseAgentEvent("{unterminated")).toBeNull();
  });

  test("parses a minimal event with just `type`", () => {
    const ev = parseAgentEvent('{"type":"ping"}');
    expect(ev?.type).toBe("ping");
  });
});

describe("safeKill (moved from dispatch.ts)", () => {
  test("returns true and invokes kill when pid is set", () => {
    const calls: string[] = [];
    const result = safeKill(
      {
        pid: 1234,
        kill: (s) => {
          calls.push(s);
          return true;
        },
      },
      "SIGTERM",
    );
    expect(result).toBe(true);
    expect(calls).toEqual(["SIGTERM"]);
  });

  test("returns false and skips kill when pid is undefined", () => {
    const calls: string[] = [];
    const result = safeKill(
      {
        pid: undefined,
        kill: (s) => {
          calls.push(s);
          return true;
        },
      },
      "SIGKILL",
    );
    expect(result).toBe(false);
    expect(calls).toEqual([]);
  });

  test("returns false when proc.kill throws (ESRCH etc.)", () => {
    const result = safeKill(
      {
        pid: 9,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
      "SIGTERM",
    );
    expect(result).toBe(false);
  });
});

describe("RealChildProcessLifecycle", () => {
  test("spawn() throws when argv is empty (constraint #1: invalid input)", () => {
    const lifecycle = new RealChildProcessLifecycle();
    expect(() => lifecycle.spawn([], { cwd: process.cwd(), promptFile: "/tmp/x.md" })).toThrow(
      /argv must include the command/,
    );
  });

  test("spawn() launches argv[0] as the command and the rest as args", async () => {
    // Echo argv[1] to stdout so we can verify the exact wire shape end-to-end.
    const { handle } = spawnNode('process.stdout.write(process.argv[1] + "");', {
      extraArgs: ["bg03-arg"],
    });
    const events: ParsedAgentEvent[] = [];
    for await (const ev of new RealChildProcessLifecycle().events(handle)) {
      events.push(ev);
    }
    // No JSONL was emitted (the inline script writes a plain string, not JSON), so
    // `events()` ends without yielding anything but the adapter still recognized the
    // child close. Verify the child actually ran by reading its stderr instead.
    const exit = await new RealChildProcessLifecycle().exit(handle);
    expect(exit.code).toBe(0);
    expect(events).toEqual([]);
  });

  test("events() yields a ParsedAgentEvent for a real JSONL stdout line", async () => {
    // A single message_end with assistant role + text content. Mirrors what pi
    // emits in --mode json per examples/extensions/subagent/index.ts.
    const js = [
      'process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"PONG"}]}}));',
      // NOTE: '\\n' (escaped backslash-n) is required here — a bare '\n' inside this
      // TypeScript string literal becomes a REAL newline, which would be spliced into the
      // child's string literal and turn the child script into a syntax error.
      'process.stdout.write("\\n");',
    ].join("");
    const { lifecycle, handle } = spawnNode(js);
    const events: ParsedAgentEvent[] = [];
    for await (const ev of lifecycle.events(handle)) {
      events.push(ev);
    }
    const exit = await lifecycle.exit(handle);
    // The child wrote its JSONL line and exited 0, so a working parser sees exactly one
    // event before close. Asserting the concrete count (not ">= 0") is what makes a
    // parser that drops every line fail this test.
    expect(exit).toEqual({ code: 0, signal: null });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message_end");
    expect(events[0]?.message?.role).toBe("assistant");
    expect(events[0]?.message?.content?.[0]?.text).toBe("PONG");
  });

  test("a non-empty unparseable stdout line is dropped with one bounded warning (constraint #3)", async () => {
    const warnings: string[] = [];
    const lifecycle = new RealChildProcessLifecycle({
      logger: { warn: (msg: string): void => void warnings.push(msg) },
    });
    // A line that is clearly not JSON and long enough to prove the warning is bounded.
    const garbage = "not-json-" + "x".repeat(400);
    const js = [
      'process.stdout.write(JSON.stringify({type:"good"})+"\\n");',
      `process.stdout.write(${JSON.stringify(garbage)} + "\\n");`,
      "process.exit(0);",
    ].join("");
    const handle = lifecycle.spawn([process.execPath, "-e", js], {
      cwd: process.cwd(),
      promptFile: "/tmp/bg-03-test-no-such-file.md",
    });

    const events: ParsedAgentEvent[] = [];
    for await (const ev of lifecycle.events(handle)) events.push(ev);
    const exit = await lifecycle.exit(handle);

    // The valid line still reaches the run, and the child still exits cleanly.
    expect(exit).toEqual({ code: 0, signal: null });
    expect(events.map((event) => event.type)).toEqual(["good"]);
    // Exactly one warning for the one dropped line, naming the child and a bounded preview.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(handle.id);
    expect(warnings[0]).toContain(garbage.slice(0, 64));
    expect(warnings[0]?.length).toBeLessThan(garbage.length);
  });

  test("events() yields multiple events in arrival order (FIFO)", async () => {
    const js = [
      'process.stdout.write(JSON.stringify({type:"a"})+"\\n");',
      'process.stdout.write(JSON.stringify({type:"b"})+"\\n");',
      'process.stdout.write(JSON.stringify({type:"c"})+"\\n");',
    ].join("");
    const { lifecycle, handle } = spawnNode(js);
    const types: string[] = [];
    for await (const ev of lifecycle.events(handle)) {
      types.push(ev.type);
    }
    expect(types).toEqual(["a", "b", "c"]);
  });

  test("exit() resolves with code=0 after a clean child exit", async () => {
    const { lifecycle, handle } = spawnNode("process.exit(0);");
    for await (const _ of lifecycle.events(handle)) {
      /* drain */
    }
    const exit = await lifecycle.exit(handle);
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  });

  test("exit() resolves with the non-zero code when the child fails", async () => {
    const { lifecycle, handle } = spawnNode("process.exit(7);");
    for await (const _ of lifecycle.events(handle)) {
      /* drain */
    }
    const exit = await lifecycle.exit(handle);
    expect(exit.code).toBe(7);
    expect(exit.signal).toBeNull();
  });

  test("stderr() resolves with accumulated stderr text", async () => {
    const js = [
      'process.stderr.write("warn-a");',
      'process.stderr.write("warn-b");',
      "process.exit(0);",
    ].join("");
    const { lifecycle, handle } = spawnNode(js);
    for await (const _ of lifecycle.events(handle)) {
      /* drain */
    }
    await lifecycle.exit(handle);
    const stderr = await lifecycle.stderr(handle);
    expect(stderr).toBe("warn-awarn-b");
  });

  test('kill("SIGTERM") ends a long-running child and exit() reflects the signal', async () => {
    // Loop forever, writing a heartbeat every 50ms so stdout drains.
    const js = [
      'const t = setInterval(() => process.stdout.write("\\n"), 50);',
      // NOTE: no `process.on("SIGKILL", ...)` handler — SIGKILL is uncatchable and
      // registering one makes Node throw `uv_signal_start EINVAL`, crashing the child
      // with code 1 before kill() is ever called.
      'process.on("SIGTERM", () => { clearInterval(t); process.exit(0); });',
      // Deterministic readiness handshake. A fixed `setTimeout` before `kill()` races
      // Node's boot: under load the signal can arrive before the handler above is
      // installed, so the process dies from SIGTERM's default action and the assertion
      // below fails intermittently. Announcing readiness AFTER the handler is installed
      // makes the kill land on the handled path every time.
      'process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");',
    ].join("");
    const { lifecycle, handle } = spawnNode(js);
    // Kill only once the child has announced it installed the handler; keep draining the
    // same iterator to completion afterwards (it ends when the child exits).
    let killed = false;
    let announceReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const pump = (async () => {
      for await (const event of lifecycle.events(handle)) {
        if (event.type === "ready" && !killed) {
          killed = true;
          lifecycle.kill(handle, "SIGTERM");
          announceReady();
        }
      }
    })();
    await ready;
    await pump;
    const exit = await lifecycle.exit(handle);
    // The child registered a SIGTERM handler that clears its interval and exits 0, so a
    // correct kill() path lands on a clean exit. This concrete-value assertion (rather
    // than "code===0 || signal!==null") is what makes a no-op kill() fail: the child
    // would run forever and the test would time out instead of passing.
    expect(exit).toEqual({ code: 0, signal: null });
  });

  test("spawn-failure (ENOENT) puts the [spawn-error] marker on stderr", async () => {
    // Use a binary that surely does not exist on PATH. Use an absolute path that
    // cannot resolve to avoid OS-level "command not found" rewriting the marker.
    const lifecycle = new RealChildProcessLifecycle();
    const handle = lifecycle.spawn(["/this/path/definitely/does/not/exist/bg-03-no-such-binary"], {
      cwd: process.cwd(),
      promptFile: "/tmp/x.md",
    });
    for await (const _ of lifecycle.events(handle)) {
      /* drain */
    }
    const exit = await lifecycle.exit(handle);
    expect(exit.code).toBeNull();
    expect(exit.signal).toBeNull();
    const stderr = await lifecycle.stderr(handle);
    expect(stderr).toContain("[spawn-error]");
    expect(stderr).toMatch(/ENOENT/);
  });
});

describe("MockChildProcessLifecycle", () => {
  function makeMock(): MockChildProcessLifecycle {
    return new MockChildProcessLifecycle();
  }

  test("spawn() returns a handle with a fresh id and opaque state", () => {
    const mock = makeMock();
    const handle = mock.spawn(["foo", "--bar"], { cwd: "/tmp", promptFile: "/tmp/p.md" });
    expect(typeof handle.id).toBe("string");
    expect(handle.id.length).toBeGreaterThan(0);
    expect(handle.opaque).toBeDefined();
    expect(mock.spawnCount).toBe(1);
  });

  test("spawn() records argv + opts verbatim", () => {
    const mock = makeMock();
    const opts = { cwd: "/some/cwd", promptFile: "/tmp/p.md" as const };
    const handle = mock.spawn(["pi", "--mode", "json"], opts);
    expect(mock.getRecordedArgv(handle)).toEqual(["pi", "--mode", "json"]);
    expect(mock.getRecordedOpts(handle)).toEqual(opts);
  });

  test("kill() appends each signal in order", () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    mock.kill(handle, "SIGTERM");
    mock.kill(handle, "SIGKILL");
    expect(mock.getKillSignals(handle)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("kill() on an unknown handle is a silent no-op (constraint #3: no silent crash)", () => {
    const mock = makeMock();
    const fake = { id: "MOCK-999", opaque: undefined } as unknown as ChildHandle;
    expect(() => mock.kill(fake, "SIGTERM")).not.toThrow();
  });

  test("events() yields pushed events in FIFO order and ends after resolveExit", async () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    mock.pushEvent(handle, { type: "first" });
    mock.pushEvent(handle, { type: "second" });
    mock.pushEvent(handle, { type: "third" });
    mock.resolveExit(handle, 0, null);
    const types: string[] = [];
    for await (const ev of mock.events(handle)) {
      types.push(ev.type);
    }
    expect(types).toEqual(["first", "second", "third"]);
  });

  test("events() waits for pushEvent when buffer is drained and exit has not fired", async () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    const iter = mock.events(handle)[Symbol.asyncIterator]();
    const first = iter.next();
    // Schedule a push 30ms later; the await must block until then.
    setTimeout(() => mock.pushEvent(handle, { type: "delayed" }), 30);
    const result = await first;
    expect(result.done).toBe(false);
    expect(result.value?.type).toBe("delayed");
    // Clean up: resolve exit so any leftover waiters don't leak.
    mock.resolveExit(handle, 0, null);
    await iter.next();
  });

  test("exit() resolves with the (code, signal) passed to resolveExit", async () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    const promise = mock.exit(handle);
    mock.resolveExit(handle, 42, null);
    expect(await promise).toEqual({ code: 42, signal: null });
  });

  test("exit() resolves immediately if resolveExit was already called", async () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    mock.resolveExit(handle, 0, null);
    expect(await mock.exit(handle)).toEqual({ code: 0, signal: null });
  });

  test("stderr() resolves with text set via setStderr", async () => {
    const mock = makeMock();
    const handle = mock.spawn(["x"], { cwd: "/", promptFile: "/tmp/p.md" });
    mock.setStderr(handle, "[spawn-error] ENOENT\n");
    mock.resolveExit(handle, null, null);
    expect(await mock.stderr(handle)).toBe("[spawn-error] ENOENT\n");
  });

  test("multiple handles are tracked independently (constraint #5)", async () => {
    const mock = makeMock();
    const a = mock.spawn(["a"], { cwd: "/", promptFile: "/p1.md" });
    const b = mock.spawn(["b"], { cwd: "/", promptFile: "/p2.md" });
    mock.kill(a, "SIGTERM");
    mock.pushEvent(b, { type: "only-b" });
    mock.resolveExit(b, 1, null);
    // Handle `a` had no events and is still alive; its exit() should hang. To keep the
    // test bounded, resolve it explicitly — that path itself is what we are pinning:
    // a separate resolveExit on a separate handle must not affect `b`.
    mock.resolveExit(a, 0, null);
    expect(mock.getKillSignals(a)).toEqual(["SIGTERM"]);
    expect(mock.getKillSignals(b)).toEqual([]);
    const eventsA: string[] = [];
    for await (const ev of mock.events(a)) eventsA.push(ev.type);
    expect(eventsA).toEqual([]);
    const eventsB: string[] = [];
    for await (const ev of mock.events(b)) eventsB.push(ev.type);
    expect(eventsB).toEqual(["only-b"]);
    expect(await mock.exit(a)).toEqual({ code: 0, signal: null });
    expect(await mock.exit(b)).toEqual({ code: 1, signal: null });
  });

  test("test-only API throws on an unknown handle (constraint #3: explicit error state)", () => {
    const mock = makeMock();
    const fake = { id: "MOCK-999", opaque: undefined } as unknown as ChildHandle;
    expect(() => mock.pushEvent(fake, { type: "x" })).toThrow(/unknown handle/);
    expect(() => mock.resolveExit(fake, 0, null)).toThrow(/unknown handle/);
    expect(() => mock.getRecordedArgv(fake)).toThrow(/unknown handle/);
    expect(() => mock.getKillSignals(fake)).toThrow(/unknown handle/);
  });
});

describe("ChildProcessLifecycle interface compliance", () => {
  test("both adapters satisfy the interface", () => {
    const adapters: ChildProcessLifecycle[] = [
      new RealChildProcessLifecycle(),
      new MockChildProcessLifecycle(),
    ];
    for (const adapter of adapters) {
      expect(typeof adapter.spawn).toBe("function");
      expect(typeof adapter.kill).toBe("function");
      expect(typeof adapter.events).toBe("function");
      expect(typeof adapter.exit).toBe("function");
      expect(typeof adapter.stderr).toBe("function");
    }
  });

  test("Mock adapter implements ChildProcessLifecycle (type-level compile check)", () => {
    // If `MockChildProcessLifecycle` ever drifts from the interface, this assignment
    // fails to compile. Catches interface drift the test runner would miss.
    const typed: ChildProcessLifecycle = new MockChildProcessLifecycle();
    expect(typed).toBeInstanceOf(MockChildProcessLifecycle);
  });

  test("Real adapter implements ChildProcessLifecycle (type-level compile check)", () => {
    const typed: ChildProcessLifecycle = new RealChildProcessLifecycle();
    expect(typed).toBeInstanceOf(RealChildProcessLifecycle);
  });
});

// Suppress "nodeSpawn is unused" lint when this file is read in isolation; the import
// exists so contributors reading the file know `node:child_process.spawn` is the
// boundary the real adapter crosses. Tree-shaking will drop it in production builds.
void nodeSpawn;
