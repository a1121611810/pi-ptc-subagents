#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway. Render 10 visual variants of a "running PTC row" as a
 * side-by-side comparison.
 *
 *   node docs/research/prototype-pulse-tui-variants/probe.mjs
 *
 * Outputs:
 *   stdout  — ANSI-coloured text (visible in a TTY)
 *   comparison.html — browser-renderable side-by-side comparison, written next
 *                     to this file. Open it (`open comparison.html`) to see all
 *                     variants with dim / underline / colour-shift styles
 *                     actually rendered.
 *
 * Why both: the variants that depend on dim/underline/colour (A, B, H, I)
 * look identical in raw terminal scrollback when ANSI codes don't render.
 * The HTML lets a human see the actual visual treatment.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ---------- ANSI / HTML renderers ----------

const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BRIGHT = "\x1b[22m";
const ACCENT = "\x1b[36m";
const MUTED = "\x1b[90m";
const BOLD = "\x1b[1m";
const UNDERLINE = "\x1b[4m";
const NO_UNDERLINE = "\x1b[24m";

const ANSI = {
  tree: (s) => s,
  title: (s) => `${BOLD}${s}${R}`,
  plain: (s) => s,
  plain2: (s) => s,
  dim: (s) => `${DIM}${s}${BRIGHT}`,
  dim2: (s) => `${DIM}${s}${BRIGHT}`,
  accent: (s) => `${ACCENT}${s}${R}`,
  muted: (s) => `${MUTED}${s}${R}`,
  meta: (s) => `${DIM}${s}${BRIGHT}`,
  underline: (s) => `${UNDERLINE}${s}${NO_UNDERLINE}`,
};

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HTML = {
  tree: (s) => `<span class="t-tree">${escapeHtml(s)}</span>`,
  title: (s) => `<span class="t-title">${escapeHtml(s)}</span>`,
  plain: (s) => escapeHtml(s),
  plain2: (s) => escapeHtml(s),
  dim: (s) => `<span class="t-dim">${escapeHtml(s)}</span>`,
  dim2: (s) => `<span class="t-dim">${escapeHtml(s)}</span>`,
  accent: (s) => `<span class="t-accent">${escapeHtml(s)}</span>`,
  muted: (s) => `<span class="t-muted">${escapeHtml(s)}</span>`,
  meta: (s) => `<span class="t-meta">${escapeHtml(s)}</span>`,
  underline: (s) => `<span class="t-underline">${escapeHtml(s)}</span>`,
};

const renderAnsi = (parts) => parts.map((p) => ANSI[p.style](p.text)).join("");
const renderHtml = (parts) => parts.map((p) => HTML[p.style](p.text)).join("");

// ---------- Compose helper ----------

/**
 * Turn a flat key→text map into an ordered Part[]. Order follows the map's key
 * insertion order (JS guarantees this for string keys), not an external schema
 * — this matters for variants like A where the bright character's position in
 * the description is the entire point.
 *
 * Recognized map keys: tree, muted, plain, plain2, title, dim, accent, underline, meta.
 * Two "plain" slots exist so a frame can have plain text in two places (e.g. after
 * the glyph and after the title) without colliding.
 */
const VALID_STYLES = new Set([
  "tree",
  "muted",
  "plain",
  "plain2",
  "title",
  "dim",
  "dim2",
  "accent",
  "underline",
  "meta",
]);

function compose(map) {
  /** @type {{style: string; text: string}[]} */
  const parts = [];
  for (const key of Object.keys(map)) {
    if (!VALID_STYLES.has(key)) continue;
    const text = map[key];
    if (typeof text !== "string" || text.length === 0) continue;
    parts.push({ style: key, text });
  }
  return parts;
}

// ---------- Common text ----------

const TREE_ROOT = "└─ ";
const PTC_TEXT = "PTC";
const DESC_TEXT = "Verify file integrity";
const RIGHT_TEXT = "• 1 image · 536ms";
const PADDING = " ".repeat(40);

function settledParts() {
  return compose({
    tree: TREE_ROOT,
    title: PTC_TEXT,
    plain: "  ",
    accent: DESC_TEXT,
    plain2: PADDING,
    meta: RIGHT_TEXT,
  });
}

// ---------- Variants (10 × 4 frames, structured) ----------

/**
 * @typedef {{ style: string, text: string }} Part
 * @typedef {{ name: string; note: string; cadenceMs: number; frames: Part[][] }} Variant
 */

