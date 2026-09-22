/**
 * Shared TUI renderer for `ptc_run_code` and `ptc_workflow`.
 *
 * Both tools produce the same `PtcToolDetails` shape (see `common.ts`), so one pair of helpers
 * drives both `renderCall` and `renderResult`.
 *
 * ## Shape: a tree, not a payload dump
 *
 * The row reads as a node in the transcript tree:
 *
 *   `└─ PTC  <description>`                         (call row)
 *   `   → {file, clipNow}            • 1 image · 536ms`  (result collapsed — summary + right meta)
 *   `   ├─ code    <line 1>`                       (result expanded — children with tree connectors)
 *   `   │          <line 2>`
 *   `   ├─ out     [bash stdout] …`
 *   `   ├─ value   { file: … }`
 *   `   └─ image   1 image attached`
 *
 * The summary line and the children share the call's column, so the connectors only need to
 * distinguish nesting (`├─/└─`) from continuation (`│/space`). Right-aligned meta lives on the
 * result row, not the call row, because `renderCall` does not see the run outcome — pi's TUI
 * calls renderCall and renderResult separately, and threading the result details into renderCall
 * would break that seam.
 *
 * ## What a PTC row must never do
 *
 * Print the completion value via `JSON.stringify`. Escaping turns a returned report into `\n` noise
 * wrapped over five rows — that is the ugly report this renderer exists to fix (ADR-0013). Values
 * render through `renderModelValue`, which keeps newlines real and indents containers.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PtcToolDetails } from "./common.ts";
import type { PtcJsonValue } from "../runtime/protocol.ts";
import { renderModelValue, sanitizeText } from "./text.ts";

/** Call-row label per surface; `ptc_workflow` gets its own so the two rows stay tellable apart. */
const TOOL_TITLE: Record<PtcToolDetails["surface"], string> = {
  run_code: "PTC",
  workflow: "PTC workflow",
};

/**
 * Tree-connector layout. The call row owns column 0–2 (`└─ `); everything below it sits at column 3.
 * Children are siblings of the call's content (the summary line `→ {hint}`), so a child row needs a
 * connector to distinguish itself from the summary — and a continuation prefix to distinguish its
 * own wrapped lines from the child's first line.
 *
 *  - Root call row:         `└─ PTC  …`
 *  - Root continuation:     `   → {hint}` or `   failed: …`    (summary; same column as children)
 *  - First / middle child:  `   ├─ code    …`
 *  - First / middle cont.:  `   │          …`
 *  - Last child:            `   └─ image   …`
 *  - Last cont.:            `      …`         (no connector — same shape as a wrapped value line)
 *
 * `TREE_INDENT` (3 spaces) is the column children and root continuations share.
 */
const TREE_ROOT = "└─ ";          // call-row prefix
const TREE_ROOT_CONT = "   ";      // continuation under the root (summary line + error text)
const TREE_INDENT = "   ";         // column children start at
const TREE_FIRST = "├─ ";          // connector of first / middle child
const TREE_LAST = "└─ ";           // connector of last child
const TREE_CONT_FIRST = "│  ";     // continuation of first / middle child
const TREE_CONT_LAST = "   ";      // continuation of last child (just spaces — no connector)

/**
 * Gutter width for child labels. `code` / `out` / `value` / `warn` / `image` are 3–5 chars; `phases`
 * is 6 — pad to 8 so the longest label gets two trailing spaces before its content.
 */
const LABEL_WIDTH = 8;

const MAX_CODE_LINES_EXPANDED = 3;
const MAX_CODE_LINE_CHARS = 120;
const MAX_LOG_LINES_EXPANDED = 12;
const MAX_PHASES_EXPANDED = 8;
const MAX_WARNINGS_EXPANDED = 4;
const MAX_VALUE_LINES_EXPANDED = 12;
const MAX_RESULT_HINT_CHARS = 60;
const MAX_ERROR_CHARS = 120;

/** One rendered row: left content, plus an optional segment pinned to the right edge. */
interface RowLine {
  readonly left: string;
  readonly right?: string;
}

/**
 * A `Component` that right-aligns one meta segment per line.
 *
 * Stateless: it holds already-styled strings and pads them at render time, so pi can re-render at a
 * new width (terminal resize) without any invalidation bookkeeping.
 */
class PtcRow {
  private readonly lines: readonly RowLine[];

