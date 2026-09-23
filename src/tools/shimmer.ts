import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * The shimmer lifecycle, held in pi's per-tool-call state bag (`ToolRenderContext.state`).
 *
 * It lives there rather than on the wrapped component because pi **recreates the row on every
 * `updateDisplay()`** — and the shimmer interval itself calls `requestInvalidate`, which calls
 * `updateDisplay()`. Component-instance state would therefore reset every tick: `startedAt`
 * would restart (band frozen at position 0) and the previous instance's interval would leak.
 * `ToolRenderContext.state` is the one bag that outlives those rebuilds.
 */
export interface ShimmerState {
  /** `Date.now()` at the first partial render; `undefined` once settled (shimmer off). */
  startedAt?: number;
  /** The live `setInterval` handle; owned here so settle can clear exactly one interval. */
  interval?: ReturnType<typeof setInterval>;
}

/**
 * A call-row line, with any ANSI escape sequences removed, matches:
 *   `<prefix>(└─ |├─ |   )<label: PTC or PTC workflow><space><description>`
 *
 * The decorator matches on the stripped text so the production line's `theme.fg("toolTitle",
 * theme.bold("PTC"))` / `theme.fg("toolTitle", theme.bold("PTC workflow"))` wrappers do not
 * keep the anchor from matching. The label uses `(?:PTC(?: workflow)?)` so both surfaces match
 * with one capture group — and the description capture starts at the single space that always
 * follows the label.
 */
const PTC_LINE = /^(.*?)(└─ |├─ |   )(?:PTC(?: workflow)?)([ ].*)$/;

/**
 * Drop ANSI escape sequences so a line can be matched as plain text.
 *
 * - `\x1b\[[0-9;]*m` — SGR (colour, weight, etc.).
 * - `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` — OSC (`ESC ] … BEL` or `ESC ] … ESC \\`), which
 *   carries terminal titles, hyperlinks and the like.
 * - `\x1b\[\?[0-9;]*[a-zA-Z]` — private-mode CSI (DEC private modes, e.g. `\x1b[?25l`).
 */
function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional: ANSI escapes are exactly what this strips
  return s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?[0-9;]*[a-zA-Z]/g, "");
}

/** If `line[pos]` starts an ANSI escape sequence, return the index just past its closing byte. */
function skipAnsi(line: string, pos: number): number {
  if (line.charCodeAt(pos) !== 0x1b) return pos;
  const next = line.charCodeAt(pos + 1);
  // OSC: ESC ] … BEL or ESC \
  if (next === 0x5d) {
    let i = pos + 2;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 0x07) return i + 1;
      if (c === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
      i += 1;
    }
    return i;
  }
  // CSI family: ESC [ … final-byte (0x40–0x7e).
  if (next === 0x5b) {
    let i = pos + 2;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      i += 1;
    }
    return i;
  }
  // Other two-byte escapes (e.g. RIS): consume one byte after ESC.
  return pos + 2;
}

/**
 * Walk through `line` in lockstep with its ANSI-stripped twin until both pointers reach the
 * desired position in the stripped text. Returns the equivalent index in the original line.
 */
function walkToStrippedPos(line: string, targetStrippedPos: number): number {
  let origPos = 0;
  let strippedPos = 0;
  while (strippedPos < targetStrippedPos && origPos < line.length) {
    if (line.charCodeAt(origPos) === 0x1b) {
      origPos = skipAnsi(line, origPos);
    } else {
      origPos += 1;
      strippedPos += 1;
    }
  }
  return origPos;
}

/** Cadence of the band's sweep. 150ms matches DSH's `PROCESS_TITLE_MINIMUM_MS` (ADR-0020 §2). */
export const DEFAULT_SHIMMER_INTERVAL_MS = 150;

export interface ShimmerOptions {
  /** Per-call state bag (`ToolRenderContext.state`) that outlives row recreation. */
  state: ShimmerState;
  /** `false` once the run has settled: clears the interval and switches the band off. */
  isPartial: boolean;
  /** Re-render trigger the interval calls on every tick (typically `ToolRenderContext.invalidate`). */
  requestInvalidate: () => void;
  theme: Theme;
  intervalMs?: number;
}

/**
 * Wrap an inner component with the moving-highlight-band shimmer.
 *
 * The decorator monkey-patches `inner.render(width)` so the bright character's position advances
 * one character at a time. All lifecycle state stays in `options.state` — never on the component
 * (recreated per render) and never on the caller (two rows must be able to hold independent
 * bands). Both branches are idempotent: a partial render after a partial render reuses the same
 * `startedAt` and the same interval, so the tick that caused this render cannot spawn a second.
 *
 * `isPartial: false` is the settle path: it clears the interval and drops `startedAt`, so the
 * wrapped render passes lines through untouched (ADR-0020 §5 — the settled row is
 * indistinguishable from ADR-0013's).
 */
export function withShimmer<T extends Component>(inner: T, options: ShimmerOptions): T {
  const intervalMs = options.intervalMs ?? DEFAULT_SHIMMER_INTERVAL_MS;
  const { state } = options;

  if (options.isPartial) {
    state.startedAt ??= Date.now();
    state.interval ??= setInterval(() => options.requestInvalidate(), intervalMs);
  } else {
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    state.startedAt = undefined;
  }

  const originalRender = inner.render.bind(inner);
  const wrapped = inner as T & { dispose?: () => void };
  wrapped.render = (width: number): string[] => {
    const lines = originalRender(width);
    if (state.startedAt === undefined) return lines;
    const bandPos = Math.floor((Date.now() - state.startedAt) / intervalMs);
    return applyShimmer(lines, bandPos, options.theme);
  };

  // `dispose()` lets the orchestrator stop the interval when it replaces a still-partial row with
  // a settled one (a path the `isPartial: false` branch also covers) — and gives a framework that
  // tears a row down mid-run a hook that stops the tick from outliving the row.
  wrapped.dispose = (): void => {
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  };

  return inner;
}

function applyShimmer(lines: string[], pos: number, theme: Theme): string[] {
  return lines.map((line) => {
    const stripped = stripAnsi(line);
    const match = PTC_LINE.exec(stripped);
    if (match === null) return line;
    const description = (match[3] ?? "").slice(1); // drop the leading space captured by group 3
    if (description.length === 0) return line;
    const band = pos % (description.length + 1);

    // Locate the description segment in the ORIGINAL (ANSI-laden) line so the prefix's theme
    // codes are preserved verbatim. The description starts in stripped at:
    //   (match[0] length) - (description length)
    const strippedDescStart = match[0].length - description.length;
    const origDescStart = walkToStrippedPos(line, strippedDescStart);
    const origDescEnd = walkToStrippedPos(line, strippedDescStart + description.length);

    // `band === length` is the step where the highlight has swept past the end: every character
    // rests at the off-band colour. Rendering it all-`accent` (what a settled row looks like)
    // would make one frame in every sweep indistinguishable from a finished run, defeating the
    // "running rows are visually distinct" contract. All-`dim` is also what DSH's shimmer does
    // when the band leaves the text — the base is the off-band state.
    const newDescription =
      band >= description.length
        ? theme.fg("dim", description)
        : `${band > 0 ? theme.fg("dim", description.slice(0, band)) : ""}` +
          `${theme.fg("accent", description.slice(band, band + 1))}` +
          `${theme.fg("dim", description.slice(band + 1))}`;

    return `${line.slice(0, origDescStart)}${newDescription}${line.slice(origDescEnd)}`;
  });
}
