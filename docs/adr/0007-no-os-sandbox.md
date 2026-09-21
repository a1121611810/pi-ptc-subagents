# No OS sandbox: inherited risk, stated plainly

DSH ships OS-level sandbox tiers (bwrap/Landlock, Seatbelt, Windows ACL tokens) with partial-enforcement reporting. pi-ptc ships none: the worker runs as the user, which is the trust posture of every other pi extension. That is deliberate — wrapping execution in platform sandboxes would duplicate what the user's own environment or container already decides, and pi exposes no sandbox contract for extensions to hook into.

Status: accepted (2026-09-21). Map #7 / ticket #15 (destination keeps OS sandbox out of scope).

## Considered options

- **Wrap the worker in bwrap/Landlock/Seatbelt** — large platform-specific lift, no pi contract to hook; rejected.
- **Read-only bindings only** — doesn't remove arbitrary code execution (the worker can still use `node:fs`), so it buys no isolation while breaking use cases; rejected.

## Consequences

- README and tool descriptions must say: installing the extension grants it the user's own machine identity.
- ADR-0005's F1–F4 hardening lowers accident surface but is **not** a security boundary; never represented as one.
