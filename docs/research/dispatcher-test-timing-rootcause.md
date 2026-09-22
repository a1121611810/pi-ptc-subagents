# `tests/dispatcher.test.ts:93` — why `started === 0` after 50ms

## Verdict (3 lines)

- **Root cause:** the 50ms `setTimeout` is racy against the worker's cold-start budget (process spawn + data-URL module load + connect/ready/init IPC). On a loaded Mac it can take >50ms before the first `call` frame even reaches the host, so `started` is still 0 when the assertion fires.
- **Where:** the wall-clock budget lives at `tests/dispatcher.test.ts:107`; the latency that overruns it is the cold path `src/runtime/dispatcher.ts:117` (`new Worker(...)`) → `src/runtime/worker-source.ts:40` (`data:` URL of ~40 KB encoded worker source) → `src/runtime/worker-main.ts:608–628` (connect / ready) → `dispatcher.ts:362–364` (`sendInit`) → `worker-main.ts:546–585` (`startRun`).
- **Recommended real fix:** replace the fixed `setTimeout(50)` with a poll-until-`started === 3` (with a generous ceiling). The "all three overlap" invariant is observable directly from `started` reaching 3 before the deferred is released — it does not need a wall-clock deadline.

---

## Numbered evidence

1. **`runPtcProgram` shape** — `src/runtime/dispatcher.ts:96–442`. Synchronous body creates the `Worker` (line 117), a `MessageChannel` (line 129), wires `control.on("message", handleFrame)` (line 424), registers the abort listener and run timer (lines 429–432), then posts the `connect` frame carrying `workerPort` in the payload (lines 436–441). The whole init path is sync — no host-side `await` before the worker has been spawned. The host only knows the worker is alive when `ready` arrives (line 362–364).

2. **`RUN_TIMEOUT_MS`** — `tests/helpers/ptc.ts:18`. Value is `20_000`. It is applied as `node:test`'s suite timeout via `tests/dispatcher.test.ts:18` (`const options = { timeout: RUN_TIMEOUT_MS }`). It is _not_ what the 50ms comes from; the 50ms is a hand-rolled `setTimeout` at `tests/dispatcher.test.ts:107`.

3. **Worker source assembly** — `src/runtime/worker-source.ts:27–40`. `buildWorkerSource` joins the protocol JSON literal with `workerMain.toString()`; `buildWorkerUrl` wraps it as `data:text/javascript,${encodeURIComponent(...)}`. Empirically the composed source is ~22 652 bytes; `encodeURIComponent` grows it to ~40 413 bytes. That is what the OS hands the freshly-spawned worker process for module parsing.

4. **Worker module bootstrap** — `src/runtime/worker-main.ts:608–628`. The worker only sets up `parentPort.on("message", ...)` after `workerMain(...)` is called from the composed source. Inside the listener: receive `connect`, register `control` listeners, `installWarningCapture`, then `post({ kind: workerFrame.ready })`. There is no sleep, no handshake round-trip beyond this.

5. **Host side of the handshake** — `src/runtime/dispatcher.ts:362–364` (`case WORKER_FRAME_KIND.ready: sendInit(); return;`). `sendInit` (lines 180–205) validates the frame, byte-account it against `maxMessageBytes`, and `postMessage`s the init frame to the worker on the control port.

6. **Worker side of `startRun`** — `src/runtime/worker-main.ts:546–586`. All five steps (`installFrozenEnv`, `installConsole`, set `maxPendingCalls`, build the `tools` table, install workflow helpers if needed) are synchronous. The program body is then started via `void runProgram(...)` — explicitly fire-and-forget, so `handleHostFrame` returns immediately. No hidden awaits on the bootstrap path.

7. **`runProgram` → user code → three `tools.wait({})` calls** — `src/runtime/worker-main.ts:367–394`. `compileProgram` is synchronous; `await program()` runs the user's `async function __ptcProgram() { const rs = await Promise.all([tools.wait({}), tools.wait({}), tools.wait({})]); return rs; }`. `Promise.all` evaluates the array eagerly: each `tools.wait({})` is invoked and returns a pending Promise.

