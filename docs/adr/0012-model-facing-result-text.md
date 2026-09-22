# Model-facing tool-result text is cleaned and laid out for reading

Every built-in pi tool runs its result text through `stripAnsi` → `sanitizeBinaryOutput` → drop
`\r` before the model sees it (`pi-coding-agent`: `dist/core/tools/render-utils.js`). The PTC
tools assemble their own text block and did none of it, so a program that returned captured shell
output shipped `\u001b[38;2;212;212;212m` as literal escapes, and any string containing a newline
arrived `JSON.stringify`-escaped as `\n`. Both are noise the model pays tokens to read. The text
block is now cleaned the same way, and completion values render as readable summaries rather than
as raw JSON.

Status: accepted (2026-09-22). Presentation only: no protocol, dispatcher or binding behaviour
changes; `details` and everything a program can see stay exactly as they were.

## Decision

**1. The text block is the cleaned copy; `details` is the raw one.** Sanitising happens only while
assembling `content[0].text` (`common.ts: renderToolResult` / `codeRunFailedError`). `details.logs`
keeps its ANSI so the TUI can go on rendering real colours (`@earendil-works/pi-tui`'s `Text`
understands them), and a binding's result inside a program is untouched — a program that wants
coloured bytes to write into a file still has them. Cleaning at the binding layer was rejected: it
would silently change the data a program reads.

**2. The three steps are mirrored locally.** pi exports neither helper (its `exports` map has only
`.`, `./rpc-entry`, `./client`, `./experimental/plugin`), so `src/tools/text.ts` reproduces them:
strip ANSI (ansi-regex/strip-ansi shape, MIT), remove `\r` rather than treat it as a line break,
drop control characters other than `\n`/`\t` and the `U+FFF9..U+FFFB` format characters that break
width math. Lone surrogates fall out of code-point iteration.

**3. Completion values render for a reader, not for a parser.** `JSON.stringify(value, null, 2)`
was the whole format before. Now: a top-level string is verbatim; a value whose compact form
(`{key: value}`, unquoted identifier keys — the same style `render.ts` already uses for its
one-line summary) fits in 100 characters stays on one line; anything else becomes an indented block
with braces on the key's line, and a string with real newlines keeps them, indented under its key.
Every line is capped at 200 characters with a trailing `…`.

## Consequences

- **The text block is no longer JSON**, deliberately. A model that wanted to `JSON.parse` a result
  cannot; anything structured should read `details`, which is unchanged and still lossless.
- This is the one place the package chooses presentation over DSH parity on the model-facing side.
  ADR-0003's byte budget and R1 §3's failure-message shape still hold — sanitising runs before the
  text is assembled, and the cap only ever shortens it.
- Tests that pinned the old pretty-printed expectations now assert the readable form
  (`tests/text.test.ts`, `tests/run-code-tool.test.ts`, `tests/workflow-tool.test.ts`).

Amended 2026-09-22 by [ADR-0015](./0015-pi-truncation-contract.md): the assembled block is now capped
by pi's truncation contract (50 KB / 2000 lines, tail kept, untruncated text written to a temp file)
instead of only by the per-line cap. The per-line cap below is unchanged and ADR-0015 §3 records why it
stays local rather than using pi's byte-based `truncateLine`.
