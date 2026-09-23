# 02: SubCallRecord + SubCallStatus types

**What to build:** the data types the dispatcher tracks and the renderer reads.
No wire-protocol change; pure type-only addition to `src/runtime/protocol.ts`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `SubCallRecord` interface exported from `src/runtime/protocol.ts`:
      `{ callId: number; name: string; args: unknown; status: SubCallStatus;
startMs: number; endMs?: number; durationMs?: number;
resultSummary?: string; errorMessage?: string }`.
- [ ] `SubCallStatus` literal union exported: `"running" | "ok" | "error" |
"cancelled" | "rejected"`.
- [ ] No runtime behaviour, no exports beyond the types.
- [ ] Type checks (`pnpm typecheck`) pass.
- [ ] Lint passes.