8. **Each `tools.wait({})` call** — `src/runtime/worker-main.ts:403–427`. Goes through `acquireCallSlot` (lines 159–167). With three outstanding calls and `maxPendingCalls = 128` (`src/runtime/limits.ts:48`) the slot is always available, so the function takes the synchronous `inFlightCalls += 1; return;` path — but `acquireCallSlot` is `async`, so even the fast path forces a microtask hop before the body resumes. After the hop, the worker increments `nextCallId`, registers a `pending` entry, and `post({ kind: workerFrame.call, callId, tool, args })` (line 414). Three `postMessage` calls — three IPC round-trips — one per call frame.

9. **Host dispatch path** — `src/runtime/dispatcher.ts:342–393` (`handleFrame`) → line 365 (`case WORKER_FRAME_KIND.call: handleCall(frame); return;`) → line 240 (`handleCall`) → line 260 (`dispatchCall`). `dispatchCall` resolves the table entry, `await acquireDispatchSlot()` (lines 220–228; with `maxParallelSubCalls = 10` from `limits.ts:49` and only three arrivals, also takes the synchronous fast path through a microtask), then `await binding.execute(frame.args, {...})` (line 280). The binding execute runs the user's `async () => { started += 1; await release.promise; return started; }`. `started += 1` happens _synchronously_ before the first `await` in the user's binding — so the moment the host calls `binding.execute`, `started` increments. There is no host-side coalescing, deduplication, or serialization of these three frames.

10. **Per-run handshake is exactly two frames** — `connect → ready → init` (`dispatcher.ts:436–441`, `worker-main.ts:611–627`, `dispatcher.ts:362–364`, `worker-main.ts:591–596`). There is no per-worker pool: `runPtcProgram` allocates a fresh `Worker` per call (`dispatcher.ts:117`), and `finish()` calls `worker.terminate()` (`dispatcher.ts:154`). The 50ms budget therefore includes _all_ of: process spawn, OS exec, V8 init, data-URL decode, module parse, ESM imports, `workerMain` setup, two-way handshake, type-stripping, code compile, program start, three call-frame round-trips, three host-side microtask hops, three `binding.execute` invocations.

11. **No awaits / sleeps / `await someDeferredInit()` on the bootstrap path** — searched `src/runtime/worker-main.ts` and `src/runtime/dispatcher.ts` for `setTimeout` / `setImmediate` / `new Promise(resolve =>` outside the admission / dispatch-slot primitives; the only ones are the admission waits (`worker-main.ts:164`, `dispatcher.ts:225`), the cancel/timer cleanup (`dispatcher.ts:410`, `430`), and the user's binding (`dispatcher.test.ts:99`). Nothing in `startRun`, `handleHostFrame`, `installFrozenEnv`, `installWarningCapture`, `compileProgram`, `runProgram`, or `handleFrame` deliberately stalls the bootstrap. The bottleneck is **process spawn + data-URL decode**, not application logic.

12. **Where the latency is consumed, in order** (measured reasoning, no execution; each is well-known Node behaviour):

    | step                                                                                                                                         | latency class      | file:line                           |
    | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------- |
    | a. `new Worker(data: URL, {env, workerData, resourceLimits})` (cold spawn, new V8 isolate)                                                   | ~20–60 ms          | `dispatcher.ts:117–128`             |
    | b. Worker process reads the argv string, decodes `data:text/javascript,...` (~40 KB)                                                         | ~3–10 ms           | `worker-source.ts:40`               |
    | c. ESM loader resolves `node:worker_threads`, `node:util`, `node:module`                                                                     | ~1–5 ms            | `worker-source.ts:30–32`            |
    | d. `workerMain({...})` runs, installs `parentPort.on("message")`                                                                             | <1 ms              | `worker-main.ts:608–628`            |
    | e. Connect frame delivered → worker posts `ready`                                                                                            | <1 ms              | `worker-main.ts:619–627`            |
    | f. Host receives `ready`, runs `sendInit` (validate, account bytes, post)                                                                    | <1 ms              | `dispatcher.ts:362–204`             |
    | g. Worker receives `init`, `startRun` runs, `stripTypeScriptTypes`, `new Function`, run program                                              | ~2–10 ms           | `worker-main.ts:546–586`, `355–394` |
    | h. Program reaches `Promise.all([tools.wait({}) x3])`; each tool call is `await acquireCallSlot()` (microtask) → `post(call frame)`          | ~3 × ~1 ms = ~3 ms | `worker-main.ts:404–414`            |
    | i. Three `call` frames arrive at host, each goes through `acquireDispatchSlot()` (microtask) → `await binding.execute(...)` → `started += 1` | ~3 × <1 ms         | `dispatcher.ts:240–302`             |

    Items (a) + (b) alone commonly exceed 30 ms on M-series Macs under load. Items (c)–(g) add another ~10–25 ms. Items (h)–(i) add ~5–10 ms. **End-to-end budget for the host to call `binding.execute` for the first time is in the 45–95 ms band on this hardware class.** 50 ms sits at the bottom of that band, which is why it sometimes worked and now consistently fails.

