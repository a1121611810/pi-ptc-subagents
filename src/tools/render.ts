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
import type { Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_SUBCALLS, type PtcToolDetails } from "./common.ts";
import type {
  PtcJsonObject,
  PtcJsonValue,
  SubCallRecord,
  SubCallStatus,
} from "../runtime/protocol.ts";
import { renderModelValue, sanitizeText } from "./text.ts";
import { DEFAULT_SHIMMER_INTERVAL_MS, type ShimmerState, withShimmer } from "./shimmer.ts";

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
const TREE_ROOT = "└─ "; // call-row prefix
const TREE_ROOT_CONT = "   "; // continuation under the root (summary line + error text)
const TREE_INDENT = "   "; // column children start at
const TREE_FIRST = "├─ "; // connector of first / middle child
const TREE_LAST = "└─ "; // connector of last child
const TREE_CONT_FIRST = "│  "; // continuation of first / middle child
const TREE_CONT_LAST = "   "; // continuation of last child (just spaces — no connector)

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
const MAX_RESULT_HINT_CHARS = 60;
const MAX_ERROR_CHARS = 120;
const MAX_SUBCALL_PREVIEW_CHARS = 40;

/** One rendered row: left content, plus an optional segment pinned to the right edge. */
interface RowLine {
  readonly left: string;
  readonly right?: string;
}

/**
 * A `Component` that right-aligns one meta segment per line.
 *
 * Stateless: it holds already-styled strings and pads them at render time, so pi can re-render
 * at a new width (terminal resize) without any invalidation bookkeeping. The shimmer's
 * lifecycle state lives in pi's per-call state bag (`ToolRenderContext.state`), not here — pi
 * recreates this row on every `updateDisplay()`, so instance state would reset on every tick
 * (`src/tools/shimmer.ts`, `ShimmerState`). The decorator attaches the `dispose()` hook.
 */
class PtcRow {
  private readonly items: readonly RowLine[];

  constructor(items: readonly RowLine[]) {
    this.items = items;
  }

  /** Part of the `Component` contract; nothing is cached, so nothing has to be dropped. */
  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.items.map((line) => alignRow(line, safeWidth));
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
  // A duration of 0 means nobody measured one — pi's error result carries no details at all,
  // and `normalizeDetails` fills the field with 0. Printing "0ms" there would invent a fact.
  if (details.durationMs > 0) segments.push(theme.fg("dim", formatDuration(details.durationMs)));
  if (segments.length === 0) return undefined;
  return `${theme.fg("dim", "•")} ${segments.join(theme.fg("dim", " · "))}`;
}

/**
 * Fill in the fields a `partial` details may be missing.
 *
 * pi hands a **throwing** tool a bare `details: {}` (its error result shape), and a live
 * `onUpdate` push may carry only what was known at the time. Every reader here indexes the
 * arrays directly, so normalising once at the entry point is what keeps a failed run rendering
 * its failure line instead of throwing a second time inside the renderer.
 */