  constructor(lines: readonly RowLine[]) {
    this.lines = lines;
  }

  /** Part of the `Component` contract; nothing is cached, so nothing has to be dropped. */
  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.lines.map((line) => alignRow(line, safeWidth));
  }
}

/**
 * Lay out one row inside `width` columns.
 *
 * With no meta segment the line is simply truncated. With one, the meta is what must survive — a
 * count that has been cut in half (`• 19 outpu…`) tells the reader nothing — so the left side gives
 * up room first, and only a meta wider than the whole viewport is truncated itself.
 */
function alignRow(line: RowLine, width: number): string {
  const { left, right } = line;
  if (right === undefined) return truncateToWidth(left, width, "…");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "…");
  const leftText = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
  const pad = Math.max(1, width - rightWidth - visibleWidth(leftText));
  return leftText + " ".repeat(pad) + right;
}

/** Truncate `s` to `n` chars, appending `…` when the input was longer. */
function truncateChars(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** First non-blank line of a block of text, sanitized and capped. */
function firstLine(value: string): string {
  const line = sanitizeText(value)
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return truncateChars((line ?? "").trim(), MAX_ERROR_CHARS);
}

/** `n` rendered as `1.2s` / `850ms` (so users can tell short from long at a glance). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;
}

/** `3 phases` / `1 phase` — singular and plural are both reachable from a real run. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Pull the first line of code that is actually doing something — not a leading comment, blank
 * line, or import. Used as the call row's fallback when the model sent no description.
 */
export function firstMeaningfulCodeLine(code: string): string | undefined {
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) continue;
    if (line.startsWith("*")) continue;
    // Strip trailing inline comment so the preview doesn't double as a docstring
    const withoutTrailingComment = line.replace(/\s*\/\/.*$/, "");
    return truncateChars(withoutTrailingComment, MAX_CODE_LINE_CHARS);
  }
  return undefined;
}

/**
 * The completion value as a single line a human can read: the value itself while it stays short
 * and single-line, otherwise its shape (`{version, node}`, `Array(3)`).
 *
 * A multi-line string contributes its first non-blank line plus a `+N lines` tail, which is the
 * whole difference between one readable row and the escaped wall this replaces.
 */
function resultHint(value: PtcJsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const lines = sanitizeText(value).split("\n");
    const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
    const extra = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
    if (first.length === 0 && extra.length === 0) return `""`;
    return truncateChars(first, MAX_RESULT_HINT_CHARS) + extra;
  }
  if (value === null || typeof value !== "object") return String(value);
  const inline = renderModelValue(value);
  if (!inline.includes("\n") && inline.length <= MAX_RESULT_HINT_CHARS) return inline;
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const head = keys.slice(0, 4).join(", ");
  return `{${head}${keys.length > 4 ? `, +${keys.length - 4}` : ""}}`;
}

/**
 * Right-aligned meta: the run's countable facts, in the order a reader asks for them — how much
 * output, how long it took, how many phases (workflow), and anything that went wrong.
 */
function metaText(details: PtcToolDetails | undefined, theme: Theme): string | undefined {
  if (details === undefined) return undefined;
  const segments: string[] = [];
  const outputLines = details.logs.length + details.narrations.length;
  if (outputLines > 0) segments.push(theme.fg("dim", plural(outputLines, "output line")));
  // Images rode the tool result (ADR-0014): the count says so even though pi renders them itself.
  if (details.imageCount > 0) {
    segments.push(theme.fg("toolOutput", plural(details.imageCount, "image")));
  }
  if (details.surface === "workflow" && details.phases.length > 0) {
    segments.push(theme.fg("dim", plural(details.phases.length, "phase")));
  }
  if (details.warnings.length > 0) {
    segments.push(theme.fg("warning", plural(details.warnings.length, "warning")));
  }
  // pi's truncation contract cut the text block: the tail is what the model read, the file is the rest.
  if (details.fullOutputPath !== undefined) segments.push(theme.fg("warning", "truncated"));
  segments.push(theme.fg("dim", formatDuration(details.durationMs)));
  return `${theme.fg("dim", "•")} ${segments.join(theme.fg("dim", " · "))}`;
}

/**
 * One child block in the expanded view: a `label` (right-padded into the gutter), N content lines,
 * and an optional `more` count for the `…+N more lines` tail.
 *
 * Block ordering is decided by the caller (see `renderPtcToolResultExpanded`); this module only
 * owns how a block lays itself out.
 */
