# PROTOTYPE (throwaway): how should a "running PTC row" look in the TUI?

**Question.** Two ADR drafts will change the PTC row's partial-state render:
one makes the parent row pulse while a run is in flight, the other adds an
"always-visible sub-call tree" beneath it (each sub-call with its own state).
For the partial state, what visual treatment reads well in a pi transcript
column — same chars, dim/bright cycle; a leading spinner glyph; trailing dots;
something else? DSH uses `TextShimmer` (a moving highlight band); pi's own TUI
ships `Loader` (braille spinner). Are there better industry options we haven't
considered?

**Mechanism constraints (settled in `/grill-with-docs` round 1):**

- Reuse pi primitives for animation machinery: `setInterval(() => context.invalidate(), N)`
  is the bash-renderer idiom, `context.invalidate()` is pi's re-render trigger,
  `theme.fg(slot, ...)` is the colour interface, `Loader` is pi's existing
  animated component.
- **Visual treatment is open.** The user explicitly freed visuals from the
  "use pi primitives only" constraint ("视觉这个东西不影响功能,我们可以怎么好看怎么来").

## Run it

```bash
node docs/research/prototype-pulse-tui-variants/probe.mjs
open docs/research/prototype-pulse-tui-variants/comparison.html
```

The script writes two outputs:

- **stdout** — ANSI-coloured text. In a TTY you see actual colours; piped to a
  file you see escape sequences (`sed 's/\x1b\[[0-9;]*m//g'` strips them).
  Useful when running in a TTY.
- **`comparison.html`** (next to the script) — a browser-renderable side-by-side
  comparison. Open it in any browser (Firefox, Safari, Chrome) to see all 10
  variants with dim / underline / colour-shift styles actually rendered. **This
  is the only way to see the difference between variants A, B, H, I** — they
  rely on dim / underline / colour, which ANSI codes may strip when scrollback
  is copied.

## Variants prototyped

10 partial-state visuals × 4 consecutive frames each, plus a settled-state
control line. Ordered roughly by relevance: A is the design DSH itself uses
(moving highlight band), B is a simpler whole-line dim cycle, C is Aider's
Knight-Rider scanner, then the spinner family (D-F), then the non-spinner
alternatives (G-J).

| #   | Visual                                          | Cadence       | Notes                                                           |
| --- | ----------------------------------------------- | ------------- | --------------------------------------------------------------- |
| A   | DSH TextShimmer (moving highlight band)         | 150ms         | One char at a time bright, rest dim; bright position sweeps L→R |
| B   | Whole-line dim/bright cycle                     | 150ms         | Simpler than A; the entire line toggles together                |
| C   | Knight-Rider scanner (Aider)                    | 1000ms        | `░█ ↔ █░`, two chars, very minimal                              |
| D   | Braille spinner (pi-tui Loader default)         | 80ms          | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`                                           |
| E   | Dots spinner (charm.sh bubbles MiniDot)         | 100ms         | `⠁ ⠂ ⠄ ⢀`                                                       |
| F   | ASCII spinner (classic)                         | 100ms         | `                                                               | / - \` |
| G   | Trailing dots (ellipsis stepper)                | 500ms         | `… / . / .. / ...`                                              |
| H   | Underline pulse                                 | 150ms         | Toggles underline on description                                |
| I   | Colour shift only (description: accent ↔ muted) | 150ms         | No char change                                                  |
| J   | Hybrid: trailing dots + dim header              | 150ms + 500ms | Two motions at different cadences                               |

## Captured output

Plain-text frames (ANSI codes stripped; run the script for actual colours):

```
=== settled (control — what the row looks like when the run completes) ===
└─ PTC  Verify file integrity                                        • 1 image · 536ms

=== A · DSH TextShimmer (moving highlight band) ===
  frame 0: └─ PTC  Verify file integrity                    (V bright, rest dim)
  frame 1: └─ PTC  Verify file integrity                    (f bright, rest dim)
  frame 2: └─ PTC  Verify file integrity                    (i bright, rest dim)
  frame 3: └─ PTC  Verify file integrity                    (g bright, rest dim)

=== B · Whole-line dim/bright cycle ===
  frame 0: └─ PTC  Verify file integrity       • 1 image · 536ms    (whole line dim)
  frame 1: └─ PTC  Verify file integrity       • 1 image · 536ms    (whole line bright)
  frame 2: └─ PTC  Verify file integrity       • 1 image · 536ms    (whole line dim)
  frame 3: └─ PTC  Verify file integrity       • 1 image · 536ms    (whole line bright)

=== C · Knight-Rider scanner (Aider) ===
  frame 0: ░█ PTC  Verify file integrity
  frame 1: █░ PTC  Verify file integrity
  frame 2: ░█ PTC  Verify file integrity
  frame 3: █░ PTC  Verify file integrity

