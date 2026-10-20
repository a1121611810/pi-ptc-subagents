# No OS sandbox: inherited risk, stated plainly

DSH ships OS-level sandbox tiers (bwrap/Landlock, Seatbelt, Windows ACL tokens) with partial-enforcement reporting. pi-ptc ships none: the worker runs as the user, which is the trust posture of every other pi extension. That is deliberate — wrapping execution in platform sandboxes would duplicate what the user's own environment or container already decides, and pi exposes no sandbox contract for extensions to hook into.

Status: accepted (2026-09-21). Map #7 / ticket #15 (destination keeps OS sandbox out of scope).

## Considered options

- **Wrap the worker in bwrap/Landlock/Seatbelt** — large platform-specific lift, no pi contract to hook; rejected.
- **Read-only bindings only** — doesn't remove arbitrary code execution (the worker can still use `node:fs`), so it buys no isolation while breaking use cases; rejected.

## Consequences

- README and tool descriptions must say: installing the extension grants it the user's own machine identity.
- ADR-0005's F1–F4 hardening lowers accident surface but is **not** a security boundary; never represented as one.

## Amendment (2026-10-13): the host supplies the boundary, and the plan to build one here is closed

The decision stands — no OS sandbox is shipped — but the reason given above has been overtaken, and the staged plan that was going to build one here is closed rather than re-pointed.

**The host supplies the capability.** pi ships its own programmable tool calling (`codemode`), evaluated in a fresh QuickJS sandbox with no Node, no file system, no network and no timers (`GLOSSARY.md`, "What this extension exposes"). This package's surface decision already hands orchestration to it wherever the user has enabled it, and on that surface there is no PTC program, no binding table, and **no shell handed to a model by this package**. The JS-realm boundary the staged plan called Boundary 1 is therefore a host capability; building a second one here would duplicate it more weakly. That is the operator's decision of 2026-10-13: **we do not build a sandbox.**

**The staged plan is closed as superseded.** Issues #71, #72 and #74–#81 were closed on 2026-10-13. Their design was a hand-rolled runner (`sandbox-exec` / `bwrap` / Node `--permission`) plus a two-axis config model, and `docs/research/ptc-upstream-parity-audit-20260930.md` (§R2 and its "明确不要做" section) had already measured that this rebuilds, more weakly, what pi ships as runnable examples — `sandbox/` over `@anthropic-ai/sandbox-runtime`, `gondolin/` over all seven tool factories. The group's cited research documents were never committed to this repository, and the branch that held the runner is no longer a ref here.

**What survives is a binding default, not a boundary.** #73 (a read-only default surface, with `bash` behind an explicit opt-in) needs no runner, no platform sandbox and no config surface, and the parity audit endorses it independently of any sandbox work.

**Two statements this record does not upgrade to facts.** The worker's V8 caps were measured by the closed plan to be bypassable by large `Buffer`/`ArrayBuffer`/string allocations, and that measurement's evidence was never committed here — treat `resourceLimits` as accident mitigation whose enforcement limits are unmeasured in this repository, not as a memory bound. The same applies to the group's performance and hostile-probe numbers.

**Where the stated posture lives now**, re-verified on 2026-10-13: the README's "Trust posture" section states that PTC programs run as the user with no OS-level sandbox and that binding calls bypass pi's `tool_call` hooks, and nothing in the README or the tool descriptions describes `resourceLimits` as a memory or safety limit.
