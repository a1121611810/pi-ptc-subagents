# Architecture Decision Records

ADRs for pi-ptc-subagents, per `docs/agents/domain.md` (single-context repo).

| #                                        | Decision                                                                    | Status   |
| ---------------------------------------- | --------------------------------------------------------------------------- | -------- |
| 0001                                     | (reserved — dropped: `agent()` stub shape; G1 #13 chose no stub, so no ADR) | —        |
| [0002](./0002-source-strategy.md)        | Source strategy: clean-room rewrite                                         | accepted |
| [0003](./0003-max-output-bytes.md)       | PTC output budget: 64 MiB, matching DSH                                     | accepted |
| [0004](./0004-max-pending-calls.md)      | `maxPendingCalls`: 128, matching DSH                                        | accepted |
| [0005](./0005-ptc-execution-boundary.md) | Execution boundary: `worker_threads` + F1–F4; direct binding execution      | accepted |
| 0006                                     | (reserved — dropped: subagent seam; same G1 #13 decision)                   | —        |
| [0007](./0007-no-os-sandbox.md)          | No OS sandbox: inherited risk, stated plainly                               | accepted |
| [0008](./0008-vite-plus-and-pnpm.md)     | Toolchain: adopt `vite-plus` (`vp`) and `pnpm`, staged                      | accepted |

Numbering gaps are deliberate: 0001/0006 were reserved while wayfinder map #7 was charting and dropped when G1 resolved; keeping their slots means every cross-reference in the map and its tickets stays valid.
