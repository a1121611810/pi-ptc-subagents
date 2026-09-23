# 07: Sub-call helpers + sub-call row orchestration

**What to build:** render the sub-call tree under the PTC row. Two private helpers in
`src/tools/render.ts` (`previewArgs(name, args)` and `subRowsFor(subCalls, theme)`), plus the
collapsed and expanded paths appending the tree after the result area when `details.subCalls` is
present.

**Blocked by:** 01, 04, 05 (needs the decorator, the `subCalls` field on `PtcToolDetails`, and the
dispatcher wiring).

**Status:** ready-for-agent

## Note on sub-row shimmer

Sub-rows do **not** shimmer (US16: the args preview must stay readable). Their liveness signal is
the colour of the status text. This supersedes an earlier draft of this ticket that asked for
per-row `withShimmer`.

## Acceptance criteria

- [ ] `previewArgs(name, args)`: `read` / `ls` / `edit` / `write` → `args.path`; `bash` →
      `args.command`; `grep` / `find` → `args.pattern`; `pi.dispatch` → `→ ${args.agentName}`.
      Falls back to `JSON.stringify(args)` truncated to 40 chars with newlines folded.
- [ ] `subRowsFor(subCalls, theme)`: one row per record as `name`, then the status text (which
      carries the duration on `ok`), then the args preview. Capped at `maxSubCalls = 32` with a
      `└─ …+N more calls` tail. Reuses ADR-0013's `TREE_*` connector constants.
- [ ] Status text coloured by the existing slots: `running` / `cancelled` muted, `ok` accent,
      `error` error, `rejected` warning.
- [ ] `renderPtcToolResultCollapsed` and `renderPtcToolResultExpanded` append the tree after the
      result area when `details.subCalls` is non-empty, in both states.
- [ ] `renderPtcToolResultCollapsed` / `Expanded` take an `isPartial` flag: a partial render with
      no completion value shows the tree and no `done` placeholder.
- [ ] New suites in `tests/render-ptc.test.ts`: the tree in collapsed and expanded views, all five
      statuses, the 32-cap tail, the args-preview fallback, the partial render, and pi's real
      error-result shape (`details: {}`).
- [ ] Existing tests still pass.
- [ ] Type checks pass; lint passes.