/** @type {Variant[]} */
const variants = [
  {
    name: "A · DSH TextShimmer (moving highlight band)",
    note: "DSH's actual implementation: glyphs stay put, a brighter gradient highlight sweeps left-to-right across the description. We approximate by highlighting one character at a time while the rest are dim.",
    cadenceMs: 150,
    frames: [
      // V bright
      { tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: "V", dim: "erify file integrity" },
      // f bright
      {
        tree: TREE_ROOT,
        title: PTC_TEXT,
        plain: "  ",
        dim: "Veri",
        accent: "f",
        dim2: "y file integrity",
      },
      // space bright (mid-description, to show sweep continuation)
      {
        tree: TREE_ROOT,
        title: PTC_TEXT,
        plain: "  ",
        dim: "Verify",
        accent: " ",
        dim2: "file integrity",
      },
      // l bright (in "file")
      {
        tree: TREE_ROOT,
        title: PTC_TEXT,
        plain: "  ",
        dim: "Verify fi",
        accent: "l",
        dim2: "e integrity",
      },
    ].map(compose),
  },
  {
    name: "B · Whole-line dim/bright cycle",
    note: "Simpler than A: the entire line dims/brightens together, no per-character work. Single theme.fg wrap. Subtle motion; less visually distinctive than A.",
    cadenceMs: 150,
    frames: [
      compose({ tree: TREE_ROOT, dim: PTC_TEXT + "  " + DESC_TEXT + PADDING + " " + RIGHT_TEXT }),
      compose({
        tree: TREE_ROOT,
        title: PTC_TEXT,
        plain: "  ",
        accent: DESC_TEXT,
        plain2: PADDING,
        meta: RIGHT_TEXT,
      }),
      compose({ tree: TREE_ROOT, dim: PTC_TEXT + "  " + DESC_TEXT + PADDING + " " + RIGHT_TEXT }),
      compose({
        tree: TREE_ROOT,
        title: PTC_TEXT,
        plain: "  ",
        accent: DESC_TEXT,
        plain2: PADDING,
        meta: RIGHT_TEXT,
      }),
    ],
  },
  {
    name: "C · Knight-Rider scanner (Aider's signature)",
    note: "Two block-drawing chars (░█ / █░) overwriting themselves with backspace. No escape sequences for the motion itself. Distinctive aesthetic; description stays untouched. ~1 fps.",
    cadenceMs: 1000,
    frames: [
      compose({
        tree: TREE_ROOT,
        muted: "░█",
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
      compose({
        tree: TREE_ROOT,
        muted: "█░",
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
      compose({
        tree: TREE_ROOT,
        muted: "░█",
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
      compose({
        tree: TREE_ROOT,
        muted: "█░",
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
    ],
  },
  {
    name: "D · Braille spinner (pi-tui Loader default)",
    note: "Spinner glyph rotates; text static. Matches pi's Loader frames exactly (⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏). Most explicit 'running' signal — universal 'loading' affordance, used by Codex, Claude Code, Gemini CLI.",
    cadenceMs: 80,
    frames: ["⠋", "⠙", "⠹", "⠸"].map((g) =>
      compose({
        tree: TREE_ROOT,
        muted: g,
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
    ),
  },
  {
    name: "E · Dots spinner (charm.sh bubbles MiniDot)",
    note: "Filled dot morphing around a circle (⠁ ⠂ ⠄ ⢀). Lighter visual weight than braille ring; bubbles' default. 100ms cadence.",
    cadenceMs: 100,
    frames: ["⠁", "⠂", "⠄", "⢀"].map((g) =>
      compose({
        tree: TREE_ROOT,
        muted: g,
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
    ),
  },
  {
    name: "F · ASCII spinner (classic terminal)",
    note: "Pipe / slash / dash / backslash. Universally recognizable from 1970s terminals; works in any TTY regardless of UTF-8 support. lazygit + indicatif default for unknown spinners.",
    cadenceMs: 100,
    frames: ["|", "/", "-", "\\"].map((g) =>
      compose({
        tree: TREE_ROOT,
        muted: g,
        plain: " ",
        title: PTC_TEXT,
        plain2: "  ",
        accent: DESC_TEXT,
      }),
    ),
  },
  {
    name: "G · Trailing dots (incremental ellipsis stepper)",
    note: "Description cycles . / .. / ... / ..  bubbles' Ellipsis, npm-install style. Text actually changes — easy to scan a column of rows and pick out the running one.",
    cadenceMs: 500,
    frames: [".", "..", "...", ".."].map((d) =>
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT, muted: d }),
    ),
  },
  {
    name: "H · Underline pulse",
    note: "Underline toggles on/off on the description only. Cursor-blink heritage; rare in modern TUIs but visually distinct when the row has no other motion.",
    cadenceMs: 150,
    frames: [
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", underline: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", underline: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT }),
    ],
  },
  {
    name: "I · Colour shift only (description: accent ↔ muted)",
    note: "Same text; description colour alternates between accent and muted. No character changes; the description is still readable but pulls attention. Codemux + tmux-agent-indicator do this.",
    cadenceMs: 150,
    frames: [
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", muted: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", muted: DESC_TEXT }),
    ],
  },
  {
    name: "J · Hybrid (trailing dots + dim header, two cadences)",
    note: "Trailing dots make the row obviously 'in progress' in a column scan; the title dims at a different cadence (150ms vs 500ms) so the two motions don't merge.",
    cadenceMs: 150,
    frames: [
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", dim: DESC_TEXT, muted: "." }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT, muted: ".." }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", dim: DESC_TEXT, muted: "..." }),
      compose({ tree: TREE_ROOT, title: PTC_TEXT, plain: "  ", accent: DESC_TEXT, muted: ".." }),
    ],
  },
];

// ---------- ANSI output ----------

console.log("=== settled (control — what the row looks like when the run completes) ===");
console.log(renderAnsi(settledParts()));
console.log();

for (const v of variants) {
  console.log(`=== ${v.name} ===`);
  console.log(`note: ${v.note}`);
  console.log(`cadence: ${v.cadenceMs}ms`);
  console.log("frames (consecutive states, one cycle):");
  for (let i = 0; i < v.frames.length; i++) {
    console.log(`  frame ${i}: ${renderAnsi(v.frames[i])}`);
  }
  console.log();
}

// ---------- HTML output ----------

function buildHtml() {
  const cards = variants
    .map(
      (v) => `
    <section class="card">
      <h2>${escapeHtml(v.name)}</h2>
      <p class="note">${escapeHtml(v.note)}</p>
      <p class="cadence">cadence: ${v.cadenceMs}ms</p>
      <div class="frames">
        ${v.frames
          .map(
            (f, i) => `
          <div class="frame">
            <div class="frame-num">frame ${i}</div>
            <div class="frame-line">${renderHtml(f)}</div>
          </div>`,
          )
          .join("")}
      </div>
    </section>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TUI pulse variants</title>
<style>
  body {
    background: #1e1e1e;
    color: #d4d4d4;
    font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 14px;
    padding: 24px;
    margin: 0;
    line-height: 1.5;
  }
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  .subtitle { color: #858585; margin-bottom: 24px; }
  .settled, .card {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .settled h2, .card h2 {
    margin: 0 0 8px 0;
    font-size: 15px;
    color: #d4d4d4;
    font-weight: bold;
  }
  .settled .note, .card .note {
    color: #9e9e9e;
    font-style: italic;
    margin-bottom: 12px;
  }
  .settled .cadence, .card .cadence {
    color: #d4d4d4;
    margin-bottom: 12px;
    font-size: 12px;
  }
  .frames {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .frame {
    background: #1e1e1e;
    padding: 12px 10px;
    border-radius: 4px;
    overflow: hidden;
  }
  .frame-num {
    color: #6e6e6e;
    font-size: 11px;
    margin-bottom: 6px;
  }
  .frame-line {
    white-space: nowrap;
    font-size: 13px;
  }
  /* Theme slot mapping (matches pi-tui's Theme color names) */
  .t-tree     { color: #6e6e6e; }
  .t-title    { font-weight: bold; color: #d4d4d4; }
  .t-plain    { color: #d4d4d4; }
  .t-dim      { color: #4b5263; }            /* theme.fg("dim") */
  .t-accent   { color: #56b6c2; }            /* theme.fg("accent") */
  .t-muted    { color: #5c6370; }            /* theme.fg("muted") */
  .t-meta     { color: #4b5263; }
  .t-underline { text-decoration: underline; color: #56b6c2; }
</style>
</head>
<body>
  <h1>TUI pulse variants</h1>
  <p class="subtitle">10 partial-state visuals × 4 frames each. Theme slots map to <code>theme.fg(slot, ...)</code> in pi-tui.</p>

  <section class="settled">
    <h2>settled (control — what the row looks like when the run completes)</h2>
    <div class="frame-line">${renderHtml(settledParts())}</div>
  </section>

  ${cards}

  <footer class="subtitle" style="margin-top:32px">
    Settled above, then 10 variants in order: A through J. Each shows 4 consecutive frames at its cadence.
  </footer>
</body>
</html>`;
}

const html = buildHtml();
const outPath = join(here, "comparison.html");
writeFileSync(outPath, html, "utf8");
console.log(`\nWrote browser comparison: ${outPath}`);
console.log(`Open with: open ${outPath}`);
console.log(`(or just double-click comparison.html next to this script)`);