function normalizeDetails(
  details: Partial<PtcToolDetails> | undefined,
): PtcToolDetails | undefined {
  if (details === undefined) return undefined;
  return {
    surface: details.surface ?? "run_code",
    logs: details.logs ?? [],
    narrations: details.narrations ?? [],
    phases: details.phases ?? [],
    warnings: details.warnings ?? [],
    durationMs: details.durationMs ?? 0,
    imageCount: details.imageCount ?? 0,
    ...(details.result === undefined ? {} : { result: details.result }),
    ...(details.fullOutputPath === undefined ? {} : { fullOutputPath: details.fullOutputPath }),
    ...(details.subCalls === undefined ? {} : { subCalls: details.subCalls }),
  };
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
// Value-as-tree renderer (ADR-0013 §5)
//
// The value a program returns is a tree when it is a JSON object or array:
// each property (or index) gets its own row with a ├─ / └─ connector, recursive
// children inherit the parent's continuation bar, and a tail row collapses
// what was withheld. This module only knows PtcJsonValue; consumers wrap each
// emitted row with TREE_ROOT_CONT (so a row that starts with ├─ lands at the
// call row's column-3 indent).
// ---------------------------------------------------------------------------

/** Defaults: collapse at 4 levels, 6 children per container, 120 chars per row. */
export const TREE_VALUE_MAX_DEPTH = 4;
export const TREE_VALUE_MAX_CHILDREN = 6;
export const TREE_VALUE_MAX_LINE_CHARS = 120;

/** A JSON value is "expandable" when it is a non-empty object or array. */
export function isExpandableContainer(
  value: PtcJsonValue,
): value is PtcJsonObject | PtcJsonValue[] {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

/** Object keys that read as identifiers are left unquoted; the rest get JSON quoting. */
const TREE_BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function treeFormatKey(key: string): string {
  return TREE_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/** A scalar JSON value as a single readable token; strings are JSON-quoted, newlines folded. */
function treeScalarPreview(value: PtcJsonValue, maxChars: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    const sanitized = sanitizeText(value);
    if (sanitized.length === 0) return '""';
    if (sanitized.includes("\n")) {
      const flat = sanitized.replace(/\n/g, " ");
      const head = truncateChars(flat, Math.max(2, maxChars - 5));
      return JSON.stringify(head) + "…";
    }
    if (sanitized.length + 2 <= maxChars) return JSON.stringify(sanitized);
    return JSON.stringify(truncateChars(sanitized, Math.max(2, maxChars - 5))) + "…";
  }
  return "?";
}

function treeIsScalarJson(value: PtcJsonValue): boolean {
  return value === null || typeof value !== "object";
}

/** Try to render a container as a one-liner bracket form ({k: v} / [v, v]); undefined when it does not fit or children are deep. */
function treeInlinePreview(value: PtcJsonValue, maxChars: number): string | undefined {
  if (maxChars < 8) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length > 5 || !value.every(treeIsScalarJson)) return undefined;
    const items = value.map((item) =>
      treeScalarPreview(item, Math.max(2, Math.floor(maxChars / 4))),
    );
    const inline = "[" + items.join(", ") + "]";
    return inline.length <= maxChars ? inline : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  if (keys.length > 5 || !Object.values(value).every(treeIsScalarJson)) return undefined;
  const entries = keys.map((key) => {
    const child = (value as Record<string, PtcJsonValue>)[key] ?? null;
    return (
      treeFormatKey(key) + ": " + treeScalarPreview(child, Math.max(2, Math.floor(maxChars / 4)))
    );
  });
  const inline = "{" + entries.join(", ") + "}";
  return inline.length <= maxChars ? inline : undefined;
}

/**
 * Append one pre-prefixed tree row to out, recursing for containers. Each level passes the
 * continuation indent its children should use; the connector itself encodes "more siblings".
 */
function treeAppendNode(
  value: PtcJsonValue,
  label: string, // "key: ", "[0] ", or "" — the row's own text after the connector
  parentPrefix: string, // page above this row's connector (root's children pass "")
  isLast: boolean,
  maxDepth: number,
  maxChildren: number,
  maxLineChars: number,
  depth: number,
  out: string[],
): void {
  const connector = isLast ? "└─ " : "├─ ";
  const ownPrefix = parentPrefix + connector;
  const continuation = parentPrefix + (isLast ? "   " : "│  ");

  // Depth guard: collapse to ellipsis and stop recursing.
  if (depth >= maxDepth) {
    out.push(treeTruncateIndent(ownPrefix + label + "…", maxLineChars));
    return;
  }

  // Empty containers are leaves.
  if (Array.isArray(value) && value.length === 0) {
    out.push(treeTruncateIndent(ownPrefix + label + "[]", maxLineChars));
    return;
  }
  if (
    !Array.isArray(value) &&
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 0
  ) {
    out.push(treeTruncateIndent(ownPrefix + label + "{}", maxLineChars));
    return;
  }

  // Scalars.
  if (value === null || typeof value !== "object") {
    const budget = Math.max(0, maxLineChars - visibleWidth(ownPrefix) - label.length);
    out.push(
      treeTruncateIndent(ownPrefix + label + treeScalarPreview(value, budget), maxLineChars),
    );
    return;
  }

  // Small all-scalar containers collapse to one line.
  const inlineBudget = Math.max(0, maxLineChars - visibleWidth(ownPrefix) - label.length);
  const inline = treeInlinePreview(value, inlineBudget);
  if (inline !== undefined) {
    out.push(treeTruncateIndent(ownPrefix + label + inline, maxLineChars));
    return;
  }

  // Larger containers: header row, then recurse.
  const listLike = Array.isArray(value);
  const childCount = listLike ? value.length : Object.keys(value).length;
  let header: string;
  if (listLike) {
    header = "Array(" + childCount + ")";
  } else {
    header =
      childCount > maxChildren
        ? "{" + maxChildren + " of " + childCount + "}"
        : "{" + childCount + " keys}";
  }
  out.push(treeTruncateIndent(ownPrefix + label + header, maxLineChars));

  const limit = Math.min(maxChildren, childCount);
  if (listLike) {
    for (let index = 0; index < limit; index += 1) {
      const isChildLast = index === limit - 1 && childCount <= limit;
      treeAppendNode(
        (value as PtcJsonValue[])[index] ?? null,
        "[" + index + "] ",
        continuation,
        isChildLast,
        maxDepth,
        maxChildren,
        maxLineChars,
        depth + 1,
        out,
      );
    }
  } else {
    const keys = Object.keys(value);
    for (let index = 0; index < limit; index += 1) {
      const isChildLast = index === limit - 1 && childCount <= limit;
      const key = keys[index] as string;
      treeAppendNode(
        (value as Record<string, PtcJsonValue>)[key] ?? null,
        treeFormatKey(key) + ": ",
        continuation,
        isChildLast,
        maxDepth,
        maxChildren,
        maxLineChars,
        depth + 1,
        out,
      );
    }
  }
  if (childCount > limit) {
    const tail = listLike ? "items" : "keys";
    out.push(
      treeTruncateIndent(
        continuation + "└─ " + "…+" + (childCount - limit) + " more " + tail,
        maxLineChars,
      ),
    );
  }
}

/** Truncate a rendered row, preserving the leading tree-prefix indent (│/├/└ etc.). */
function treeTruncateIndent(line: string, maxLineChars: number): string {
  if (visibleWidth(line) <= maxLineChars) return line;
  const match = line.match(/^([\s│├└─]*)/);
  const indent = match && match[1] ? match[1] : "";
  const indentWidth = visibleWidth(indent);
  const budget = Math.max(0, maxLineChars - indentWidth - 1);
  let body = "";
  let used = 0;
  for (const ch of line.slice(indent.length)) {
    const w = visibleWidth(ch);
    if (used + w > budget) break;
    body += ch;
    used += w;
  }
  return indent + body + "…";
}

/**
 * Render a JSON value as an array of indented tree rows.
 *
 * Each row is a complete prefixed line ready to live under the call row's "   " indent
 * (TREE_ROOT_CONT): root children start at "├─ " / "└─ ", deeper levels add their own
 * connectors on top of the continuation bar. Caller supplies the row's TREE_ROOT_CONT — a
 * row that starts with "├─ " lands at column 3, exactly where other call-row children sit.
 *
 * Empty / scalar values return a one-row preview; non-empty containers recurse.
 */
export function renderValueTree(
  value: PtcJsonValue,
  options: {
    maxDepth?: number;
    maxChildren?: number;
    maxLineChars?: number;
    moreAfter?: boolean;
  } = {},
): string[] {
  const maxDepth = options.maxDepth ?? TREE_VALUE_MAX_DEPTH;
  const maxChildren = options.maxChildren ?? TREE_VALUE_MAX_CHILDREN;
  const maxLineChars = options.maxLineChars ?? TREE_VALUE_MAX_LINE_CHARS;
  // A tree followed by sibling blocks must keep the chain open: its last row stays ├─.
  const moreAfter = options.moreAfter === true;
  if (!isExpandableContainer(value)) {
    // An empty container is not "expandable" but still must show its own shape, not the
    // scalar fallback ("?").
    if (value !== null && typeof value === "object") {
      return [Array.isArray(value) ? "[]" : "{}"];
    }
    return [treeScalarPreview(value, maxLineChars)];
  }
  const out: string[] = [];
  if (Array.isArray(value)) {
    const total = value.length;
    const limit = Math.min(maxChildren, total);
    for (let index = 0; index < limit; index += 1) {
      const isLast = !moreAfter && index === limit - 1 && total <= limit;
      treeAppendNode(
        value[index] ?? null,
        "[" + index + "] ",
        "",
        isLast,
        maxDepth,
        maxChildren,
        maxLineChars,
        0,
        out,
      );
    }
    if (total > limit) {
      out.push((moreAfter ? "├─ " : "└─ ") + "…+" + (total - limit) + " more items");
    }
    return out;
  }
  const keys = Object.keys(value);
  const total = keys.length;
  const limit = Math.min(maxChildren, total);
  for (let index = 0; index < limit; index += 1) {
    const isLast = !moreAfter && index === limit - 1 && total <= limit;
    const key = keys[index] as string;
    const childValue = (value as Record<string, PtcJsonValue>)[key] ?? null;
    treeAppendNode(
      childValue,
      treeFormatKey(key) + ": ",
      "",
      isLast,
      maxDepth,
      maxChildren,
      maxLineChars,
      0,
      out,
    );
  }
  if (total > limit) {
    out.push((moreAfter ? "├─ " : "└─ ") + "…+" + (total - limit) + " more keys");
  }
  return out;
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
 *
 * The call row wraps with `withShimmer` while the run is in flight (ADR-0020 §3, §6): the
 * description's bright character advances at the 150ms cadence. The decorator owns the
 * lifecycle, held in `options.state` — see `ShimmerState` for why it cannot live on this
 * (per-render) component. When `options.isPartial` is false the decorator clears the interval
 * and the row renders plainly, which is the settle path.
 *
 * `options.requestInvalidate` is the re-render trigger the interval calls on every tick —
 * the caller owns the render tree and supplies the right invalidate path
 * (e.g. `ToolRenderContext.invalidate` for a top-level tool row). The decorator never reaches
 * for `ui` itself; that's the caller's seam.
 *
 * The result-area renderers do not shimmer — the call row owns the partial-state visual.
 */
export function renderPtcToolCall(
  args: PtcRenderArgs,
  theme: Theme,
  surface: PtcToolDetails["surface"] = "run_code",
  options: PtcRenderOptions = {},
): PtcRow {
  const description =
    (typeof args.description === "string" && args.description.trim().length > 0
      ? args.description.trim()
      : args.meta?.name) ?? "";
  const fallback = firstMeaningfulCodeLine(args.code ?? args.script ?? "");
  const detail = description.length > 0 ? description : (fallback ?? "(no description)");

  const left = `${theme.fg("toolTitle", theme.bold(TOOL_TITLE[surface]))} ${theme.fg("accent", detail)}`;
  const row = new PtcRow([{ left: `${TREE_ROOT}${left}` }]);
  return withShimmer(row, {
    intervalMs: DEFAULT_SHIMMER_INTERVAL_MS,
    isPartial: options.isPartial ?? false,
    theme,
    requestInvalidate: options.requestInvalidate ?? noop,
    state: options.state ?? {},
  });
}

/** The result shape both tools hand to `renderResult` (a structural subset of `AgentToolResult`). */
export interface PtcRenderResult {
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  /**
   * Every field is optional at this seam even though `PtcToolDetails` declares them required:
   * pi's error result for a thrown tool is `details: {}`, and a live push may carry only what
   * was known when it was sent. `normalizeDetails` fills the gaps at each entry point, so a
   * failed run keeps ADR-0013's formatted failure row instead of falling through to pi's
   * raw-text fallback.
   */
  readonly details?: Partial<PtcToolDetails>;
}

/** A render result whose `details` have been through `normalizeDetails` — the invariant
 *  `resultArea` and `metaText` rely on to index the arrays directly. */
type NormalizedRenderResult = Omit<PtcRenderResult, "details"> & { details?: PtcToolDetails };

/**
 * Options for `renderPtcToolCall` (the only consumer of this interface — the result-area
 * renderers took a `PtcRenderOptions` for parity but read nothing from it, so the parameter
 * was dropped; F15).
 *
 * `requestInvalidate` is the re-render trigger the call-row shimmer interval calls on every
 * tick (150ms cadence). pi's tool renderers receive `ToolRenderContext.invalidate` for this —
 * that is the value the framework expects — so the tool definitions in `run-code.ts` /
 * `workflow.ts` pass `context.invalidate` through. When omitted (e.g. a unit test that never
 * reads the row again), the interval still ticks but nobody repaints, so the band never
 * advances. The decorator never reaches for `ui` itself; that's the caller's seam.
 *
 * `isPartial` is pi's `ToolRenderContext.isPartial`: the shimmer runs while it is true and
 * settles when it goes false, which is how a finished run stops its own band.
 *
 * `state` is pi's `ToolRenderContext.state` — the per-tool-call bag that survives the row
 * recreation pi performs on every `updateDisplay()`. The shimmer's `startedAt` and interval
 * handle live there; see `ShimmerState`. Callers inside pi pass `context.state`; direct
 * library callers and tests may omit it and accept a throwaway bag.
 */
export interface PtcRenderOptions {
  requestInvalidate?: () => void;
  isPartial?: boolean;
  state?: ShimmerState;
}

/** No-op invalidate for tests and direct library callers that never read the rendered output. */
function noop(): void {}

/** Text body of a failed run — pi surfaces the thrown error in the first text block. */
function errorText(result: PtcRenderResult): string {
  const text = result.content?.find(
    (block) => block.type === "text" && (block.text ?? "").length > 0,
  );
  return firstLine(text?.text ?? "") || "failed";
}

/**
 * Pick one short, readable argument string for a binding call, so each sub-row tells the reader
 * what it was operating on without dumping a JSON payload (ADR-0021 §3, ADR-0013 §1's selector).
 *
 * The `pi.dispatch` selector returns `→ <agent>` (the binding's own `DispatchInput.agent`), so
 * dispatch rows read as `pi.dispatch → <agent>`; the rest pluck a known args key. Falls back to
 * `JSON.stringify(args)`
 * capped at `MAX_SUBCALL_PREVIEW_CHARS` with embedded newlines folded to spaces — this is the one
 * place `JSON.stringify` is acceptable on a sub-row because the input is one args object whose
 * keys are already known.
 */
function previewArgs(name: string, args: unknown): string {
  if (name === "pi.dispatch" && typeof args === "object" && args !== null && "agent" in args) {
    return `→ ${String((args as { agent: unknown }).agent)}`;
  }
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    const pick = (key: string): string | undefined =>
      typeof a[key] === "string" ? (a[key] as string) : undefined;
    const candidate =
      name === "read"
        ? pick("path")
        : name === "bash"
          ? pick("command")
          : name === "grep" || name === "find"
            ? pick("pattern")
            : name === "ls"
              ? pick("path")
              : name === "edit" || name === "write"
                ? pick("path")
                : undefined;
    if (typeof candidate === "string") return candidate;
  }
  try {
    const s = JSON.stringify(args).replace(/\n/g, " ");
    return s.length > MAX_SUBCALL_PREVIEW_CHARS
      ? `${s.slice(0, MAX_SUBCALL_PREVIEW_CHARS - 1)}…`
      : s;
  } catch {
    return String(args).slice(0, MAX_SUBCALL_PREVIEW_CHARS);
  }
}

/**
 * Per-`SubCallStatus` rendering rules: which status text to show and which theme slot to use
 * (ADR-0021 §6). One row of the table replaces the two parallel cascading ternaries that
 * previously fanned out over `statusText` and `statusColor` independently — adding a new state
 * (or changing a colour slot) used to mean two edits in lockstep; the table makes it one.
 *
 * The table is module-private: production code reads it via `subRowsFor`, tests verify it
 * end-to-end through `subRowsFor` (each status emits the expected text and colour slot).
 */
interface SubCallStatusEntry {
  readonly text: (r: SubCallRecord) => string;
  readonly themeSlot: ThemeColor;
}

const SUB_CALL_STATUS_TABLE: Record<SubCallStatus, SubCallStatusEntry> = {
  running: { text: () => "running", themeSlot: "muted" },
  ok: {
    text: (r) => (r.durationMs !== undefined ? `ok ${formatDuration(r.durationMs)}` : "ok"),
    themeSlot: "accent",
  },
  error: {
    text: (r) => `failed: ${r.errorMessage ?? "error"}`,
    themeSlot: "error",
  },
  cancelled: { text: () => "cancelled", themeSlot: "muted" },
  rejected: {
    text: (r) => `rejected: ${r.errorMessage ?? "concurrency"}`,
    themeSlot: "warning",
  },
};

/**
 * Render `subCalls` as a flat list of sub-row lines, capped at `MAX_SUBCALLS` with a `+N more
 * calls` tail. Each row carries the tool name, an args preview, status text in the matching
 * colour slot, and the duration when the call settled. The list is a sibling of the result
 * area, visible in both collapsed and expanded states (ADR-0021 §4, §5).
 *
 * Per US16, sub-rows do **not** shimmer — the parent's call-row shimmer is the partial-state
 * signal, and sub-rows stay readable by carrying a static status colour while the parent row
 * pulses. The five-state status colouring (running=muted / ok=accent / error=error /
 * cancelled=muted / rejected=warning) is the per-row liveness signal.
 *
 * Returns `RowLine[]`; the orchestrator appends them to the parent `PtcRow`'s items.
 */
function subRowsFor(subCalls: readonly SubCallRecord[], theme: Theme): RowLine[] {
  if (subCalls.length === 0) return [];
  const visible = subCalls.slice(0, MAX_SUBCALLS);
  const tail = subCalls.length > MAX_SUBCALLS ? subCalls.length - MAX_SUBCALLS : 0;
  const rows: RowLine[] = [];
  visible.forEach((record, idx) => {
    const isLast = idx === visible.length - 1 && tail === 0;
    const connector = isLast ? "└─ " : "├─ ";
    // `padEnd` alone leaves a name longer than the gutter unpadded, which glues it to the
    // status text (`pi.dispatchrejected: …`). The extra space keeps a separator at any length.
    const label =
      record.name.length >= LABEL_WIDTH ? `${record.name} ` : record.name.padEnd(LABEL_WIDTH);
    const preview = previewArgs(record.name, record.args);
    const entry = SUB_CALL_STATUS_TABLE[record.status];
    rows.push({
      left: `${TREE_INDENT}${connector}${theme.fg("toolTitle", label)}${theme.fg(entry.themeSlot, entry.text(record))}${theme.fg("dim", " " + preview)}`,
    });
  });
  if (tail > 0) {
    rows.push({ left: `${TREE_INDENT}└─ …+${tail} more calls` });
  }
  return rows;
}

/**
 * The result area under the call row.
 *
 * One of four shapes, all hanging at column 3 so a column of PTC rows stays scannable:
 * - error:                    one line with the failure reason in the error colour.
 * - no completion value:      one line, "done".
 * - scalar / empty container: one line, `→ <hint>` (or "done" for null).
 * - non-empty container:      a tree of rows (recursive `├─/└─/│` connectors from
 *                             `renderValueTree`), with the right-aligned meta pinned to
 *                             the tree's first row. ADR-0013 §5.
 *
 * Each row returns its left-side text WITHOUT the `TREE_ROOT_CONT` prefix being in scope;
 * we prepend it here so the same output works for both surfaces.
 */
function resultArea(
  result: NormalizedRenderResult,
  isError: boolean,
  theme: Theme,
  moreAfter = false,
  isPartial = false,
): RowLine[] {
  const right = metaText(result.details, theme);
  const attachRight = (row: RowLine): RowLine => (right === undefined ? row : { ...row, right });

  if (isError) {
    return [
      attachRight({
        left: `${TREE_ROOT_CONT}${theme.fg("error", `failed: ${errorText(result)}`)}`,
      }),
    ];
  }

  // While the run is in flight there is no completion value yet, so there is nothing to
  // summarise: the sub-call tree below is the whole result area. Rendering the settled
  // placeholder here would claim "done" about a program that is still working.
  if (isPartial && result.details?.result === undefined) return [];

  const value = result.details?.result;
  if (value === undefined) {
    return [
      attachRight({
        left: `${TREE_ROOT_CONT}${theme.fg("muted", "done")}`,
      }),
    ];
  }

  if (isExpandableContainer(value)) {
    const tree = renderValueTree(value, {
      maxDepth: TREE_VALUE_MAX_DEPTH,
      maxChildren: TREE_VALUE_MAX_CHILDREN,
      maxLineChars: TREE_VALUE_MAX_LINE_CHARS,
      moreAfter,
    });
    return tree.map((line, index) => {
      const row: RowLine = { left: `${TREE_ROOT_CONT}${line}` };
      return index === 0 && right !== undefined ? { ...row, right } : row;
    });
  }

  // Scalar / empty / null — one-line `→ <hint>` (or "done" when no hint is producible).
  const hint = resultHint(value);
  if (hint === undefined) {
    return [
      attachRight({
        left: `${TREE_ROOT_CONT}${theme.fg("muted", "done")}`,
      }),
    ];
  }
  return [
    attachRight({
      left: `${TREE_ROOT_CONT}${theme.fg("dim", `→ ${hint}`)}`,
    }),
  ];
}

/**
 * Collapsed result: the result area only.
 *
 * A scalar row fits on one line; a container value expands into a tree (1+ lines). Right-aligned
 * meta (output lines / phases / warnings / duration) is pinned to the first row of the area.
 */
export function renderPtcToolResultCollapsed(
  result: PtcRenderResult,
  isError: boolean,
  theme: Theme,
  options: { isPartial?: boolean } = {},
): PtcRow {
  const details = normalizeDetails(result.details);
  const items: RowLine[] = [
    ...resultArea({ ...result, details }, isError, theme, false, options.isPartial === true),
  ];
  if (details?.subCalls !== undefined) {
    items.push(...subRowsFor(details.subCalls, theme));
  }
  return new PtcRow(items);
}

/**
 * Expanded view: the result area, then the run's children as labelled blocks.
 *
 * Each child block opens with a fixed-width gutter (`code`, `phases`, `log`, `out`, `warn`,
 * `image`); the `value` block is gone — for a scalar value the result area already shows the
 * hint, and for a container value the area shows the full tree (ADR-0013 §5). Children that
 * overflow cap themselves and report `+N more lines`; the view stays bounded.
 */
export function renderPtcToolResultExpanded(
  result: PtcRenderResult,
  args: PtcRenderArgs,
  isError: boolean,
  theme: Theme,
  options: { isPartial?: boolean } = {},
): PtcRow {
  const details = normalizeDetails(result.details);
  if (isError) {
    const items: RowLine[] = [...resultArea({ ...result, details }, true, theme)];
    if (details?.subCalls !== undefined) {
      items.push(...subRowsFor(details.subCalls, theme));
    }
    // The failure text is the reason the reader expanded the row at all: give it the full width
    // under the summary, no tree connectors (it is the error message, not a structured block).
    const text = sanitizeText(
      result.content?.find((block) => block.type === "text")?.text ?? errorText(result),
    );
    for (const line of text.split("\n").slice(0, MAX_LOG_LINES_EXPANDED)) {
      items.push({ left: `${TREE_ROOT_CONT}${theme.fg("error", line)}` });
    }
    return new PtcRow(items);
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
    // Report the count, not just that something was withheld. The `more` field that code /
    // log / out / warn use renders a separate `…+N more lines` row, which is the wrong shape
    // here: the phases block is one roll-up line, so the tail stays inline. A bare " …"
    // satisfied the letter of ADR-0013 §3 ("reports what it withheld") while telling the
    // reader nothing about how much — the other four blocks all report the count.
    const withheld = details.phases.length - shown.length;
    const tail = withheld > 0 ? ` …+${withheld} more phases` : "";
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

  if (details !== undefined && details.imageCount > 0) {
    const desc =
      details.imageCount === 1 ? "1 image attached" : `${details.imageCount} images attached`;
    children.push({ label: "image", lines: [desc] });
  }

  // Result rows first, then the sub-call tree, then the labelled blocks (ADR-0021 §4: sub-call
  // rows are a sibling of the result area, visible in both collapsed and expanded states).
  // `moreAfter` keeps the value tree's connector chain open whenever something follows — sub-call
  // rows or labelled blocks.
  const subCalls = details?.subCalls;
  const hasFollowers = (subCalls !== undefined && subCalls.length > 0) || children.length > 0;
  const items: RowLine[] = resultArea(
    { ...result, details },
    false,
    theme,
    hasFollowers,
    options.isPartial === true,
  );
  if (subCalls !== undefined) {
    items.push(...subRowsFor(subCalls, theme));
  }

  for (let index = 0; index < children.length; index += 1) {
    const isLast = index === children.length - 1;
    items.push(...renderChildBlock(children[index] ?? { label: "", lines: [] }, isLast, theme));
  }

  return new PtcRow(items);
}

/**
 * The `renderCall` / `renderResult` pair every PTC tool registers.
 *
 * The two tools differ only by the surface label, so the wiring lives here once rather than
 * being copy-pasted per tool — a duplication that had already drifted once during review.
 *
 * `context` is pi's `ToolRenderContext`, read structurally: the fields the renderers use are
 * `invalidate` (the interval's re-render trigger), `isPartial` (false once the run settles),
 * `state` (the shimmer's per-call bag), and `args` / `isError` for the result side.
 */
export function createPtcRenderers(
  surface: PtcToolDetails["surface"],
): Pick<ToolDefinition<any, PtcToolDetails>, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme, context) {
      // `args` arrives as pi's widened `Static<TParams>`; `PtcRenderArgs` is the structural
      // subset this renderer reads, and the tool's real params satisfy it.
      return renderPtcToolCall(args as PtcRenderArgs, theme, surface, {
        ...(context?.invalidate === undefined ? {} : { requestInvalidate: context.invalidate }),
        ...(context?.isPartial === undefined ? {} : { isPartial: context.isPartial }),
        ...(context?.state === undefined ? {} : { state: context.state }),
      });
    },
    renderResult(result, options, theme, context) {
      // `isPartial` is pi's flag for a live `onUpdate` push: the result area then has no
      // completion value to summarise, so it renders the sub-call tree alone (ADR-0021 §4).
      const isPartial = options.isPartial === true;
      if (options.expanded === true) {
        return renderPtcToolResultExpanded(
          result,
          context?.args ?? {},
          context?.isError === true,
          theme,
          {
            isPartial,
          },
        );
      }
      return renderPtcToolResultCollapsed(result, context?.isError === true, theme, { isPartial });
    },
  };
}
