# Architecture Decision Records

ADRs for pi-ptc-subagents, per `docs/agents/domain.md` (single-context repo).

| #                                                          | Decision                                                                         | Status   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| 0001                                                       | (reserved — dropped: `agent()` stub shape; G1 #13 chose no stub, so no ADR)      | —        |
| [0002](./0002-source-strategy.md)                          | Source strategy: clean-room rewrite                                              | accepted |
| [0003](./0003-max-output-bytes.md)                         | PTC output budget: 64 MiB, matching DSH                                          | accepted |
| [0004](./0004-max-pending-calls.md)                        | `maxPendingCalls`: 128, matching DSH                                             | accepted |
| [0005](./0005-ptc-execution-boundary.md)                   | Execution boundary: `worker_threads` + F1–F4; direct binding execution           | accepted |
| 0006                                                       | (reserved — dropped: subagent seam; same G1 #13 decision)                        | —        |
| [0007](./0007-no-os-sandbox.md)                            | No OS sandbox: inherited risk, stated plainly                                    | accepted |
| [0008](./0008-vite-plus-and-pnpm.md)                       | Toolchain: adopt `vite-plus` (`vp`) and `pnpm`, staged                           | accepted |
| [0009](./0009-vitest-adoption.md)                          | Test runner: adopt Vitest 4, retire `node --test`                                | accepted |
| [0010](./0010-ptc-default-mode.md)                         | PTC default mode: narrow the loadout, snapshot the bindings                      | accepted |
| [0011](./0011-ptc-mode-restores-skills.md)                 | PTC mode restores the skills section pi withholds                                | accepted |
| [0012](./0012-model-facing-result-text.md)                 | Model-facing tool-result text: clean it, lay it out for reading                  | accepted |
| [0013](./0013-ptc-row-compact-summary.md)                  | PTC row: one call line + one right-aligned meta line, never a payload dump       | accepted |
| [0014](./0014-image-hoisting.md)                           | Image-bearing tool results: hoist them onto the PTC tool result                  | accepted |
| [0015](./0015-pi-truncation-contract.md)                   | Model-facing text: adopt pi's truncation contract (50 KB / 2000 lines)           | accepted |
| [0016](./0016-ptc-dispatch-binding.md)                     | pi.dispatch binding: PTC programs may explicitly fan out to per-call pi sessions | accepted |
| [0017](./0017-ptc-worker-pool-and-image-wire-shape.md)     | Worker pool per turn; hoisted images stay base64 (no transferList)               | accepted |
| [0018](./0018-release-path-oidc-publishing.md)             | Release path: tag-triggered OIDC publishing (no provenance while private)        | accepted |
| [0019](./0019-minify-and-source-map-exclusion.md)          | Build pipeline: enable minification + exclude source maps from npm tarball       | accepted |
| [0020](./0020-ptc-row-pulse.md)                            | PTC partial-state render: DSH TextShimmer (moving highlight band)                | accepted |
| [0021](./0021-ptc-sub-call-tree.md)                        | PTC sub-call tree: always visible, dispatcher-tracked, capped at 32              | accepted |
| [0022](./0022-background-dispatch.md)                      | Background dispatch: long-lived children + model-visible `ptc_task_*` lifecycle  | accepted |
| [0023](./0023-background-task-ownership.md)                | Background task ownership: owner-tagged records, owner-scoped reaping            | accepted |
| [0024](./0024-binding-contract-declares-binding-result.md) | Binding contract: tool descriptions declare what a binding call resolves to      | accepted |
| [0025](./0025-extension-surface-is-a-setting.md)           | Extension surface is a setting: `off` / `subagents` / `full`                     | accepted |

Numbering gaps are deliberate: 0001/0006 were reserved while wayfinder map #7 was charting and dropped when G1 resolved; keeping their slots means every cross-reference in the map and its tickets stays valid.