=== D · Braille spinner (pi-tui Loader default) ===
  frame 0: ⠋ PTC  Verify file integrity
  frame 1: ⠙ PTC  Verify file integrity
  frame 2: ⠹ PTC  Verify file integrity
  frame 3: ⠸ PTC  Verify file integrity

=== E · Dots spinner (charm.sh bubbles MiniDot) ===
  frame 0: ⠁ PTC  Verify file integrity
  frame 1: ⠂ PTC  Verify file integrity
  frame 2: ⠄ PTC  Verify file integrity
  frame 3:⢀ PTC  Verify file integrity

=== F · ASCII spinner (classic) ===
  frame 0: | PTC  Verify file integrity
  frame 1: / PTC  Verify file integrity
  frame 2: - PTC  Verify file integrity
  frame 3: \ PTC  Verify file integrity

=== G · Trailing dots (ellipsis stepper) ===
  frame 0: PTC  Verify file integrity.
  frame 1: PTC  Verify file integrity..
  frame 2: PTC  Verify file integrity...
  frame 3: PTC  Verify file integrity..

=== H · Underline pulse ===
  frame 0: PTC  Verify file integrity                  (underlined)
  frame 1: PTC  Verify file integrity                  (plain)
  frame 2: PTC  Verify file integrity                  (underlined)
  frame 3: PTC  Verify file integrity                  (plain)

=== I · Colour shift only ===
  frame 0: PTC  Verify file integrity                  (accent colour)
  frame 1: PTC  Verify file integrity                  (muted colour)
  frame 2: PTC  Verify file integrity                  (accent colour)
  frame 3: PTC  Verify file integrity                  (muted colour)

=== J · Hybrid: trailing dots + dim header ===
  frame 0: PTC  Verify file integrity.                 (whole line dim, trailing .)
  frame 1: PTC  Verify file integrity..                (whole line bright, trailing ..)
  frame 2: PTC  Verify file integrity...               (whole line dim, trailing ...)
  frame 3: PTC  Verify file integrity..                (whole line bright, trailing ..)
