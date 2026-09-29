# Background task ownership: TaskRecords are owned by the extension-runtime instance that created them, and reaping is owner-scoped

ADR-0022 made every background `pi.dispatch` child a full pi process launched with the R1 session triple (`--session-dir <sessionDir> --session-id <taskId> --name bgdispatch:<taskId>`). That choice has a consequence the ADR did not address: the child's pi process **shares the parent's `<sessionDir>/tasks/` storage**, and every pi process boots its extension, whose `bindSession` runs `reconcileLostTasks()` — a sweep that, pre-this-ADR, flipped **every** `running`/`stopping` record in the directory to `lost`. A background child therefore killed its own record and all of its parent's sibling records as a side effect of booting; its `session_shutdown` sweep did the same dir-wide flip to `session_ended_while_running` on exit, killing still-running siblings. Any unrelated `pi` process started in the same cwd (same session dir) triggered the same reap on startup. This is field-report pitfall #3 (docs/research/ptc-dispatch-field-pitfalls-20260929.md): two background dispatches from one program were both `lost_on_session_restart` before the parent could collect them.

Status: accepted (2026-09-29). Behavior change: two new optional `TaskRecord` fields (`ownerPid`, `ownerBootMs`), stamped at spawn; the startup reconcile sweeps only records whose owner process is dead (or that predate ownership); the shutdown sweep reaps only records matching the sweeping runtime's full owner identity. The `LostReason` strings are unchanged — their meaning sharpens (see Consequences). `ptc_task_list` visibility is unchanged. Everything is additive: records written before this ADR (no owner fields) keep their shape and are handled by the legacy rule below.

## Context

