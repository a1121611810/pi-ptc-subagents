# `maxPendingCalls`: 128, matching DSH

Admission control for simultaneously in-flight worker→host binding calls: we take DSH's 128 rather than the old pi-ptc's 32. Pending entries are tiny (call id, binding name, args reference), so this cap is host bookkeeping, not a memory-pressure lever; 32 bought nothing but earlier throttling of wide `Promise.all` loops.

Status: accepted (2026-09-21). Map #7 / ticket #15. Sources: R1 on branch `research/R1-dsh-ptc-inventory` (`dsh-v0.1.6-alpha.2`; enforced on `pending` in `ptc-runtime-node`).

## Considered options

- **32 (old pi-ptc)** — "memory-bounded" claim unsupported; rejected.
- **Unlimited** — unbounded outstanding-call bookkeeping is a foot-gun; rejected.

## Consequences

- The dispatcher must accept concurrent binding-call frames up to this cap (map #7 Notes: pi's agent-loop sub-concurrency is orthogonal; in-worker `Promise.all` concurrency is DSH behaviour).
- DSH's sibling knob for concurrent dispatch forwarding is `maxParallelSubCalls = 10` (2026-07-26). T3 mirrors it unless it finds a reason otherwise.
