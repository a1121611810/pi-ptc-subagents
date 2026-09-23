# PTC sub-call tree: always visible, dispatcher-tracked, capped at 32

Each binding call a PTC program makes is shown as a sub-row beneath the parent PTC row, **always
visible** (even when the parent row is collapsed). Each sub-row carries its own status
(running/ok/error/cancelled/rejected), the tool name, an args preview, and the duration. Sub-calls
appear in host-side dispatch order. The tree is capped at 32 rows; overflow shows as a `+N more`
tail. No recursion in v1: a `pi.dispatch(...)` call is one sub-row, not a nested tree.

Status: accepted (2026-09-23). Behaviour change on the TUI only (the model sees nothing extra;
ADR-0012 governs the model's copy). Wire protocol gains nothing (the existing `call` /
`callResult` path already carries every fact the renderer needs); the new field is a host-side
data structure (`PtcToolDetails.subCalls`).

## Why

DSH shows each binding call as a nested sub-row under the PTC parent row, even when the parent is
collapsed (`ToolCallTree.tsx:77`, `data-subcalls`). Each carries its own state; a failing sub-call
shows red even when the parent returns OK. The structural cue — "this PTC program called these
tools" — is the only signal the user gets without pressing `ctrl+e`, and it is the strongest
indication a PTC program is doing real work rather than just running.

In pi-ptc, the dispatcher already sees every binding result before it posts to the worker (the same
seam ADR-0014 uses for image hoisting). All we have to do is **remember** those results in a
shape the renderer can read. The render-time question is whether to re-derive the tree from logs
and infer states (fragile, wrong for cancelled / rejected) or to record it explicitly at the
seam where the facts are known.

## What DSH does (the parity target)

`ToolCallTree.tsx:77` (DSH upstream, `packages/client/ui-tool/src/client/tool/`):

- A nested row per binding call, rendered as a child of the `run_code` parent.
- The tree is rendered **always visible**, not gated by expansion — `data-subcalls` on the parent
  causes sub-rows to stay mounted.
- Each sub-row carries its own running/ok/error state, with the parent's status a roll-up of the
  children.
- A failing sub-call is red even when the parent returns OK (`ToolCall.tsx:212`).
- Order is by dispatch arrival; cap is unbounded (DSH flag, see divergences).

## Decision

**1. Host tracks the sub-call list via `SubCallTracker`.** No new wire frame; the existing `call`
(worker→host) and `callResult` (host→worker) pair already carries every fact. The host's
`handleCall` (`src/runtime/dispatcher.ts`) holds a single `SubCallTracker` instance per run,
populated as the lifecycle progresses (see §9 for the module shape):

- **on `call` frame arrival** — `tracker.recordStart(callId, frame.tool, frame.args)` appends
  `{callId, name, args, status: "running", startMs: Date.now()}`. Order = arrival order = host-side
  dispatch order = the order the worker emitted them, which is the order the program's `await`
  chain produced. This is also the order a reader scans a column of sub-rows (Q19).
- **on `binding.execute` resolution** — `tracker.recordEnd(callId, status, summary)` mutates the
  record in place:
  - success: `{status: "ok", endMs, durationMs, resultSummary}` (the summary is recorded for a
    future expanded view; nothing renders it today)
  - the binding threw (our built-ins reject rather than returning an error block):
    `{status: "error", endMs, durationMs, errorMessage}`
  - run was cancelled while the binding was in flight (the binding's `AbortSignal` fired before
    resolution): `{status: "cancelled", endMs, durationMs}`
  - a `pi.dispatch(...)` the harness declined: the binding resolves (it never throws) with
    `{status: "rejected", started: false, errorMessage}` — the depth gate, the concurrency gate
    (ADR-0016 §2), an unknown agent, or a spawn that never happened. Recorded as
    `{status: "rejected", durationMs: 0}`, and distinguished from the next bullet by
    `started: false`.
  - a `pi.dispatch(...)` that **ran and failed** (non-zero exit, no final text, or killed): the
    binding returns `{status: "rejected", started: true, durationMs}`, which is recorded as
    `{status: "error", durationMs}` with the duration it actually took — the harness did not
    decline it, the work failed.

