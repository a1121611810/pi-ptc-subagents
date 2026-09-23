# PTC worker pool, and the hoisted-image wire shape

Per-run cold-start of a `worker_threads` Worker was the largest repeated cost in
DSH-style PTC mode: every `ptc_run_code` / `ptc_workflow` paid the full V8
spin-up, module-graph load and F3 env rehydration, while model-driven programs in
the same agent turn typically fire several PTC runs back-to-back. We now keep one
worker per surface (`run_code` and `workflow`) warm across the parent turn.

The same effort examined whether hoisted images should cross the host↔worker wire
as raw `ArrayBuffer` instead of base64. **They should not** — the wire is
lossless JSON in the direction that matters, and a transferList of raw bytes
cannot survive that contract. The rejected options are recorded below because a
future reader will otherwise ask why nobody reached for `MessagePort`'s zero-copy
primitive.

Status: accepted (2026-09-23). Wire-visible: nothing. Program-visible: nothing
(the image representation a PTC program sees is unchanged). Public API:
`runPtcProgram()` gains an optional `pool` field; absent opts the call out of
pooling.

## Referencing this ADR

Two lists below are numbered, and a bare `§N` in a source comment, a test name or
a commit message means **entry N of the `## Decision` list** — the reading the
other ADRs already use (ADR-0013 §1 / §5, ADR-0014 §2 are cited the same way).
The change inventory under `## What we add` is labelled `W-1`…`W-6` and is
referred to only by those labels, so it can never be mistaken for a decision
number. Diagnostics channels are cited as `ADR-0017 Addendum`. Each decision
entry carries its own `§N` badge, so `grep -n '§5'` lands on the entry a comment
means rather than on whichever list happened to be nearby.

## What we add

- **W-1** — A per-turn `TurnPools` holder: one `WorkerPool` per surface, created
  lazily by the first PTC run of the turn, passed to `runPtcProgram()` via
  `RunPtcProgramOptions.pool`, and retired by the extension's `turn_end` hook.
  Default `poolSize` 4.
- **W-2** — Pool capacity semantics: an acquire when the pool is at capacity
  queues the caller behind a FIFO wait list. `poolAcquireTimeoutMs` (default
  30s) bounds the wait; on timeout the run fails with `kind: workerExit` and a
  message naming the pool (§4 records the exact text).
- **W-3** — Reset handshake: the existing `ready` worker frame keeps its meaning
  for cold-start ("booted") and acquires the additional meaning "this worker has
  cleared per-run state and is ready for the next `init` frame" for warm reuse.
  No new frame kind.
- **W-4** — SELF-CONTAINMENT RULE retired. The `data:` URL composition in
  `src/runtime/worker-source.ts` (built from `Function.prototype.toString()` of
  `workerMain`) is replaced by a real `dist/worker.js` entry produced by the
  bundler's multi-entry mode. The worker is loaded by file path, so V8's code
  cache and the Node module cache survive across reuse — the precondition for
  any pool to amortise startup cost.
- **W-5** — `node:diagnostics_channel` integration: three internal channels
  publish from inside the pool and the hoist path — `ptc:pool:acquire-latency`,
  `ptc:worker:reset-time`, `ptc:image:hoist-bytes`. No public metrics API;
  subscribers are e2e tests and future instrumentation. (`WorkerPool.stats()`
  exists and is stable enough for tests and internal diagnosis to read — see the
  Addendum for why that is not the same claim.)
- **W-6** — `serializedBytes` learns about binary leaves. `JSON.stringify`
  reports `{}` for an `ArrayBuffer`, so a frame carrying binary payload would
  slip past the `maxMessageBytes` guard. The helper now walks the value and sums
  text leaves (via `JSON.stringify`) plus `ArrayBuffer` / typed-array
  `byteLength`. This is defence for future binary-carrying bindings; today's
  frames are text plus base64, so the binary path is exercised by unit tests
  rather than by a live image hoist.

## Decision

**Pool**

