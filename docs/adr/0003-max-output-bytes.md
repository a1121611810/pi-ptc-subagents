# PTC output budget: 64 MiB, matching DSH

PTC runs cap the combined serialized payload (logs + completion value) a worker may return. We take DSH's current default — 67,108,864 bytes (64 MiB) — verbatim, rather than the old pi-ptc's 4 MiB deviation. DSH reached this number by unifying separate log/value caps into one joint budget (2026-07-20), and image-bearing tool results flow through it; nothing suggests the 16× trim the old pi-ptc applied bought anything. Keeping the number identical to DSH's means a future re-sync only has to diff, not re-derive.

Status: accepted (2026-09-21). Map #7 / ticket #15. Sources: R1 `research/dsh-ptc-behaviour-inventory.md` on branch `research/R1-dsh-ptc-inventory` (`dsh-v0.1.6-alpha.2`).

## Considered options

- **4 MiB (old pi-ptc)** — its "memory-bounded" rationale was never evidence-backed; rejected.
- **Unlimited** — a managed worker needs a kill-switch; rejected.

## Consequences

- Other transport caps follow DSH without their own ADR — `maxMessageBytes` 128 MiB, `graceMs` 3 s, `timeoutMs` 120 s / `maxTimeoutMs` 600 s — because they were never deviations.
- The constant lives in one frozen `DEFAULT_CONFIG`; tests assert against the constant, never literals.