The tracker is owned by the run promise (ADR-0017 §1's `PtcRunOutcome` shape) and `snapshot()`s at
`finish()`; the frozen snapshot is what reaches `PtcToolDetails.subCalls` (§2).

**2. Final snapshot goes into `PtcToolDetails.subCalls`.** ADR-0014 already added
`PtcToolDetails` to `common.ts` for image counts and elapsed time; the same shape gains a
`subCalls?: SubCallRecord[]` field. `renderToolResult` copies the array through (no mutation, no
filtering). When `subCalls` is absent (an older protocol version, or a run that never made any
binding call), the renderer falls back to ADR-0013's existing `code / out / log / warn / image`
labelled blocks — the same path that runs today.

**3. Sub-call row content: `name + status + args preview`.** The renderer reads `subCalls[i]`
and emits one sub-row per record, the status text carrying the duration when the call settled:

```
├─ read        running   /tmp/foo.ts
├─ bash        ok 2.4s   pnpm test
└─ pi.dispatch rejected: dispatch depth limit reached → agent-research
```

The args preview is one line extracted by name-specific logic (the same selector as
ADR-0013 §1's `resultHint`): `read` → `args.path`, `bash` → `args.command`, `grep` →
`args.pattern`, `find` → `args.pattern`, `ls` → `args.path`, `edit` → `args.path`,
`write` → `args.path`. Falls back to `JSON.stringify(args)` truncated to 40 chars when the
selector misses — this is the **only** place `JSON.stringify` is acceptable on a sub-row
because the input is one args object whose keys are already known, so the fallback is bounded
(`+N chars` cap, no embedded newlines).

The status text is coloured by the existing theme slots — `running` and `cancelled` muted, `ok`
accent, `error` error, `rejected` warning — and the status text itself is the only place a
duration appears (on `ok`). No new colour slots are added to `pi-tui`'s theme.

`pi.dispatch` sub-rows use the binding's `agent` argument in place of the args preview
(`Q18`): the preview column reads `→ <agent>`.

The tree is not a settle-time artefact. The dispatcher calls the caller's `onSubCallChange` on
every `recordStart` / `recordEnd`, and each tool pushes a throttled partial result through pi's
`onUpdate`; pi turns that into `updateResult(partial, isPartial: true)` (`interactive-mode.js:2772`),
so the row re-renders with the tree already populated — a user watching a slow binding sees it as
`running`, which is the whole point (US3 / US21). The push is coalesced on the same 100ms cadence
bash uses for its own output, and `cancel()` on settle drops any push still pending so it cannot
land after the terminal result and revert the row. A partial `details` carries only what is known
mid-run (the sub-calls, the elapsed time, the surface); the renderer treats a partial render with
no completion value as having no result area at all rather than claiming `done`.

A run that **fails** is the one case where the tree is not shown: the tool throws (pi's convention,
ADR-0012 / R1 §3), and pi's error result carries `details: {}`, so the sub-calls are dropped with
everything else. Recovering them would mean giving up the throw for a hand-rolled error result,
which ADR-0012 rejects; the failure text plus the row's own meta is what the reader gets.

**4. Always visible, even when the parent is collapsed.** `renderPtcToolResultCollapsed`
(`src/tools/render.ts`) returns the result area **followed by** the sub-call tree, in
that order. Today it returns the result area alone; the change is to append the sub-call tree
when `details.subCalls` is present. The tree's tree connectors (`├─` / `└─` / `│`) reuse the
ADR-0013 §1 connector palette — the same `TREE_ROOT` / `TREE_ROOT_CONT` / `TREE_INDENT` /
`TREE_FIRST` / `TREE_LAST` constants already in `render.ts`.

The collapsed-state header (one line `→ hint · meta`) is unchanged — ADR-0013 §1's "collapsed
row is one line" invariant applies to the result area; the sub-call tree is a sibling
**outside** the result area, like the labelled `code / out / log` blocks ADR-0013 §3 introduced
for the expanded view. The difference is: sub-call rows are visible in **both** collapsed and
expanded states; labelled blocks are visible only in expanded.

**5. 32-row hard cap with a `+N more` tail.** `maxSubCalls = 32` (a constant in `common.ts`).
Above the cap, the renderer collapses the overflow into one row:

```
└─ …+N more calls
```

The cap follows the same bounded-everywhere principle as ADR-0013 §3 (the labelled blocks). 32
is empirically enough for the longest legitimate PTC workflow (3 code blocks × 5 phases + 17
misc calls ≈ 32); a longer run is already summary material, not row material.

The cap applies to **displayed** rows. The `subCalls` array itself is full-fidelity (every record
reaches the renderer; the renderer drops rows past the cap). This mirrors ADR-0014 §1's "no
silent drop" — the data exists; only the visible representation is bounded.

**6. Five states, named exactly.** A `SubCallStatus` literal union:

```ts
type SubCallStatus = "running" | "ok" | "error" | "cancelled" | "rejected";
```

- `running` — `call` frame arrived, binding.execute not yet resolved.
- `ok` — binding resolved successfully. Sub-call's `result.content[0].text` first line is
  available as `resultSummary`. Nothing renders it yet — the collapsed and expanded sub-rows
  both show name / status / args preview — so it is recorded for a future expanded view only.
- `error` — the binding threw (our built-ins reject rather than returning an error block), or it
  was a `pi.dispatch` whose child ran and failed. `errorMessage` carries the reason: the thrown
  error's message, or the `DispatchResult`'s.
- `cancelled` — binding was aborted by the run's `AbortSignal` (timeout or user abort). Recorded
  with `durationMs` = elapsed at cancellation.
- `rejected` — the harness declined the call before any work happened: the `pi.dispatch` depth or
  concurrency gate, an unknown agent, or a spawn that never occurred. The value carries
  `DispatchResult.status === "rejected"` **and** `started === false`; `durationMs = 0` because
  there was nothing to time.

Status maps to colours exactly:

| status    | colour slot        | use                                                                                                     |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| running   | `muted` (or `dim`) | muted/dim text — sub-rows do not shimmer (US16); the parent's call-row band is the partial-state signal |
| ok        | `accent`           | normal accent                                                                                           |
| error     | `error`            | red                                                                                                     |
| cancelled | `muted` (or `dim`) | strikethrough is overkill; muted text signals "didn't run"                                              |
| rejected  | `warning`          | yellow, signals "would have run but the harness said no"                                                |

No new theme slots are introduced; everything maps to ADR-0013 §4's existing palette.

**7. No recursion in v1.** A `pi.dispatch(...)` sub-row is a leaf, not a sub-tree. The child PTC
run that the dispatch spawns appears as its **own** PTC row in the parent transcript (ADR-0016
Recursive §5 already shows this — child processes get their own row). The `pi.dispatch`
sub-row is one summary line (`pi.dispatch <status> → <agent>`) with the
child's structural data accessible via `ctrl+e`. Rationale: a recursive tree would let a
single sub-call expand the visible row count by an unbounded factor; the cost is not worth the
information density at v1.

A future ADR may revisit recursion if user feedback shows the missing nested view as a problem.
For now, "single leaf per dispatch" is the rule.

**8. Coupling with ADR-0020 (pulse) — partial-state visibility is structural, not animated.**
While the parent row is in partial state, the sub-call tree is **already populated**: §4's live
push means each `recordStart` reaches the row before that binding settles, so the reader sees the
in-flight binding as `running` rather than waiting for the whole run. Per US16,
sub-rows do **not** shimmer — they convey liveness through their five-state status colour
(`running` muted, `ok` accent, `error` error, `cancelled` muted, `rejected` warning — §6 above),
while the parent's call-row shimmer (ADR-0020) is the single animated partial-state signal.
US16 explicitly asks for the args preview to stay readable, so the args-preview text is never
recoloured by a moving band; the parent's pulse is what tells the reader the row is alive, and
each sub-row's colour tells the reader what that row is doing.

## Implementation shape

**9. §9 · SubCallTracker — host-side state, deep module.** Position: `src/runtime/sub-call-tracker.ts`
(new). The five-state lifecycle from §1 lives in a single module with this interface:

```ts
class SubCallTracker {
  recordStart(callId: number, name: string, args: unknown): void;
  recordEnd(
    callId: number,
    status: SubCallStatus,
    summary?: { errorMessage?: string; resultSummary?: string },
  ): SubCallRecord | undefined;
  snapshot(): readonly SubCallRecord[];
}
```

Internally: a `Map<number, SubCallRecord>` (lookup by `callId`) plus an order-preserving array
(`Map` insertion order is stable in JS). `recordEnd` mutates the matching record and returns it;
`recordStart` rejects duplicate `callId`s with an explicit throw (a worker that ignores its
admission budget is already a `kind: protocol` failure per the `handleCall` admission guard, and the
tracker matches that strictness). `snapshot()` copies each record, not just the array: the
dispatcher reads it on every start and end to feed the live push, and a push that outlived its
call must show the state as of that moment rather than whatever the record was later mutated
into.

The module is a **deep module** by codebase-design's deletion test: deleting it forces the
five-state mutate logic and ordering guarantees back into `dispatcher.ts`, where they would be
hidden inside the dispatcher orchestrator. Two adapters justify the seam: the production instance
in `dispatcher.ts` and the test's synthetic sequences (per §12). The current `dispatcher.test.ts`
coverage requires a real Worker round-trip to construct multi-call sequences — extracting the
tracker turns that into a unit test that runs in milliseconds.

**10. §10 · PtcRow is the orchestrator, not the owner.** Position: `src/tools/render.ts`. The
collapsed and expanded renderers compose the sub-call rendering (`subRowsFor` for the lines,
`previewArgs` for the args-preview selector) with the result area. They do not own `subCalls`,
do not map statuses to colours, do not enforce the 32-row cap, do not wrap sub-rows with the
shimmer decorator — those concerns live in helper functions in the same file: `previewArgs(name,
args)` and `subRowsFor(subCalls, theme)` (private, no exported seam). One caller per helper
(collapsed **and** expanded call the same helper), which keeps the deletion test trivial:
deleting `render.ts` deletes the helpers.

**11. §11 · Args preview is a private helper, not a module.** The name-specific selector table
from §3 lives as a single `previewArgs(name, args)` function in `render.ts`. It is a deep
_helper_ (small signature `(name, args) → string`, lots of per-name dispatch logic + JSON
fallback) but does not justify a module — there is one call site, and the deletion test fails
trivially: deleting `render.ts` deletes the helper. Promoting it to a module would be a one-call
seam with no second adapter; the codebase-design rule "one adapter means a hypothetical seam"
applies.

**11b. §11b · The tool-facing renderer pair is one factory.** Position: `src/tools/render.ts`
(`createPtcRenderers`). `ptc_run_code` and `ptc_workflow` register the same `renderCall` /
`renderResult` pair and differ only by the surface label, so both spread the factory's result
rather than carrying a copy. Two copies had already drifted once during review — the duplication
was not hypothetical. The factory's return type is derived from pi's exported `ToolDefinition`,
which keeps the `context` parameter linked to `ToolRenderContext`: a rename on pi's side becomes
a compile error here rather than a silently inert shimmer.

**12. §12 · Tests.** Position: `tests/sub-call-tracker.test.ts` (new) + existing
`tests/dispatcher.test.ts` + existing `tests/render-ptc.test.ts`. The new module owns the
behaviour the integration tests used to cover:

- **`tests/sub-call-tracker.test.ts`** — pure unit tests. Direct construction of sequences:
  - 5 binding calls (mixed `Promise.all` and sequential), assert 5 records in dispatch order,
    correct startMs/endMs, correct status per outcome.
  - `pi.dispatch` capacity gate: 9 concurrent calls under default cap 8 → 9th record has
    `status: "rejected"`, `durationMs: 0`.
  - Mid-flight cancel → in-flight record finalises to `cancelled`, not `error`.
  - Duplicate `callId` to `recordStart` → throws.
- **`tests/dispatcher.test.ts`** — keep the existing Worker round-trip tests but lose the
  multi-call coverage that now lives at the tracker unit level. The dispatcher's own tests focus
  on admission control, settle ordering, and image hoist (ADR-0014) — concerns the tracker
  integration does not regress.
- **`tests/render-ptc.test.ts`** — the composition suites: the sub-call tree in collapsed and
  expanded views, the all-five-status coverage, the 32-cap tail, the args-preview fallback, the
  partial render (tree present, no `done` claim), and the error-result shape pi actually sends a
  throwing tool (`details: {}`).
- **`tests/run-code-tool.test.ts`** — the seams no single renderer can see: that
  `outcome.subCalls` reaches `details.subCalls`, that a binding call is pushed to `onUpdate`
  while the run is in flight, and that the live push coalesces and cancels. It runs a real worker
  through the real tool definition, which is the only place those wires are observable.

## Divergences from DSH, stated plainly

- **Bounded sub-call display (32), unbounded DSH.** DSH's `ToolCallTree` recurses without a cap;
  the DSH research note flagged this as a concern
  (`docs/research/dsh-ptc-page-rendering.md` "What I could not establish"). We cap to match
  ADR-0013 §3's "expanded never means unbounded" principle; 32 is empirical, can be revisited.
- **No recursion.** DSH's tree is recursive; ours is not. DSH shows a `pi.dispatch` as a nested
  tree whose leaves are the child PTC run's binding calls. We render a flat list, with the
  child PTC's structural data accessible only via `ctrl+e`. Same justification as the
  `worker-pool` decision (ADR-0017 §7): pi does not expose the per-call grouping DSH has, so
  the implementation that "looks like DSH" has to be re-derived locally.
- **Five states vs DSH's three.** DSH has running/ok/error. We add `cancelled` and `rejected`
  because the dispatcher already knows those facts (`error.kind = "abort"` and
  ADR-0016 §2's dispatch capacity rejection), and surfacing them is more honest than collapsing
  them to "error".
- **`subCalls` is a host-side field, not a wire-protocol change.** DSH's tree arrives via the
  React tree (UI renders whatever the React tree says). Our wire protocol is JSON over a
  `MessagePort` and doesn't carry tree shape; the host renders it from a structured array. Same
  outcome, different mechanism.

## Consequences

- **The TUI shows binding calls during partial state.** Today, a user pressing `ctrl+e` on a
  still-running PTC row sees the labelled `code / phases / log / out / warn / image` blocks but
  no per-binding state — only the running program's `console.log` lines. After this ADR, the
  user sees which binding is currently in flight, which have settled, and which failed — without
  expansion, on the row's collapsed state.
- **`PtcToolDetails` gains one optional field.** No existing detail consumer breaks
  (`subCalls` is absent on older runs). ADR-0014 §1's "nothing here decides for the program"
  rule still holds: the program still sees the same return value; only the human-visible row
  changes.
- **`SubCallTracker` (per §9) owns the lifecycle.** Dispatcher holds one instance per run, not
  an inline array. The five-state mutate path, the ordering guarantee, and the `snapshot()`
  snapshot all sit in `src/runtime/sub-call-tracker.ts`. Dispatcher grows only `tracker.recordStart
(...)` / `tracker.recordEnd(...)` calls and a `snapshot()` at `finish()` — about 8 lines, not 50.
  Memory: 32 records × ~200 bytes = 6.4 KB worst case per run, freed with the run promise
  (ADR-0017 §1).
- **PtcRow becomes an orchestrator.** Per §10, the renderer reads `details.subCalls`, calls the
  private `subRowsFor(subCalls, theme)` helper to produce per-row lines, and appends them to
  the result area. The orchestrator does not own sub-call state, status-to-colour mapping, or
  the 32-cap tail — those concerns live in helpers. Locality: changing how a `cancelled`
  sub-call renders (icon, colour slot) lands in one helper, not in the dispatcher and not in
  the orchestrator.
- **Tests pin the contract.** Per §12, three suites in `tests/sub-call-tracker.test.ts` (5-call
  sequence, rejected-at-cap, mid-flight cancel) plus duplicate-`callId` throw. `tests/dispatcher.test.ts`
  loses its multi-call coverage (now covered at unit level). `tests/render-ptc.test.ts` keeps the
  collapsed-shows-sub-tree / 32-cap-tail / args-preview-fallback / all-five-status suites — and
  no longer needs to mock `Date.now()` or intervals (delegated to `tests/shimmer.test.ts`).
- **Code growth.** ~300 lines added across `src/runtime/sub-call-tracker.ts` (new module,
  ~80 lines), `src/runtime/protocol.ts` (`SubCallRecord` / `SubCallStatus` types, ~30 lines),
  `src/tools/common.ts` (`PtcToolDetails.subCalls`, ~3 lines), `src/tools/render.ts` (sub-call
  rendering helpers + collapsed/expanded composition, ~80 lines), `src/tools/shimmer.ts` (per
  ADR-0020 §7, ~80 lines), and the dispatcher growth (~10 lines per §9 — `recordStart` /
  `recordEnd` calls and `snapshot()` at finish). Plus the test suites.

## Trade-off, restated

ADR-0020's shimmer is subtle by design; this ADR's sub-call tree is **structural** by design —
the user gets one animated signal (the parent's moving band) and a structural signal (each
sub-row's colour tells the reader what that row is doing). A row in flight shimmers gently
while its sub-rows show concrete binding activity (running/ok/error/cancelled/rejected) via
their status colour (per §6). When the run settles, the parent stops shimmering (ADR-0020 §5);
the sub-rows stop changing colour (the row is in its terminal status). The labelled `code /
out / log` blocks appear alongside the sub-call rows in expanded state, each carrying its own
fact (sub-row = per-binding state, labelled block = program output).