1. **§1 · Pool ownership — explicit, per turn.** `runPtcProgram()` accepts an
   optional `pool: WorkerPool`; absent = no pooling (the original cold-start
   path). The extension owns one `TurnPools` holder, its tools read
   `getPool()` **per execute** (the holder is swapped at each turn boundary, so
   a registration-time capture would pin a dead pool), and the `turn_end` hook
   retires the outgoing holder. Lazy creation is why a turn that never runs a
   PTC program never spawns a worker. There is no implicit turn context.
2. **§2 · Pool granularity — per parent turn + per surface.** `run_code` and
   `workflow` workers do not share a pool: their worker surfaces differ
   (`installWorkflowHelpers` is conditional in `worker-main.ts`), and one pool
   per surface keeps ownership simple. The workers carry no surface state — each
   run's `init` frame names its surface — so the split is about ownership, not
   correctness.
3. **§3 · Pool capacity & acquire timeout — poolSize=4, poolAcquireTimeoutMs=30s.**
   `poolSize` is decoupled from `maxParallelSubCalls` because pool capacity is
   "resident workers" while `maxParallelSubCalls` is "in-flight calls" — two
   different ceilings. `poolAcquireTimeoutMs` is decoupled from `timeoutMs`
   because acquire-wait is bounded by the pool's responsiveness, not the run's
   overall deadline.
4. **§4 · Pool full — queue, not reject.** An acquire when the pool is at
   capacity joins a FIFO wait list. Timeout fails the run with
   `kind: workerExit` and the message the dispatcher composes:

   `pool acquire failed: pool acquire timed out after ${acquireTimeoutMs} ms`

   Two pieces make that string, and both matter to anyone matching on it: the
   pool throws `pool acquire timed out after ${acquireTimeoutMs} ms` — a space
   before `ms`, and the resolved bound rather than a rounded one (the default
   `30_000` renders as `30000`) — and the dispatcher wraps whatever `acquire()`
   rejected with into a `pool acquire failed: ` prefix. The semantic matches
   `acquireDispatchSlot` (queue, not reject).

5. **§5 · Reset handshake — extend `ready`.** The worker's internal state machine is
   `CREATED → BOOTING → READY ↔ RUNNING`; `READY → RUNNING` is receipt of an
   `init` frame; `RUNNING → READY` is worker-driven after `flushPendingCalls()`
   and a restored `globalThis` / `process.env`, and the frame it posts is also
   what tells the host the worker will accept the next `init`.

   What this handshake does **not** do is isolate one run from the next, and reading
   it that way is the error §10 exists to correct. The reset is scoped to the run
   that produced it: if the host abandoned that run, it was superseded, and its
   `reset()` is a no-op by design (§10(a)) — it clears nothing at all. The isolation
   warm reuse depends on is delivered by the _next_ run's init-side clearing, which is
   unconditional on every run start (§10(d)). The reset's real job is the handshake:
   tell the host "this worker is free, send the next `init`".

6. **§6 · Idle workers are `unref()`-ed.** A warm worker parked in the pool must not
   keep the pi process alive; taking one back into flight `ref()`s it again, so
   an in-flight run always pins the loop. This is also the safety net for a
   `turn_end` that never fires: an orphaned idle worker cannot outlive the host.
7. **§7 · Worker source — real `.js` file.** The bundler (rolldown) outputs
   `dist/worker.js` alongside `dist/index.js`, and `buildWorkerUrl()` returns
   `pathToFileURL()` instead of a `data:` URL, so V8's code cache and Node's
   module cache survive warm reuse. That retires the **bootstrap** use of
   `node:module:stripTypeScriptTypes`: the `data:` URL carried
   `Function.prototype.toString()` of `workerMain`, so the worker had to strip
   this package's own source at runtime, whereas the dual-entry build strips this
   package's types at build time and the worker entry is a real module.

   The runtime dependency itself is **kept**. `worker-entry.ts` still imports
   `stripTypeScriptTypes` from `node:module` and passes it into `workerMain`,
   because the **PTC program is TypeScript the model submits at run time** — data,
   not build output — and has to be type-stripped inside the worker before it can
   run. That is `compileProgram`'s path, not the bootstrap's.

