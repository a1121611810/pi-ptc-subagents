# Source strategy: clean-room rewrite (old implementation off-limits)

This package's implementation is written fresh in this repo from the map's authoritative inputs: DSH behaviour (R1), the boundary ADRs (0003–0005, 0007), and pi's own API docs. The old `pi-ptc` implementation at `~/.pi/agent/extensions/pi-ptc/` is deliberately **not read** during implementation — its SPEC carried a frozen deviation list this effort discarded, and inheriting its structure would smuggle those decisions back in. Its docs (SPEC/AGENTS) may be consulted as non-authoritative history; its source may not. The previously planned 173-test baseline is gone: tests are written fresh alongside each implementation ticket.

Status: accepted (2026-09-21). Map #7 / ticket #14 (G2). Supersedes map #1 ticket #2 (source migration — closed).

## Considered options

- **Migrate-then-refactor** — copy `src/` + `tests/` from the old repo, then refactor per ADR; retains the 173-test baseline but imports the old structure wholesale; rejected 2026-09-21.
- **Rewrite with old code readable** — intermediate; rejected because "readable" reliably becomes "copied in spirit" under implementation pressure.

## Consequences

- T2 becomes scaffold-only (no source import); T3–T5 write from ADRs + R1, never from the old code.
- No migration path for old fixes: anything worth keeping must be re-expressed as a requirement (ticket or ADR), not copied.
- The old repo remains in place as the historical record; nothing from it is imported.
