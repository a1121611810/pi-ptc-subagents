# Industry findings: terminal "running" indicators

Captured 2026-09-23 by a research subagent (background) for the pulse-visual
prototype. Full source-cited list of patterns real-world TUIs use to signal
"in progress" / "running" / "loading". The README abbreviates; this file is
the primary source.

## Top picks for a subtle single-row tool status

These three patterns are the most relevant to "show the program is running
subtly on a tool row":

1. **DSH `TextShimmer`** — a CSS keyframe that moves a gradient highlight
   across the row's own title text, so the glyphs stay put and only brightness
   sweeps across them. Used in DSH's PTC `run_code` row + parent process
   header (in lockstep). [`dsh-ptc-page-rendering.md`](../dsh-ptc-page-rendering.md),
   `ToolRow.tsx:212,222,226` and `ChatGroupSeat.tsx:117`.
2. **Codex's animated OSC title** — the working indicator lives in the
   terminal window title via OSC 0, _not on the row_. A braille glyph from
   U+2800–U+28FF cycles in the title bar while the row stays clean.
   [codexissues.com/issue/17198](https://codexissues.com/issue/17198-codex-cli-terminal-title-animation-issues-under-screen),
   [TUICommander Detection Matrix](https://tuicommander.com/docs/architecture/agents/detection-matrix.html).
3. **Aider's Knight-Rider scanner** — just `░█` ↔ `█░` overwriting itself with
   `\b\b` (no escape sequences, no cursor positioning). Two block-drawing
   characters, ~1 fps, with the task description inline.
   [TUICommander Aider page](https://tuicommander.com/docs/architecture/agents/aider.html).

## A. Spinner-style (rotating glyph)

1. **Braille dot ring** — `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` (10 frames, ~80 ms). The
   default for `cli-spinners`, Claude Code, Codex CLI, Gemini CLI. ~80 ms
   cadence. Source: [cli-spinners npm](https://www.npmjs.com/package/cli-spinners),
   [Alex Beals reverse-engineer](https://blog.alexbeals.com/posts/claude-codes-thinking-animation),
   [bubbles MiniDot](https://raw.githubusercontent.com/charmbracelet/bubbles/main/spinner/spinner.go) (12 fps).
2. **Braille cluster dots** — `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷` (8 frames, 10 fps).
   bubbles `Dot`. [source](https://raw.githubusercontent.com/charmbracelet/bubbles/main/spinner/spinner.go).
3. **Pipe/line** — `| / - \` (4 frames, ~10 fps). lazygit default, indicatif
   default for unknown spinners, classic *nix `cli-spinner`.
   [lazygit config](https://sourcegraph.com/github.com/jesseduffield/lazygit/-/blob/docs/Config.md),
   [cli-spinner npm](https://www.npmjs.com/package/cli-spinner).
4. **Bespoke asterism ring** — `· ✢ ✳ ✶ ✻ ✽` cycling through hexagram-like
   glyphs (U+2720–U+273F). Claude Code's branded spinner. Custom, not from
   `cli-spinners`. [Alex Beals](https://blog.alexbeals.com/posts/claude-codes-thinking-animation),
   [TUICommander Detection Matrix](https://tuicommander.com/docs/architecture/agents/detection-matrix.html).
5. **Spaced asterism** — single `✦` cycling (or static). Gemini CLI's
   "witty phrases" mode uses this glyph.
   [Alex Beals](https://blog.alexbeals.com/posts/claude-codes-thinking-animation).
6. **Knight Rider scanner** — `░█` ↔ `█░` overwriting itself with `\b\b`, ~1
   fps. Aider's signature spinner.
   [TUICommander Aider page](https://tuicommander.com/docs/architecture/agents/aider.html).
7. **Pulse bar** — `█ ▓ ▒ ░` cycling (4 frames, 8 fps). bubbles `Pulse`.
   [source](https://raw.githubusercontent.com/charmbracelet/bubbles/main/spinner/spinner.go).
8. **Meter** — `▱▱▱ → ▰▰▰ → ▱▱▱` (7 frames, 7 fps). bubbles `Meter`. Same source.
9. **Moon phases** — `🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘` (8 frames, 8 fps). bubbles
   `Moon`, also seen in several "thinking" indicators. Same source.
10. **Bullet + parenthesised timer** — static `•` glyph followed by `(4m 55s •
esc to interrupt)`. The glyph does _not_ rotate; only the elapsed-seconds
    counter advances. Codex CLI.
    [TUICommander Detection Matrix](https://tuicommander.com/docs/architecture/agents/detection-matrix.html).
11. **Animated OSC title glyph** — terminal _title bar_ carries `⠋⠙⠹…` from
    the braille block, while the row itself shows nothing. Codex CLI (full
    braille range), Claude Code uses alternating `◐`/`◑` halves (U+25D0/U+25D1)
    in OSC 0. [codexissues.com 17198](https://codexissues.com/issue/17198-codex-cli-terminal-title-animation-issues-under-screen),
    [Clusto docs](https://clusto.app/docs/configuration).

## B. Shimmer / pulse (dim/bright cycle, character wave)

12. **TextShimmer (moving highlight)** — text is rendered at ~30 % alpha, and
    a brighter gradient highlight band sweeps left-to-right across it.
    Implemented as a CSS keyframe with `background-clip: text`. Used by DSH for
    both the process-header label (`ChatGroupSeat.tsx:117`) and the tool-row
    title + summary (`ToolRow.tsx:212,222,226`).
    [`dsh-ptc-page-rendering.md`](../dsh-ptc-page-rendering.md).
13. **Static dot + colour pulse** — single dot whose foreground colour cycles
    between two values, no glyph change. tmux-agent-indicator uses this.
    Surveyed in [arXiv "Deterministic Motion Grammar"](https://arxiv.org/html/2608.10689).
14. **Pulse / static dot** — colour-carried state with no glyph animation.
    Codemux. Same source.

## C. Progress bar / partial fill (`▓▓▓░░░`)

15. **npm install bar** — `█` filled + `░` empty + thin "spinner" column at
    the right edge. The classic indicator at the bottom of every `npm install`.
    Source issue confirming design:
    [nodejs/node #5077](https://github.com/nodejs/node/issues/5077),
    [npm/npm #11283](https://github.com/npm/npm/issues/11283) (history of the
    famous "fancy progress bar slowed installs" regression).
16. **`▰▰▰…▱▱▱` with ETA / elapsed / %** — indicatif `ProgressBar`. Default
    refresh 20 Hz. Used by cargo for `cargo install`, `cargo build`.
    [indicatif docs](https://docs.rs/indicatif/latest/indicatif/struct.ProgressBar.html),
    [pv(1) man page](https://man7.org/linux/man-pages/man1/pv.1.html).
17. **`■ ⬝ ⬝ ⬝` partial-fill (block + small square)** — OpenCode's footer
    spinner / progress.
    [TUICommander Detection Matrix](https://tuicommander.com/docs/architecture/agents/detection-matrix.html).
18. **`━━━ ●━━━━━ ` line-progress** — `─` for empty, `●` for the head, used
    by `progress` (Node) and many "long task" bars.
    [progress (r-lib)](https://r-lib.org/progress).

## D. Trailing dots / incremental indicators

19. **Ellipsis stepper** — empty → `.` → `..` → `...` (4 frames, 3 fps).
    bubbles `Ellipsis`. Ships with most TUI suites as the default for
    indeterminate tasks.
    [source](https://raw.githubusercontent.com/charmbracelet/bubbles/main/spinner/spinner.go).
20. **Animated "working verb" + dot** — `Thinking.` → `Thinking…`, with the
    trailing punctuation cycling (`.` → `…`). Claude Code pairs this with
    the asterism spinner, but the punctuation alone is a distinct sub-signal.
    [tweakcc docs](https://www.npmjs.com/package/tweakcc),
    [tweakcc HN thread](https://news.ycombinator.com/item?id=45028282).
21. **Rotating "verb" word** — `Cogitating…`, `Brewing…`, `Cogitating…`,
    `Schlepping…` (184-entry pool). Claude Code pairs with `…` punctuation.
    Static trailing `…`, only the verb changes.
    [Alex Beals full list](https://blog.alexbeals.com/posts/claude-codes-thinking-animation).
22. **Inline text + ticker** — `Reading files… (12s)` or `· Considering…`,
    with a bracketed elapsed counter.
    [TUICommander Output Parser](https://tuicommander.com/docs/backend/output-parser.html).

## E. Colour-only shifts

23. **Foreground blink (no glyph change)** — text oscillates between two RGB
    values, ~1 s period. Codemux, tmux-agent-indicator (see B.13). Same
    [arXiv source](https://arxiv.org/html/2608.10689).
24. **Status-pill colour swap** — entire row recoloured (e.g. yellow→green)
    when state changes; no glyph. Used by DSH's `data-state="running"` vs
    `"ok"` attribute on `ToolRow`, plus `css.errorSummary` for errors
    (`tool-call-model.ts:218–220`, `ToolRow.tsx:335`).
    [`dsh-ptc-page-rendering.md`](../dsh-ptc-page-rendering.md).
25. **Reverse-video block highlight** — Aider highlights file names in
    approval prompts with `\033[7m`. Not a "running" indicator but the same
    colour-only mechanism.
    [TUICommander Aider page](https://tuicommander.com/docs/architecture/agents/aider.html).

## F. Anything else unique

26. **OSC 9;4 native progress bar** — single escape sequence updates the host
    terminal's taskbar / dock progress (iTerm2, Windows Terminal, ConEmu).
    Used by harness, Claude Code v2.1.x.
    [capotej/harness CHANGELOG](https://github.com/capotej/harness/blob/main/CHANGELOG.md),
    [pi-progress-bar skill](https://awesome-pi.site/misc/),
    [Claude Code sandbox analysis](https://agent-safehouse.dev/docs/agent-investigations/claude-code).
27. **Three-second heartbeat on a separate line** — if the tool has not emitted
    progress for 3 s, render a heartbeat indicator elsewhere. vibe-trading-ai
    pattern. [PyPI](https://pypi.org/project/vibe-trading-ai/0.1.11/),
    [Libraries.io](https://libraries.io/pypi/vibe-trading-ai).
28. **Per-phase marker** — `validate / simulate / finalize` stamps the current
    stage alongside the spinner, so users see structure, not just liveness.
    vibe-trading-ai. Same sources.
29. **Animated OSC 0 only (rest of UI static)** — the entire "is the agent
    working" signal lives in the terminal title bar, not in any UI element.
    Codex and Claude Code in tmux.
    [codexissues.com/issue/17198](https://codexissues.com/issue/17198-codex-cli-terminal-title-animation-issues-under-screen).
30. **Paired glyph that swaps position** — `░█` ↔ `█░`. Technically still a
    glyph swap but the "scan" feel is the point; Knight-Rider aesthetic.
    Aider. [TUICommander Aider page](https://tuicommander.com/docs/architecture/agents/aider.html).
31. **Hide-cursor + intermittent spinner for prompt-area tools** — combine
    `\033[?25l` (hide cursor) with a periodic spinner tick. Several TUIs
    (lazygit included) use this.
    [lazygit issue #4734](https://github.com/jesseduffield/lazygit/issues/4734),
    [TUICommander Aider rendering mechanics](https://tuicommander.com/docs/architecture/agents/aider.html).

## Dependency-footprint summary

- **Zero-dependency, ~50 lines**: Aider Knight-Rider, npm-stdio progress, `cli-spinner`, `unicode-spinner`.
- **Tiny library**: `cli-spinners` (80+ spinner presets, just data); bubbles/spinner (Bubble Tea's, ~150 LOC + presets).
- **Medium library**: `ora` (Node, ANSI cursor handling + spinners); `indicatif` (Rust, full bars + ETA + spinners); `yaspin` (Python port of ora).
- **Framework-embedded**: DSH `TextShimmer` is a React component on top of CSS; Bubble Tea's `Spinner` ships with the framework; Ink-based agents (Claude Code, Codex) embed their spinner in the app's render loop directly.

For pi-ptc's TUI tool row specifically, the patterns that translate cleanly are:
**#1 (braille ring)**, **#12 (TextShimmer)**, **#19 (ellipsis stepper)**,
**#21 (rotating verb)**, and **#24 (status colour swap)** — the DSH note
explicitly recommends a `▓▒░` shimmer or a `█`-trailing suffix, which matches
#12 and #19.
