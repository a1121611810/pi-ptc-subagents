# The model-facing text block honours pi's truncation contract

pi's extension guide is explicit — _"Tools MUST truncate their output"_ — and pi exports the utilities
for it: `truncateHead` / `truncateTail` / `truncateLine`, `formatSize`, and the defaults
`DEFAULT_MAX_BYTES` (50 KB) and `DEFAULT_MAX_LINES` (2000). Its built-ins end a truncated result with
`[Showing lines a-b of N. Full output: <temp file>]`. This package assembled its own text block and
only capped _lines_ (ADR-0012), so a run whose captured output approached ADR-0003's 64 MiB budget
handed the model the whole thing — precisely the failure the contract exists to prevent.

Status: accepted (2026-09-22). Model-facing only: the program still produces everything it produced,
and `details` still carries the raw arrays. Found by an audit of our code against pi's API surface:
`docs/research/pi-capability-audit.md`.

## Decision

**1. The text block goes through pi's `truncateTail`.** Same numbers as the built-ins
(`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`), same tail bias (a program's _last_ lines are the ones a
reader needs: the assertion that failed, the summary), same wording in the footer. Hand-picking our own
ceiling was rejected: the ceiling is pi's contract, not a PTC preference, and a second number would
drift.

**2. The untruncated text is written where the model can reach it.** `os.tmpdir()/pi-ptc-output-<uuid>.txt`,
its path in the footer and in `details.fullOutputPath` — the field name pi's `bash` uses for the same
thing. A PTC program's captured output exists only for the length of the run, so without the file the
dropped head is simply gone; with it, the next program can `tools.read` it. The file is written _before_
the tail is cut, so the pointer never names a partial file.

**3. The per-line cap stays ours.** `truncateLine` is byte-based: 200 bytes of Chinese is ~66
characters, which is not what ADR-0012 bought. Our cap is char-based on purpose (readability of a long
single-line log for a CJK-heavy workload) and is four lines of code; this is the one place the audit
kept a local helper over a pi utility, and the reason is stated here.

**4. Truncation is visible.** `details.fullOutputPath` present means the row's meta carries
`truncated` (warning colour), so a human can tell a short run from a tail.

## Consequences

- **The text block is lossy by design** for oversized runs, and says so in-band. Nothing else changed:
  the 64 MiB budget (ADR-0003) still governs the _run_, this ADR governs what the _model reads_.
- **DSH divergence, deliberate.** `dsh-tools` caps nothing at this point (the audit found no
  `maxBytes`-style limit around `run_code`'s result). pi's contract wins here because a text block is
  read by pi's model in pi's window; DSH parity governs the program's execution, not the transcript's
  size. The alternatives were "hand the model megabytes" and "invent a PTC-specific ceiling" — both
  worse than pi's published one.
- Tests: `tests/run-code-tool.test.ts` runs a 3000-line program and asserts the footer, the dropped
  head, the file's completeness and `details.fullOutputPath`; `tests/render-ptc.test.ts` pins the meta.
