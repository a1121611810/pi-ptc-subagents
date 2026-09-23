# 04: subCalls field on PtcToolDetails

**What to build:** add the optional `subCalls?: SubCallRecord[]` field to
`PtcToolDetails` in `src/tools/common.ts`. Optional so older runs (or runs
without any binding call) keep working unchanged.

**Blocked by:** 02 (needs `SubCallRecord` type).

**Status:** ready-for-agent

- [ ] `PtcToolDetails` interface gains `subCalls?: readonly SubCallRecord[]`.
- [ ] `renderToolResult` in the same file copies the array through from
      `outcome.subCalls` (no mutation, no filtering) when present.
- [ ] When `subCalls` is absent, the renderer falls back to ADR-0013's
      existing `code / phases / log / out / warn / image` labelled blocks
      (no behaviour change for older runs).
- [ ] Type checks pass; lint passes.