interface ChildBlock {
  readonly label: string;
  readonly lines: readonly string[];
  readonly more?: number;
}

/** Render one child block as `RowLine[]`, with `├─` / `│` / `└─` connectors decided by position. */
function renderChildBlock(child: ChildBlock, isLast: boolean, theme: Theme): RowLine[] {
  const firstPrefix = TREE_INDENT + (isLast ? TREE_LAST : TREE_FIRST);
  const contPrefix = TREE_INDENT + (isLast ? TREE_CONT_LAST : TREE_CONT_FIRST);
  const gutter = " ".repeat(LABEL_WIDTH);
  const rows: RowLine[] = [];
  const first = child.lines[0] ?? "";
  rows.push({
    left: `${firstPrefix}${child.label.padEnd(LABEL_WIDTH)}${theme.fg("dim", first)}`,
  });
  for (let i = 1; i < child.lines.length; i++) {
    rows.push({
      left: `${contPrefix}${gutter}${theme.fg("dim", child.lines[i] ?? "")}`,
    });
  }
  if (child.more !== undefined && child.more > 0) {
    rows.push({
      left: `${contPrefix}${gutter}…+${child.more} more lines`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API: renderCall / renderResult
// ---------------------------------------------------------------------------

/** The tool-call arguments the renderer reads (a subset of both tools' parameter objects). */
export interface PtcRenderArgs {
  description?: string;
  code?: string;
  script?: string;
  meta?: { name?: string };
}

/**
 * One-line tool-call header: the tree root, then the tool label, then the model's own description.
 *
 * The description is the only detail that gets to sit next to the label — the previous renderer
 * appended the first code line as well, which is what made the call row read as a paragraph rather
 * than a heading. The code is one `ctrl+e` away in the expanded view.
 */
export function renderPtcToolCall(
    args: PtcRenderArgs,
    theme: Theme,
    surface: PtcToolDetails["surface"] = "run_code",
  ): PtcRow {
  const description =
    (typeof args.description === "string" && args.description.trim().length > 0
      ? args.description.trim()
      : args.meta?.name) ?? "";
  const fallback = firstMeaningfulCodeLine(args.code ?? args.script ?? "");
  const detail = description.length > 0 ? description : (fallback ?? "(no description)");

  const left = `${theme.fg("toolTitle", theme.bold(TOOL_TITLE[surface]))} ${theme.fg("accent", detail)}`;
  return new PtcRow([{ left: `${TREE_ROOT}${left}` }]);
}

/** The result shape both tools hand to `renderResult` (a structural subset of `AgentToolResult`). */
export interface PtcRenderResult {
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: PtcToolDetails;
}

/** Text body of a failed run — pi surfaces the thrown error in the first text block. */
function errorText(result: PtcRenderResult): string {
  const text = result.content?.find(
    (block) => block.type === "text" && (block.text ?? "").length > 0,
  );
  return firstLine(text?.text ?? "") || "failed";
}

/**
 * Left half of the result row: value hint, `done`, or the failure reason. Returned WITHOUT the root
 * continuation prefix — the caller prepends `TREE_ROOT_CONT` so the same string works for both
 * collapsed and expanded first lines.
 */
function summaryLeft(result: PtcRenderResult, isError: boolean, theme: Theme): string {
  if (isError) return `${theme.fg("error", `failed: ${errorText(result)}`)}`;
  const hint = resultHint(result.details?.result);
  if (hint !== undefined) return `${theme.fg("dim", `→ ${hint}`)}`;
  return `${theme.fg("muted", "done")}`;
}

/**
 * Collapsed result: one summary line under the call row.
 *
 * Three states, each with the same right-aligned meta so a column of PTC rows stays scannable:
 * the completion value (`→ …`), "no completion value" (`done`), or the failure reason
 * (`failed: …`, in the error colour). The summary itself hangs at the call's column (3 spaces)
 * so a reader scanning down a transcript sees the same indent under every call.
 */
export function renderPtcToolResultCollapsed(
    result: PtcRenderResult,
    isError: boolean,
    theme: Theme,
  ): PtcRow {
  const details = result.details;
  const right = metaText(details, theme);
  const row: RowLine =
    details === undefined
      ? {
          left: `${TREE_ROOT_CONT}${theme.fg(isError ? "error" : "muted", isError ? `failed: ${errorText(result)}` : "done")}`,
        }
      : { left: `${TREE_ROOT_CONT}${summaryLeft(result, isError, theme)}` };
  return new PtcRow([right === undefined ? row : { ...row, right }]);
}

/**
 * Expanded view: the summary line, then the run's children as tree blocks — code head, phase
 * roll-up, narration, console output, warnings, value, and an image-attached line. Each block is
 * capped and reports what it withheld, so expanded never means unbounded. The tool description
 * is deliberately absent: it lives on the call row directly above.
 *
 * The summary line is kept (same content as the collapsed view) so a reader who expands a row
 * still gets the value hint before scrolling through the value block.
 */
export function renderPtcToolResultExpanded(
    result: PtcRenderResult,
    args: PtcRenderArgs,
    isError: boolean,
    theme: Theme,
  ): PtcRow {
  const details = result.details;
  const right = metaText(details, theme);
  const summary = summaryLeft(result, isError, theme);
  const lines: RowLine[] = [
    right === undefined
      ? { left: `${TREE_ROOT_CONT}${summary}` }
      : { left: `${TREE_ROOT_CONT}${summary}`, right },
  ];

  if (isError) {
    // The failure text is the reason the reader expanded the row at all: give it the full width
    // under the summary, no tree connectors (it is the error message, not a structured block).
    const text = sanitizeText(
      result.content?.find((block) => block.type === "text")?.text ?? errorText(result),
    );
    for (const line of text.split("\n").slice(0, MAX_LOG_LINES_EXPANDED)) {
      lines.push({ left: `${TREE_ROOT_CONT}${theme.fg("error", line)}` });
    }
    return new PtcRow(lines);
  }

  const children: ChildBlock[] = [];

  const code = args.code ?? args.script ?? "";
  if (code.length > 0) {
    const codeLines = code.split("\n").map((line) => truncateChars(line, MAX_CODE_LINE_CHARS));
    const shown = codeLines.slice(0, MAX_CODE_LINES_EXPANDED);
    children.push({
      label: "code",
      lines: shown,
      ...(codeLines.length > shown.length ? { more: codeLines.length - shown.length } : {}),
    });
  }

  if (details !== undefined && details.surface === "workflow" && details.phases.length > 0) {
    const shown = details.phases.slice(0, MAX_PHASES_EXPANDED);
    const tail = details.phases.length > shown.length ? " …" : "";
    children.push({ label: "phases", lines: [`${shown.join(" → ")}${tail}`] });
  }

  if (details !== undefined && details.narrations.length > 0) {
    const shown = details.narrations.slice(0, MAX_LOG_LINES_EXPANDED);
    children.push({
      label: "log",
      lines: shown.map((message) => sanitizeText(message)),
      ...(details.narrations.length > shown.length
        ? { more: details.narrations.length - shown.length }
        : {}),
    });
  }

  if (details !== undefined && details.logs.length > 0) {
    const shown = details.logs.slice(0, MAX_LOG_LINES_EXPANDED);
    children.push({
      label: "out",
      lines: shown.map((line) => sanitizeText(line)),
      ...(details.logs.length > shown.length ? { more: details.logs.length - shown.length } : {}),
    });
  }

  if (details !== undefined && details.warnings.length > 0) {
    const shown = details.warnings.slice(0, MAX_WARNINGS_EXPANDED);
    children.push({
      label: "warn",
      lines: shown.map((warning) => sanitizeText(warning)),
      ...(details.warnings.length > shown.length
        ? { more: details.warnings.length - shown.length }
        : {}),
    });
  }

  if (details !== undefined && details.result !== undefined) {
    const valueLines = renderModelValue(details.result).split("\n");
    const shown = valueLines.slice(0, MAX_VALUE_LINES_EXPANDED);
    children.push({
      label: "value",
      lines: shown,
      ...(valueLines.length > shown.length ? { more: valueLines.length - shown.length } : {}),
    });
  }

  if (details !== undefined && details.imageCount > 0) {
    const desc =
      details.imageCount === 1 ? "1 image attached" : `${details.imageCount} images attached`;
    children.push({ label: "image", lines: [desc] });
  }

  for (let index = 0; index < children.length; index += 1) {
    const isLast = index === children.length - 1;
    lines.push(...renderChildBlock(children[index] ?? { label: "", lines: [] }, isLast, theme));
  }

  return new PtcRow(lines);
}