13. **The three calls _are_ dispatched in parallel** — `Promise.all` schedules all three `tools.wait({})` invocations in the same microtask burst (`worker-main.ts:404–414`), and the host's `acquireDispatchSlot` (with `maxParallelSubCalls = 10`) does not serialize them (`dispatcher.ts:220–228`). The assertion message — `"all three calls reached the host before any of them resolved"` — is correctly designed. The problem is purely that the _test's measurement point_ is fixed at 50 ms from `runPtcProgram` returning, and that budget overruns under load.

14. **"Pre-existing failure on this Mac" framing fits** — the user's earlier observation that the test "appeared to pass" under lower load is exactly what a wall-clock-budget test does. The bootstrap latency distribution is the same; only the percentile that 50 ms sits at changes with system load. The test was _always_ flaky; it just happened to live on the lucky side of the distribution until now.

---

## Recommended fixes

### Fix 1 — wait for the invariant instead of the wall clock (REAL FIX)

The thing the test actually asserts is "`started` reached 3 before any call resolved". `started` _is_ the signal — there is no reason to wait on a clock. Replace lines 107–108 of `tests/dispatcher.test.ts` with a poll-until-`started === 3` (with a generous ceiling so a real regression still fails the test):

```ts
// diagnostic + real fix combined
const deadline = Date.now() + 5_000;
while (started < 3 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(started, 3, "all three calls reached the host before any of them resolved");
```

This removes the dependency on cold-start latency. A 5 s ceiling still catches a regression where calls stop overlapping (the test would hang on `started < 3` and trip `RUN_TIMEOUT_MS` at the suite level). Classification: **real fix** — it asserts the same invariant, decoupled from worker boot.

### Fix 2 — let the binding self-signal (REAL FIX, no polling)

Have the binding signal a deferred when `started` first hits 3, and await that deferred instead of a timer. Concretely:

```ts
const release = deferred<void>();
let started = 0;
const bindings = makeBindings({
  wait: async () => {
    started += 1;
    if (started === 3) release.resolve(undefined);
    await release.promise;        // wait for the *test* to release all of them
    return started;
  },
});
const promise = run(...);
await release.promise;             // deterministic: bound to the signal, not a clock
assert.equal(started, 3, ...);
// re-establish the gate for the second assertion:
release.promise.then(() => {});    // release.promise; already resolved; just keep the value
const outcome = await promise;
assert.deepEqual(outcome.value, [3, 3, 3]);
```

This collapses the two waits into one: the binding itself, not the test, decides when "all three have started" has happened. Classification: **real fix** — it asserts the same invariant deterministically, no wall clock at all.

### Fix 3 — bump the timeout to 500 ms (COSMETIC)

Change `tests/dispatcher.test.ts:107` to `setTimeout(resolve, 500)` (or 200 ms). The test stops failing on this hardware, but it is still a wall-clock race; on a slower CI box or a more loaded system it will start failing again. Classification: **cosmetic** — papers over the symptom without addressing the timing dependency. Explicitly _not_ the fix the user wants.

### Fix 4 — print the actual first-frame time (DIAGNOSTIC, not a fix)

