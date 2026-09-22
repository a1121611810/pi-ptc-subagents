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
import type { PtcJsonObject, PtcJsonValue } from "../runtime/protocol.ts";
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
  result: PtcRenderResult,
  isError: boolean,
  theme: Theme,
  moreAfter = false,
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
): PtcRow {
  return new PtcRow(resultArea(result, isError, theme));
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
): PtcRow {
  if (isError) {
    const lines: RowLine[] = resultArea(result, true, theme);
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

  const details = result.details;
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

  if (details !== undefined && details.imageCount > 0) {
    const desc =
      details.imageCount === 1 ? "1 image attached" : `${details.imageCount} images attached`;
    children.push({ label: "image", lines: [desc] });
  }

  // Result rows first, then the labelled blocks. `moreAfter` keeps the connector chain open
  // while blocks follow, so the value tree and the blocks read as one list of siblings.
  const lines: RowLine[] = resultArea(result, false, theme, children.length > 0);

  for (let index = 0; index < children.length; index += 1) {
    const isLast = index === children.length - 1;
    lines.push(...renderChildBlock(children[index] ?? { label: "", lines: [] }, isLast, theme));
  }

  return new PtcRow(lines);
}