**Image wire shape**

8. **§8 · Hoisted images stay base64 end to end.** `PtcImage` keeps
   `{data: string, mimeType: string}` — the shape pi's own `read` tool emits —
   and the tool layer forwards `data` to pi's `ImageContent` without
   re-encoding. `captureImages` normalises the one alternative a binding might
   produce (`bytes: ArrayBuffer`, which no pi tool emits today) to base64 once,
   host-side, so `PtcImage` has exactly one downstream representation.
9. **§9 · A failed run attaches nothing.** ADR-0014 §2 stands unamended.

**Run isolation on a warm worker**

10. **§10 · Run isolation and cancel semantics on a warm worker.** One worker serves
    several runs, and a run the host stops waiting for does not stop executing: the
    dispatcher closes that run's control port and returns the worker to the pool
    (`finish()` → `pool.release()`), without waiting for the program to unwind.
    "Superseded" below means exactly that — the host handed the worker to a later run
    while the earlier run's program was still in the isolate. The rules below are what
    keeps such a worker hermetic and its cancellation predictable; they are recorded
    here because a warm worker makes each of them load-bearing, and several of them
    are only visible in the code that implements them.

    - **(a) A run's reset is scoped to its own run ordinal.** Each accepted `init`
      increments `runGeneration` and hands that number to the run it starts;
      `reset(generation, port)` returns early unless the worker is still `RUNNING`
      **and** `generation === runGeneration`. _Why:_ a superseded run must not clear
      the newer run's calls, globals or bookkeeping, and must not post `ready` — the
      host reads `ready` as "the current run settled, send the next `init`", so a
      stranger's `ready` is what makes the same program execute twice. Ownership is
      captured at `init` time rather than read off the shared `state`, because `state`
      belongs to whoever owns the worker now. _Position:_ `worker-main.ts` —
      `runGeneration`, `reset(generation, port)`, and the `init` branch of
      `handleHostFrame`.
    - **(b) A run's frames leave only through the port it captured at `init`.** `post()`
      defaults to the current `control`, but a run's own `log` / `narration` /
      `phase` / `call` / `result` / `error` and its closing `ready` are all posted with
      the port that run's `init` arrived on. _Why:_ the host settles its run on any
      `result` it reads on its port (`handleFrame` → `finish()`), so an abandoned run's
      terminal frame arriving on the next run's port would settle a run whose program
      never finished. The abandoned run's port is closed on the host's side, so those
      frames fail to send and `post` swallows the throw — dropped exactly where nobody
      owns them any more. _Position:_ `worker-main.ts` — `post(frame, port)` and its call
      sites (`runProgram`, `installConsole`, `makeBinding`, `installWorkflowHelpers`,
      `reset`); only realm-level frames — the connect handshake's own `ready` and warning
      `log`s, which belong to the worker rather than to a program — use the default.
    - **(c) A port's `close` flushes in-flight calls only while that port is still the
      current control.** The `close` listener installed per `connect` means "the host is
      gone, no `callResult` can arrive any more"; it must flush only for the port that is
      still `control`, so a superseded run's late `close` cannot reject the next run's
      calls. _Why:_ `finish()` closes the control port on _every_ ending, a cancel
      included, and then releases the worker to the pool — so run N's port closes as a
      matter of course while run N+1 is already in flight, and an unguarded flush would
      fail run N+1 with `closedError()` ("the PTC control channel closed before the call
      completed") for a channel that is in fact alive. _Position:_ `worker-main.ts` — the
      `connected.on("close", …)` handler in the connect handler.
    - **(d) Isolation comes from `startRun`, not from the reset.** A run's _start_ is the
      end of everything the previous round was doing, and it is unconditional: `startRun`
      restores `globalThis` to the boot-time warm baseline (deleting every key that is not
      in it) and resets the run bookkeeping (`cancelled`, `inFlightCalls`, `pending`),
      then reinstalls the frozen env and the run's captured console — all before the
      program is compiled. _Why:_ this is the
      correction §5 points at — the abandoned run's `reset()` is a no-op (§10(a)), so
      nothing else clears the winner's leftovers, and without this a superseded run's
      `globalThis.tools`, its workflow helpers, whatever its program assigned, and its
      cancel verdict would all leak into the next run. _Scope (known, accepted limits):_
      the baseline covers `globalThis`'s own **enumerable** string keys, so a program's
      non-enumerable properties, its prototype pollution and the `process` state it wrote
      survive a reset; leaked timers survive too and cannot be enumerated on the supported
      Node (`process._getActiveHandles` no longer lists `Timeout` handles, on the main
      thread or in a worker). _Position:_
      `worker-main.ts` — `startRun`, together with `restoreWarmBaseline`,
      `installFrozenEnv` and `installConsole`. (The call-id counter
      is the one run field `startRun` does not reset: `nextCallId` only ever moves
      forward and `pending` is empty, so a stale id can neither collide with the new
      run's ids nor settle anything — `reset()` is what rewinds it.)
    - **(e) A cancel with nothing to flush is confirmed immediately — but only to the
      caller that asked.** If a `cancel` arrives while no program is running **and the
      worker has not yet finished its first boot**, the worker answers with an `error`
      frame on the port that delivered the cancel — `kind` = the reason, message from
      `abortError()` ("PTC run was cancelled" / "PTC run timed out") — and clears the
      stored verdict, rather than sending `ready` or waiting silently. _Why:_ there is no
      pending call to flush, so the alternatives both cost the host: `ready` restarts its
      grace window and makes it wait out the full window for a program that will never
      start (and the `init` that would follow clears the verdict and runs the program
      anyway), while silence makes it wait for a timer. The error frame settles the host
      at once. The `READY` branch of `handleHostFrame` answers the same way for the same
      reason: that port is the one the asker is listening on.
      **A verdict that outlives a handover is different, and is dropped in silence.** On a
      later `connect` the stored verdict belongs to the run the worker just stopped
      serving, and the caller on the other end is a _different_ run with its own
      lifecycle: reporting it there would fail a run that was never cancelled, before its
      `init` ever arrives. The connect tail therefore clears the verdict without a frame —
      one run's cancel must not end the next.
      _Position:_ `worker-main.ts` — `reportIdleCancel`, called from the `READY` branch of
      `handleHostFrame` and from the connect tail only when `isFirstBoot`; the handover
      path clears `cancelled` in place.
    - **(f) The host never hands a program to a cancelled run.** When the worker's first
      `ready` arrives while `cancelling` is set, the dispatcher re-arms the grace window
      and returns without sending `init`. _Why:_ a program sent to a cancelled run is work
      nobody is waiting for, and the worker would spend the rest of the window executing
      it. _Position:_ `dispatcher.ts` — the `ready` branch of `handleFrame`. (The guard is
      on the first `ready`; a run that has already settled ignores later frames.)
    - **(g) The grace window is bounded, and a cancel never extends a run past its own
      deadline.** `beginCancel` arms `graceMs` immediately — not on the worker's first
      `ready`, so a worker that never becomes reachable (spawn failure, a wedged module
      load, a thread the OS stopped scheduling) cannot leave the run pending forever — and
      it deliberately leaves the deadline timer armed. If the deadline elapses while a
      cancel is already pending, it settles the run at once, with the reason the caller
      asked for rather than the ceiling that happened to arrive later; a caller's abort
      therefore cannot outlive the run's deadline. The deadline is itself a cancel, so the
      window it arms is the bound on the worker's reaction to it.

      The two orderings have **different** settle bounds, and the deadline timer is
      **one-shot** — it is spent the moment it fires, so it cannot serve as a ceiling on
      what its own firing starts:

      - **cancel first** (a caller's abort, then the deadline): the still-armed deadline
        fires as the second stop and settles the run at once — bound `timeoutMs`.
      - **deadline first** (a plain timeout, worker unresponsive): the deadline fires, has
        nothing left to fire again, and the run settles when the window it just armed
        expires — bound **`timeoutMs + graceMs`**.

      That sum is deliberate, not a gap: a run is allowed to execute for its full
      `timeoutMs`, and a cancel buys the worker `graceMs` to unwind. _Position:_
      `dispatcher.ts` — `runTimer`, `beginCancel`, `armGraceTimer`.

    - **(h) `connect` is a (re)handover, not a wait.** The connect handler claims the port,
      installs its listeners, and puts the worker back in `READY` **unconditionally**: no
      flush, no globals cleanup, because the run that used the worker last may still be
      unwinding and its leftovers are the next `startRun`'s problem (§10(d)). The warm
      baseline is captured once, at boot, and never re-snapshotted on a later `connect` —
      a second snapshot would bake a superseded run's strays into the baseline and restore
      them into every run after it. _Why:_ this is the precondition pooling rests on. A
      handover that waited for the previous program to stop would be a per-run lifecycle
      again, which is the cost this ADR exists to remove. _Position:_ `worker-main.ts` —
      the connect handler (`control = connected` … `state = "READY"`, `warmBaseline`).
    - **(i) The pool's `drain()` is bounded.** At retirement the pool rejects every queued
      waiter, waits for in-flight workers to release themselves up to `drainGraceMs`
      (default 5 000 ms, `PtcConfig.drainGraceMs`), then terminates the idle workers
      together with whatever is still in flight and resolves; termination failures are
      swallowed, so `drain()` does not reject. Every later `acquire()` rejects. _Why:_
      `drain()` is awaited from the `turn_end` hook, so a worker whose `release()` never
      arrives (a stuck dispatcher promise, an unobserved crash) must bound the turn
      boundary rather than hang it — and one bad worker is not a reason for a turn
      boundary to fail. _Position:_ `worker-pool.ts` — `drain()`; `turn-pools.ts` —
      `drain()`; the `turn_end` hook in `src/index.ts`.
    - **(j) Deviation from ADR-0005 F3 — "frozen per-**run** env" is per turn on the pooled
      path.** `TurnPools.get()` snapshots `createWorkerEnv()` once per surface and hands it
      to the pool as the workers' spawn `env` and `workerData.env`; a warm worker keeps
      that snapshot for its whole life. One worker therefore serves every run of its turn
      with **one** env — strictly, one per surface, since each surface builds its pool (and
      so its snapshot) separately. A host that changes the environment mid-turn changes
      nothing for the next run in that turn. That is the intended behaviour, not an
      oversight: a live worker's process environment is not a runtime-swappable setting,
      and rebuilding it per run would leave `workerData`'s snapshot disagreeing with the env
      the process actually spawned with. The cold path (no pool) still honours a per-run
      snapshot, because it spawns the worker per run. The same fixed-at-spawn rule covers
      F2's V8 caps and `workerData`, so a per-run `config` override of those fields is inert
      on the pooled path — a caller that needs different ones needs a
      differently-constructed `TurnPools`, or no pool. _Position:_ `turn-pools.ts` —
      `get()`; the options themselves are built once per spawn by `workerSpawnOptions()` in
      `worker-pool.ts`.

## Considered options

**Pool**

- **Keep SELF-CONTAINMENT RULE + process-level pool with reset.** Each worker
  would re-bootstrap per warm reuse, paying the same V8 spin-up cost every
  reset. Rejected — pooling without a module cache wins only on init/exit
  overhead, not on per-program setup.
- **Module-level singleton pool.** No turn-boundary signal in pi's extension
  hook, so the pool would live the lifetime of the process and accumulate state
  across turns. Rejected — boundary mismatch.

**Image wire**

- **`ArrayBuffer` over a `MessagePort` transferList.** Rejected, and the reason
  is the whole point of recording this section. The host→worker direction is a
  lossless-JSON channel: a PTC program may return a part of a binding result,
  and the worker's completion path (`toJsonValue`) rejects any non-JSON value. An
  `ArrayBuffer` delivered to the worker is therefore a value the program can
  never return — the "fix" would trade a base64 string the program can use for
  binary it cannot. Worse, `postMessage` with a transferList _detaches_ the
  sender's buffer, so the host would have to `slice()` a copy for its own
  `PtcImage` before every call, making the net cost strictly higher than the
  base64 the binding already produced. And the direction that the earlier draft
  of this ADR mis-analysed (worker→host) does not carry images at all: bindings
  execute on the host, so the image bytes are born there.
- **`bytes: ArrayBuffer` as the `PtcImage` representation (host-internal only).**
  Considered as a smaller optimisation: no wire change, just decode at capture
  and re-encode at the tool layer. Rejected because it is two conversions for
  zero benefit — the final consumer (pi's image adapter,
  `getImageDimensions(img.data, img.mimeType)`) requires base64, so the round
  trip is pure work. Keeping one representation from the binding to pi's
  adapter is strictly cheaper.

## Consequences

- **Bundler multi-entry output.** The build emits both `dist/index.js` and
  `dist/worker.js` (plus a shared protocol chunk), all in the npm `files` list.
- **`PtcImage` shape is unchanged from ADR-0014**, so `outcome.images` consumers
  and their assertions stay as they were. What changed underneath is the pool
  and the worker bootstrap, not the image representation.
- **`serializedBytes` refactor.** New text+binary walk replaces the old
  `JSON.stringify`-only helper. Unit tests cover text-only values (behaviour
  unchanged), `ArrayBuffer` payloads, typed-array views (counted once, not via
  `.buffer`), and an oversize frame tripping `maxMessageBytes`.
- **Hoisted images do not pass the output budget.** ADR-0014's Consequences
  ("Images are not output... That is deliberate") is preserved: images are
  observed (`ptc:image:hoist-bytes`, the row's image count) but not billed
  against `maxOutputBytes`. The per-frame `maxMessageBytes` guard still bounds
  what a single `callResult` may carry.
- **Reopen trigger.** If a pi tool ever returns raw binary (rather than base64),
  the `bytes` normalisation path in `captureImages` becomes the hot path and the
  "one representation" argument weakens — revisit then, with the tool's actual
  shape in hand. If pi's `ImageContent` ever accepts `Uint8Array` natively, the
  base64 argument loses its final consumer and the whole question reopens.

## Addendum — diagnostics channels

`ptc:pool:acquire-latency` — emitted on every successful `acquire()` with
`{ poolSize, waiters, durationMs }`. `ptc:worker:reset-time` — emitted when a
warm worker sends `ready`, with `{ durationMs }` from the previous settle.
`ptc:image:hoist-bytes` — emitted on every hoisted image with `{ byteLength }`,
which is the **image's own size, not the length of the base64 string** the tool
result carries. The dispatcher publishes
`Buffer.byteLength(image.data, "base64")`, and `Buffer.byteLength` measures the
decoded length for a base64 encoding, so the number answers "how big is this
picture" (the wire string is roughly 4/3 of it — the encoded size is bounded by
`serializedBytes` / `maxMessageBytes`, not reported here). Channels fire only
when there is at least one subscriber; zero-cost when unsubscribed.

`WorkerPool.stats()` is not a fourth channel, and it is not the metrics API the
"no public metrics API" line disclaims: it is a public method on an exported
class, stable enough that the pool's own tests read `resident`, `inFlight`,
`waiters`, `totalAcquires` and `poolExhaustions` straight off it, and internal
diagnosis uses it too. What the package commits to as an observation surface
stays the channels — `stats()` is a snapshot accessor for whoever already holds
the pool (the extension, a test), and it tracks the pool's internals rather than
a compatibility promise.