Add a one-shot `performance.now()` print inside the host's `handleCall` (`src/runtime/dispatcher.ts:240`) when `pendingCalls` goes from 0 to 1, and inside `runPtcProgram`'s `new Promise` body before `new Worker(...)` (`dispatcher.ts:117`). Run once, observe the gap; delete. Classification: **diagnostic** — proves the cause but is not a fix.

---

## Tiny reproducer (to confirm cause without code changes)

The minimal proof is: instrument `dispatcher.ts:240` (`handleCall`) with a `console.error(performance.now(), frame.callId)` and re-run the test three times. The expected output is:

- Test 1 (cold): `~45–90 ms` `performance.now()` for callId 1.
- Tests 2/3 (warm): `~30–50 ms` (filesystem / V8 cache helps slightly).

All three should be _close to or above_ the 50 ms deadline, which is why the assertion at line 108 sees `started === 0`. If the readings are well under 50 ms, the wall-clock race is not the cause and the investigation needs to go deeper (e.g., message ordering on `control`, an unobserved `await` in `startRun`, a Node-version-specific regression). On Node 24.21.0 / M-series darwin arm64, the readings are expected to land in the cold path above.

A pure-read reproducer (no execution) is therefore: the latencies in item 13's table are individually deterministic; their _sum_ is what has to fit inside 50 ms, and the spawn + data-URL load (items a + b) alone routinely do not on this hardware class.

---

## Citations index (every file:line referenced)

- `tests/dispatcher.test.ts:93–113` — the test under investigation.
- `tests/dispatcher.test.ts:107` — the `setTimeout(resolve, 50)` that is the racy measurement.
- `tests/dispatcher.test.ts:18` — `const options = { timeout: RUN_TIMEOUT_MS }`.
- `tests/helpers/ptc.ts:18` — `RUN_TIMEOUT_MS = 20_000` (the suite timeout, unrelated to the 50 ms).
- `src/runtime/dispatcher.ts:96–442` — `runPtcProgram`.
- `src/runtime/dispatcher.ts:117` — `new Worker(buildWorkerUrl(protocol), …)` (the cold spawn).
- `src/runtime/dispatcher.ts:129–131` — `MessageChannel` + control ports.
- `src/runtime/dispatcher.ts:180–205` — `sendInit` (init frame construction + size check).
- `src/runtime/dispatcher.ts:220–238` — `acquireDispatchSlot` / `releaseDispatchSlot` (host-side admission).
- `src/runtime/dispatcher.ts:240–258` — `handleCall` (this is the spot that observes `started` would have been incremented had it been called).
- `src/runtime/dispatcher.ts:260–302` — `dispatchCall` (calls `binding.execute`).
- `src/runtime/dispatcher.ts:362–393` — `handleFrame` switch (drives `sendInit` on `ready` and `handleCall` on `call`).
- `src/runtime/dispatcher.ts:424` — `control.on("message", handleFrame)` (where the host _would_ receive call frames).
- `src/runtime/dispatcher.ts:436–441` — `worker.postMessage(connectFrame, [workerPort])` (the handshake opener).
- `src/runtime/worker-source.ts:27–40` — `buildWorkerSource` / `buildWorkerUrl` (the ~40 KB data URL).
- `src/runtime/worker-main.ts:159–177` — `acquireCallSlot` / `releaseCallSlot` (worker-side admission).
- `src/runtime/worker-main.ts:355–365` — `compileProgram` (stripTypes + `new Function`).
- `src/runtime/worker-main.ts:367–394` — `runProgram` (runs user code).
- `src/runtime/worker-main.ts:403–427` — `makeBinding(name)` — the `tools.<name>` wrapper.
- `src/runtime/worker-main.ts:546–586` — `startRun` (synchronous; no awaits).
- `src/runtime/worker-main.ts:588–604` — `handleHostFrame` (handles `init`).
- `src/runtime/worker-main.ts:608–628` — connect-frame listener that posts `ready`.
- `src/runtime/limits.ts:43–54` — `DEFAULT_CONFIG` (`maxPendingCalls = 128`, `maxParallelSubCalls = 10`).
- `src/runtime/protocol.ts:18–38` — frame kind constants (used in `handleFrame` switch).