The storage is dir-wide by design (ADR-0022, R1: the child carries the parent's `--session-dir`), so multiple pi processes legitimately read and write the same `<sessionDir>/tasks/`. What was missing was any way to tell "my record, my responsibility" from "someone else's record, hands off". Two sweeps needed the distinction:

- **Startup reconcile** (`bindSession` → `TaskRegistry.reconcileLostTasks`, ADR-0022 §2/§8): reclaims records left `running`/`stopping` by a session that died. It must reclaim records whose writer is gone, but must NOT touch records whose writer is alive — including its own in-flight tasks (a rebind) and records of a sibling pi process sharing the dir (every background dispatch child).
- **Shutdown sweep** (`session_shutdown` → `BackgroundTaskRuntime.shutdown`): reclaims the session's still-running children with reason `session_ended_while_running` and signals their OS processes. It must reap ONLY what this runtime instance owns; a child's exit sweep must never kill the parent's still-running siblings.

## What we add

1. **Owner identity `TaskOwner { pid: number; bootMs: number }`** — `pid` is the owning OS process (`process.pid` of the dispatching pi), `bootMs` is the wall-clock ms when the extension-runtime instance started. The `BackgroundTaskRuntime` mints ONE identity per instance and hands it to every registry it binds (initial in-memory delegate, session registry, rebind registry), so a rebind can never make the startup reconcile reap the runtime's own in-flight tasks.

2. **Two optional `TaskRecord` fields** on top of ADR-0022 §3's 19 listed fields (its "21 fields" heading is an authoring miscount; the record is 21 fields today): `ownerPid?` and `ownerBootMs?`. The registry's spawn command — the single writer of a record's lifecycle — stamps them, so every record-creation path (background dispatch registration included) is covered without per-call-site changes. A record belongs to an owner only when **both** fields match (`isOwnRecord`); the fields are absent on pre-upgrade legacy records.

3. **Owner-scoped startup reconcile.** `reconcileLostTasks()` sweeps a `running`/`stopping` record to `lost` (`lost_on_session_restart`) only when its owner is dead: `ownerPid === undefined` (legacy — its writer predates this code and cannot still be running it) or `!isPidAlive(ownerPid)`. Own records and alive-foreign records are skipped. `isPidAlive` is POSIX signal 0 (`process.kill(pid, 0)`): `ESRCH` → dead, `EPERM` → alive, any other error aborts the reconcile visibly (testing-constraints #3) rather than silently reaping or preserving.

4. **Owner-scoped shutdown sweep.** `shutdown(reason)` reaps a non-terminal record only when `isOwnRecord(record, myOwner)` — full pid + bootMs match — and signals child processes only through its own `TrackingLifecycle` live handles. Foreign records (alive or dead pid, same pid with an older bootMs, legacy) are never transitioned and their children are never signaled.

5. **Rebind pinning keeps working.** Commit b626126 pinned an in-flight task to the registry that spawned it across a rebind (the `StableTaskRegistry` owner map). That pin routes _transitions_; the owner filter scopes _reaping_. They cannot double-exempt (a pinned task's registry shares the runtime's single owner identity, so the shutdown filter sees it exactly once) or double-reap (the reconcile runs on the current session registry, whose owner identity is the same one stamped on the record).

## What we deliberately don't add

1. **No cross-process stop/list semantics.** `ptc_task_list` still lists every record in the shared dir regardless of owner, and stopping a record owned by another live process is out of scope. Ownership governs _reaping_ only.
2. **No portable process start-time check.** `isPidAlive` answers "does this pid exist", not "is this the same process that wrote the record". See Known limitations.
3. **No new `LostReason` strings.** `lost_on_session_restart` and `session_ended_while_running` keep their values; their meaning becomes precise (Consequences).
4. **No migration write.** Legacy ownerless records are not rewritten; the legacy rule (sweep at startup reconcile) handles them in place. After an upgrade, a session's surviving legacy records are swept once at the next bind and the dir is owner-tagged from then on.

## Decision

### 1. Owner identity: pid + runtime boot ms, minted once per runtime instance

```ts
interface TaskOwner {
  pid: number; // process.pid of the dispatching pi process
  bootMs: number; // wall-clock ms when this runtime instance started
}
```

`bootMs` disambiguates two runtime instances in the same process (a `/reload`, or two `bindSession` lifecycles): the current instance's records carry its own `bootMs`, so an older instance's records in the same process read as foreign. `isOwnRecord(r, o) = r.ownerPid === o.pid && r.ownerBootMs === o.bootMs` — both fields must match; the record schema keeps them optional so pre-upgrade rows stay valid.

### 2. The stamp lives in the registry's spawn, not at call sites

The registry is already the single legal writer of a TaskRecord's lifecycle (ADR-0022 BG-02). Stamping `ownerPid`/`ownerBootMs` inside the spawn command makes every creation path — the background branch of `pi.dispatch`, any future batch producer — owner-tagged without each caller remembering to do it, and makes a registry constructed without an owner (tests, legacy harnesses) keep producing the pre-upgrade ownerless shape.

### 3. Startup reconcile reaps owner-dead and legacy records only

For each `running`/`stopping` record in the dir: reap when `ownerPid === undefined` (legacy, pre-upgrade staleness — after an upgrade / reload its children are gone) or when the owner pid no longer exists (`!isPidAlive(ownerPid)`). Skip everything else: our own records (a rebind must not reap in-flight tasks), and records owned by a live pid that is not ours — the field-report pitfall #3 case, where a background child shares the parent's session dir. The sweep stays idempotent (ADR-0022 §8) and stays a recovery edge (only `reconcile-lost` accepts the `stopping` source set).

### 4. Shutdown sweep reaps only full-identity own records

`shutdown` iterates the dir exactly as before but transitions a non-terminal record only when `isOwnRecord(record, this.#owner)`, and runs the SIGTERM → grace → SIGKILL ladder only against handles its own `TrackingLifecycle` recorded. A sibling pi process's records — and a dead former owner's — survive untouched. (The ladder is handle-based, not record-based, so foreign records' children are protected by construction: this runtime never had their handles.)

### 5. Legacy records: swept by the startup reconcile, never by shutdown

A legacy record has no owner, so `isOwnRecord` is false and shutdown leaves it alone; the startup reconcile's `ownerPid === undefined → reapable` rule reclaims it instead. Rationale: legacy rows can only be pre-upgrade staleness — the code that wrote them predates ownership, so they cannot represent a live task of _this_ boot. If that assumption is ever wrong (a downgrade/upgraded-again dance), the cost is one stale `lost` marking, not a live task killed.

### 6. Liveness probe: signal 0, errors stay visible

`isPidAlive(pid)` = `process.kill(pid, 0)` in try/catch: `ESRCH` → false (no such process), `EPERM` → true (exists, owned by another user), anything else rethrows. The rethrow is deliberate: a probe glitch (EINVAL from a garbage persisted pid is the realistic case — signal 0 with an out-of-range pid) must abort the reconcile loudly through the bind failure path, not silently reap or silently preserve records. The probe is a constructor seam so the ownership matrix is unit-testable without real processes.

## Consequences

- **`lost_on_session_restart` semantics sharpen.** It no longer means "some session restarted and found this" — it means "the record's owner process died before the task completed, and a later bind of a process sharing the dir discovered it". A child booting beside a live parent's records leaves them alone; the reason now points at a real dead owner.
- **`session_ended_while_running` semantics sharpen.** It means "the owner session ended (or was replaced) while its own task ran" — written only by the owning runtime's shutdown sweep. A sibling process's exit no longer produces this reason on foreign records.
- **Field-report pitfall #3 is closed.** A background child boots, reconciles, runs, and exits inside the parent's session dir without touching the parent's records; any same-cwd `pi` process likewise reaps only owner-dead rows.
- **The survival domain is now precise** (docs/usage/bgdispatch.md): a background task survives the spawning program, the spawning turn, and `/ptc off`; it is owned by the dispatching pi process and ends when that session ends/is replaced or the owner process dies.
- **Tests.** Unit matrix: startup reconcile over {own, foreign-alive, foreign-dead, legacy} × {running, stopping}; shutdown sweep reap-vs-skip with the kill-ladder seam asserted uncalled for foreign records; spawn stamping; the real `isPidAlive` probe against a live pid and a reaped child. Gated e2e (`tests/e2e/bgdispatch.test.ts`, hermetic harness: a temp `PI_CODING_AGENT_DIR` whose settings load only this working tree's build): with the parent registry file-backed at the very `--session-dir` the children boot with, a sibling record carries no reaping trace across a real child's boot reconcile and exit sweep (not `lost`, no lost reason) and then reaches `succeeded` on its own, with the sibling child's own PONG output. The mid-test assertion deliberately does not require `running` — the echo child finishes in about a second, so "still running" would be a race, not a specification.

## Known limitations

- **Pid reuse.** `isPidAlive` cannot distinguish a live owner from an unrelated process that reused the pid; a zombie record can stay `running` until the pid is recycled. Reading another process's start time portably was judged out of scope — `bootMs` is written but cannot be verified cross-process.
- **Same pid, older bootMs.** Records whose owner is this pid but an older runtime instance (a `/reload` in the same process) read as foreign-alive: the startup reconcile skips them and shutdown does not reap them. They age out when the process exits (pid-dead rule) or linger while it lives.
- **Cross-process list/stop visibility unchanged.** `ptc_task_list` shows every record in the shared dir, including other processes'; `ptc_task_stop` against another live process's task is not scope-guarded by this ADR (the transition table still governs; a sibling's concurrent write wins by the usual single-writer serialization).

## Boundary with ADR-0022

This ADR amends ADR-0022 by reference: the record schema gains two optional fields (ADR-0022 §3's code block — 19 fields; its "21 fields" heading is an authoring miscount — remains the base, so the record is 21 fields today), and the two sweeps named in ADR-0022 §2/§8 ("session restart" and "session end" reaping) become owner-scoped as specified here. Where the two ADRs read differently, this one governs the ownership scope; ADR-0022's state machine, subscription cursor, delivery, and signal-layering decisions are untouched. ADR-0022's text is deliberately not edited — the amendment lives here.

## Cross-references

- ADR-0022: background dispatch (amended by reference on record ownership and sweep scope).
- ADR-0016: the `pi.dispatch` binding (spawn surface; unchanged).
- docs/research/ptc-dispatch-field-pitfalls-20260929.md 附录 C: the field mechanism, the root-cause verdict, and the fix cross-walk.
- docs/usage/bgdispatch.md: the user-visible survival domain and sharpened `lost` reasons.