```

## What industry actually does

31 patterns surveyed (full list in research findings at
`docs/research/prototype-pulse-tui-variants/industry-findings.md` —
abbreviated to fit here). Highlights relevant to a pi-ptc TUI tool row:

### Top three picks for "subtle single-row status"

1. **DSH `TextShimmer` (moving highlight)** — glyphs stay put, a brighter
   gradient highlight sweeps left-to-right across the description. Implemented
   as a CSS keyframe with `background-clip: text`. Used by DSH for both the
   process-header label and the tool-row title + summary.
   Source: `dsh-ptc-page-rendering.md`, `ToolRow.tsx:212,222,226` +
   `ChatGroupSeat.tsx:117`.

2. **Codex's animated OSC title** — the "is the agent working" signal lives
   in the terminal _title bar_ via OSC 0 (a braille glyph from U+2800–U+28FF
   cycles), not on the row. The row stays completely clean.
   Source: codexissues.com/issue/17198, TUICommander Detection Matrix.

3. **Aider's Knight-Rider scanner** — `░█ ↔ █░` overwriting itself with
   `\b\b`, ~1 fps. Two chars, no escape sequences for the motion itself,
   task description stays untouched. Distinctive; uncommon in the CLI world.
   Source: TUICommander Aider page.

### Pattern families

| Family                     | Examples                                                       | Cadence              | Visible without animation?          |
| -------------------------- | -------------------------------------------------------------- | -------------------- | ----------------------------------- |
| Spinner (braille)          | pi-tui Loader, Codex, Claude Code, Gemini, bubbles MiniDot     | 80–120ms             | Yes (glyph shape)                   |
| Spinner (ASCII)            | lazygit default, indicatif, classic *nix `cli-spinner`         | 100ms                | Yes                                 |
| Spinner (bespoke)          | Claude Code's asterism ring, Gemini's `✦`, Codex's `◐◑` halves | 80–150ms             | Yes                                 |
| Knight-Rider               | Aider                                                          | 1000ms               | Yes                                 |
| Shimmer (moving highlight) | DSH `TextShimmer`                                              | 150ms                | No (motion-only)                    |
| Shimmer (whole-line dim)   | simpler DSH-derivative                                         | 150ms                | No (motion-only)                    |
| Colour pulse (no glyph)    | Codemux, tmux-agent-indicator                                  | 1000ms               | No                                  |
| Trailing dots / ellipsis   | bubbles Ellipsis, npm-install, curl                            | 500ms                | Yes (text differs)                  |
| Animated verb pool         | Claude Code's "Cogitating… / Brewing…"                         | 2000ms               | Yes (text differs)                  |
| Bullet + elapsed timer     | Codex CLI `• (4m 55s)`                                         | 1000ms (timer ticks) | Yes                                 |
| Progress bar               | npm, indicatif, cargo install                                  | 20Hz                 | **Yes — partial fill IS the state** |
| OSC title indicator        | Codex, Claude Code (Windows Terminal progress OSC 9;4)         | 80ms                 | Yes (in title bar)                  |

### Dependency footprint

- **Zero-dep, ~50 LOC**: Aider Knight-Rider, npm-stdio progress, `cli-spinner`, `unicode-spinner`
- **Tiny library**: `cli-spinners` (80+ spinner presets, just data); bubbles/spinner (Bubble Tea, ~150 LOC + presets)
- **Medium library**: `ora` (Node, ANSI cursor + spinners); indicatif (Rust, full bars + ETA + spinners); `yaspin` (Python port of ora)
- **Framework-embedded**: DSH `TextShimmer` (React on CSS); Bubble Tea's `Spinner` (in framework); Ink-based agents (Claude Code, Codex) embed spinners in the render loop

## Trade-offs the variants surface

| Variant                | Reads as "running" instantly?        | Competes with text? | Looks busy in a column of 30 PTC rows? | Sub-call rows work the same way?        |
| ---------------------- | ------------------------------------ | ------------------- | -------------------------------------- | --------------------------------------- |
| A DSH moving highlight | Mild — needs eye to learn the sweep  | No                  | No                                     | Yes (each row has its own sweep)        |
| B whole-line dim       | No — relies on motion the eye learns | No                  | No                                     | Yes                                     |
| C Knight-Rider         | Yes — distinctive pattern            | No (2 chars only)   | No                                     | Yes                                     |
| D braille spinner      | Yes — universal "loading"            | Mild                | Mild                                   | Yes                                     |
| E dots spinner         | Yes                                  | Mild                | Mild                                   | Yes                                     |
| F ASCII spinner        | Yes                                  | Mild                | Mild                                   | Yes                                     |
| G trailing dots        | Yes — distinct from settled rows     | No                  | No                                     | Yes (dots are easy to spot in a column) |
| H underline pulse      | No — subtle                          | Mild                | No                                     | Yes                                     |
| I colour shift only    | Mild                                 | No                  | No                                     | Yes                                     |
| J hybrid               | Yes — both motions                   | Mild                | Mild (two cadences)                    | Yes                                     |

## How the constraints narrow the field

Given the user-set constraints ("mechanism = pi primitives, visual = free"):

- **D braille spinner** is the **most pi-native** — it is literally pi's Loader. Zero new mechanism code; just compose it into the row during partial state.
- **G trailing dots** is the **most readable in a column of 30 PTC rows** — the running row's text differs from settled rows, so the eye picks it out without motion.
- **A DSH moving highlight** is the **most DSH-aligned** — and looks the most "polished" if implemented well, but costs per-character theming on every render (the rest are single `theme.fg` wraps).
- **C Knight-Rider** is the most distinctive but the slowest (1fps) and the most "personality-loaded" (looks like Aider, not like DSH).

## Verdict

**A · DSH TextShimmer (moving highlight band).**

Same text content (no character-level changes that could break a column scan);
a brighter accent character sweeps left-to-right across the description at
150ms cadence. Matches `ToolRow.tsx:212,222,226` + `ChatGroupSeat.tsx:117` in
the upstream DSH reference (`dsh-ptc-page-rendering.md`).

Trade-off acknowledged: variant A is **subtle** — the screenshot shows the
bright character's position changes are visually quiet compared to variant G
(trailing dots) or variant D (braille spinner). This is the cost of DSH's
"polished, doesn't compete with text" design; the user picked it on the basis
that polished matters more than obvious, and on the precedent of DSH itself
making the same trade-off.

Implementation constraints (carried forward into the ADR):

- **Mechanism**: pi-native. `setInterval(() => context.invalidate(), 150)` in
  `renderResult`, mirroring `bash.js:121–122`. `context.invalidate()` calls
  `this.invalidate()` + `this.ui.requestRender()`, both pi-`tool-execution.js`.
- **Visual**: per-character colour split on the description. `PtcRow.render()`
  reads `Date.now() - state.startedAt`, computes `pos = floor(elapsed / 150) %
(desc.length + 1)`, and renders each character with either `theme.fg("dim",
c)` (off-band) or `theme.fg("accent", c)` (on-band).
- **Settle**: when `options.isPartial === false`, `clearInterval` and force
  the bright position to -1 (no character highlighted) so the settled line is
  uniformly accent. Same as `bash.js:124–130`.
- **Sub-call rows**: same shimmer treatment. A `SubCallRow` Container under the
  parent `PtcRow` (post-compute, per ADR-0021) runs the same setInterval and
  computes its own bright position. The two cadences are independent (each row
  starts its own timer on entering the running state).

Not in scope for this verdict:

- ADR-0021 (sub-call tree shape, content per row, truncation cap, error
  states) is still pending. The shimmer's effect on sub-call rows is described
  above only to flag the integration seam — the sub-call ADR will own the
  full design there.

## Not part of the product

Nothing in `src/` imports this directory. It exists to hold the visual
comparison while the two ADR drafts are still in flight; delete it once the
decisions are settled.
