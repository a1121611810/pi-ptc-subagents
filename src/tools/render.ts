/**
 * Shared TUI renderer for `ptc_run_code` and `ptc_workflow`, plus the model-facing child-report
 * block at the bottom (`renderChildReportText`, ADR-0032 §Rendering).
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
import { DISPATCH_BINDING_NAME } from "../runtime/bindings.ts";
import type {
  PtcJsonObject,
  PtcJsonValue,
  SubCallRecord,
  SubCallStatus,
} from "../runtime/protocol.ts";
// Type-only, so the worker's module graph gains no edge to the dispatcher: a `ChildReport`, a
// `ChildReportChannel` and the host's `DispatchUsage` accumulator are read off a `DispatchResult`
// (or off a `TaskRecord`) by the tool, never constructed here.
import type {
  ChildReport,
  ChildReportChannel,
  ChildReportFinding,
  DispatchUsage,
} from "../runtime/dispatch.ts";
import { CHILD_REPORT_MAX_FINDINGS } from "../runtime/child-report.ts";
import { formatSessionModel, type SessionModel } from "../runtime/session-model.ts";
import { TREE_LAST } from "./read-only-tier-text.ts";
import { MAX_LINE_CHARS, renderModelValue, sanitizeText } from "./text.ts";
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
// Child report rendering (ADR-0032 §Rendering)
//
// The model-facing surface. On `surface mode: subagents` there is no `codemode`, so nothing reads
// `structuredContent` and the report has to be RENDERED into the text the model actually reads
// (ADR-0025 + ADR-0028). So this block is drawn with the same vocabulary as the value tree above:
// `├─` / `└─` / `│` connectors, `Array(n)` heads, labels in the same `LABEL_WIDTH` gutter, every
// cap stated in-band rather than applied silently.
//
// Two rules the shape exists to keep:
//
//  - A missing report is VISIBLY MARKED. An unmarked gap between "the tool returned" and "the
//    child said" reads as an empty result — a child that found nothing — which is a different
//    claim from a child that ignored the contract.
//  - A child-declared value is never authoritative. `usage` is stamped by the host at settle, so
//    this renderer only ever prints what it was handed (`ChildReport` vs `ChildReportPayload`).
//
// The order is fixed — summary, findings, files touched, usage — and the child's prose is
// appended AFTER this block, so the model reads the conclusion first and the reasoning second.
//
// Issue #199: the `usage` row reads the HOST'S OWN carrier — `TaskRecord.usage` /
// `DispatchResult.usage`, the six-field accumulator — when the caller has one, and falls back to
// the report's four-field view only when it does not. That is what lets a started child with NO
// report (a `none` or `opted-out` child) still account for what it cost: the block is rendered
// around the absence, and the counter is a fact about the child rather than a section of the
// report. A caller that hands in no usage at all gets exactly the block it got before.
// ---------------------------------------------------------------------------

/** Section label of the rendered block; the header the model is told to look for. */
export const CHILD_REPORT_HEADER = "child report";

/** ADR-0032 §Rendering commits to 20; the withheld count is stated on the last findings row. */
export { CHILD_REPORT_MAX_FINDINGS };

/** `files_touched` is bounded for the reason every other list here is: an unbounded one is noise. */
export const CHILD_REPORT_MAX_FILES = 20;

/**
 * Evidence supports a claim; past this the row stops being a row. Stated per finding, because a
 * reader who has been cut off mid-sentence cannot otherwise tell a cut from the child's ending.
 *
 * Sized so the WHOLE row including that notice survives `MAX_LINE_CHARS`: 3 columns of connector,
 * 5 of finding-index padding, `evidence: `, then the notice. Raise this and the notice itself gets
 * truncated, which would state the cut and hide it in the same row.
 */
export const CHILD_REPORT_MAX_EVIDENCE_CHARS = 150;

/**
 * One section: a label in the gutter, its head on the label row, and any rows hanging off it at
 * the section's own column (`rows` already carry their own connectors).
 */
interface ReportSection {
  readonly label: string;
  readonly head: string;
  readonly rows: readonly string[];
}

/** An empty container is `[]` and a non-empty one is `Array(n)`, as the value tree renders both. */
function countHead(count: number): string {
  return count === 0 ? "[]" : `Array(${count})`;
}

/**
 * The summary is one line by contract. A child that sent several is cut to its first non-blank
 * line, and `truncateChars` marks the cut with `…` — the model has to be able to tell a trimmed
 * summary from a complete one.
 */
function summaryText(summary: string): string {
  const line =
    sanitizeText(summary)
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "";
  if (line.length === 0) return '""';
  return truncateChars(line, MAX_LINE_CHARS);
}

/**
 * The child's cost as a number a reader can act on: four decimals, trailing zeros dropped so the
 * row is not mostly padding. `Number` rather than `toFixed` because `"0.1200"` reads as a
 * measurement the host did not make.
 */
function reportUsageText(usage: ChildReport["usage"]): string {
  const cost = Number(usage.cost.toFixed(4));
  return `in ${usage.input} · out ${usage.output} · cost ${cost} · ${plural(usage.turns, "turn")}`;
}

/** One finding's evidence row, folded to a single line and capped with the cap stated in-band. */
function evidenceRow(continuation: string, pad: string, evidence: string): string {
  const flat = sanitizeText(evidence).replace(/\n/g, " ").trim();
  if (flat.length <= CHILD_REPORT_MAX_EVIDENCE_CHARS)
    return `${continuation}${pad}evidence: ${flat}`;
  return (
    `${continuation}${pad}evidence: ${flat.slice(0, CHILD_REPORT_MAX_EVIDENCE_CHARS)}… ` +
    `(truncated at ${CHILD_REPORT_MAX_EVIDENCE_CHARS} chars)`
  );
}

/**
 * One row per finding, each with its evidence on a continuation row at the finding's own column,
 * then the withheld tail when the report carried more than {@link CHILD_REPORT_MAX_FINDINGS}.
 * The tail names the COUNT (`…+3 more findings withheld`), which is the difference between
 * "reporting what it withheld" and a bare ellipsis.
 */
function findingRows(findings: readonly ChildReportFinding[], withheld: number): string[] {
  const rows: string[] = [];
  findings.forEach((finding, index) => {
    const isLast = index === findings.length - 1 && withheld === 0;
    const tag = `[${index}]`;
    rows.push(`${isLast ? "└─ " : "├─ "}${tag}  ${sanitizeText(finding.what).trim()}`.trimEnd());
    rows.push(evidenceRow(isLast ? "   " : "│  ", " ".repeat(tag.length + 2), finding.evidence));
  });
  if (withheld > 0) {
    rows.push(
      `└─ …+${withheld} more findings withheld ` +
        `(a report renders at most ${CHILD_REPORT_MAX_FINDINGS})`,
    );
  }
  return rows;
}

/** `files_touched`, same bounded-list shape as the findings block. */
function fileRows(files: readonly string[], withheld: number): string[] {
  const rows = files.map(
    (file, index) =>
      `${index === files.length - 1 && withheld === 0 ? "└─ " : "├─ "}[${index}]  ` +
      `${sanitizeText(file).trim()}`.trimEnd(),
  );
  if (withheld > 0) {
    rows.push(
      `└─ …+${withheld} more files withheld (a report renders at most ${CHILD_REPORT_MAX_FILES})`,
    );
  }
  return rows;
}

/**
 * One section as a row: the connector, the label in the {@link LABEL_WIDTH} gutter, the head. It
 * is shared with {@link noReportBlock} so a `usage` row reads the same in a block that has a
 * report and in one that does not.
 */
function sectionRow(section: ReportSection, isLast: boolean): string {
  // `padEnd` alone glues an exactly-LABEL_WIDTH label to its content (`findingsArray(2)`); the
  // extra space is the separator `subRowsFor` already learned the same way.
  const gutter =
    section.label.length >= LABEL_WIDTH ? `${section.label} ` : section.label.padEnd(LABEL_WIDTH);
  return treeTruncateIndent(
    `${isLast ? TREE_LAST : TREE_FIRST}${gutter}${section.head}`,
    MAX_LINE_CHARS,
  );
}

/**
 * The block a caller gets instead of a report: the header, the channel, and ONE row saying the
 * report did not arrive. It is deliberately NOT an empty report — no summary, no `Array(0)`
 * findings — because an empty report reads as "the child found nothing" rather than "the child
 * told us nothing", and those are different facts.
 *
 * `usage` is NOT part of that contrast (issue #199). The four absent sections all describe the
 * report, which did not arrive; the counter is a measurement of the CHILD, which did run, so a
 * child the host measured states it here too — in the same row format the full block ends with,
 * and in the same position (last). A child the host never measured renders exactly the block this
 * function has always returned, byte for byte.
 */
function noReportBlock(channel: ChildReportChannel, usage: DispatchUsage | undefined): string {
  // Three channels, three DIFFERENT claims, and conflating any two of them is the failure this
  // function exists to avoid. A two-branch version read "opted-out" as "announced but never
  // arrived", which is worse than silence: it tells the model a contract was broken when the
  // agent's frontmatter deliberately switched the contract off and nobody was ever asked.
  const row =
    channel === "none"
      ? "no child report was returned — the child did not comply with the contract, so its " +
        "prose below is unbacked by a report"
      : channel === "opted-out"
        ? "this agent opts out of the report contract, so none was asked for — the prose below " +
          "is the whole of what it produced, and nothing is missing"
        : `the ${channel} channel was announced but no report reached the host; ` +
          "the child's prose below is everything it produced";
  const header = `${CHILD_REPORT_HEADER} (channel: ${channel})`;
  if (usage === undefined) return `${header}\n${TREE_LAST}${row}`;
  return `${header}\n${TREE_FIRST}${row}\n${sectionRow(
    { label: "usage", head: reportUsageText(usage), rows: [] },
    true,
  )}`;
}

/**
 * Render a child report as the fixed-shape text block the model reads (ADR-0032 §Rendering).
 *
 * Returns a self-contained string with no trailing newline, so a caller can place it above the
 * child's prose with a blank line between. `report` and `channel` are the two fields the tool
 * reads off `DispatchResult`; passing a `report` with `channel: "none"` is a caller error and
 * renders as a report anyway — the value is the more specific statement, and the channel in the
 * header still says where it came from.
 *
 * `usage` is the HOST'S canonical carrier (issue #199) — `DispatchResult.usage` in the foreground,
 * `TaskRecord.usage` behind a background record — and it is what the `usage` row reads when it is
 * there. Two consequences, both intended:
 *
 *  - the row survives the report's absence, because the counter is a fact about the child rather
 *    than a section of the report (see {@link noReportBlock});
 *  - when both carriers are present the row states the canonical numbers. They are required to
 *    agree on the four shared fields, so this is a sourcing rule rather than a value change — but
 *    it is the canonical one that is authoritative, and the fallback to `report.usage` exists only
 *    so a caller holding an older record's report still renders one.
 */
export function renderChildReportText(
  report: ChildReport | undefined,
  channel: ChildReportChannel,
  usage?: DispatchUsage,
): string {
  if (report === undefined) return noReportBlock(channel, usage);
  const shownFindings = report.findings.slice(0, CHILD_REPORT_MAX_FINDINGS);
  const withheldFindings = report.findings.length - shownFindings.length;
  const shownFiles = report.files_touched.slice(0, CHILD_REPORT_MAX_FILES);
  const withheldFiles = report.files_touched.length - shownFiles.length;
  const sections: ReportSection[] = [
    { label: "summary", head: summaryText(report.summary), rows: [] },
    {
      label: "findings",
      head: countHead(report.findings.length),
      rows: findingRows(shownFindings, withheldFindings),
    },
    {
      label: "files",
      head: countHead(report.files_touched.length),
      rows: fileRows(shownFiles, withheldFiles),
    },
    { label: "usage", head: reportUsageText(usage ?? report.usage), rows: [] },
  ];

  const rows: string[] = [`${CHILD_REPORT_HEADER} (channel: ${channel})`];
  sections.forEach((section, index) => {
    const isLast = index === sections.length - 1;
    rows.push(sectionRow(section, isLast));
    // Rows below a section hang at the section's own column, carrying the connector chain's
    // continuation bar — the same `TREE_CONT_FIRST` / `TREE_CONT_LAST` the value tree passes down.
    const continuation = isLast ? TREE_CONT_LAST : TREE_CONT_FIRST;
    for (const row of section.rows) {
      rows.push(treeTruncateIndent(`${continuation}${row}`, MAX_LINE_CHARS));
    }
  });
  return rows.join("\n");
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

/** Structural subset of `DISPATCH_PARAMETERS` the `pi_task_codemode` call row reads. */
export interface SubagentCallArgs {
  agent?: string;
  task?: string;
  why?: string;
  label?: string;
  model?: string;
  agentScope?: "user" | "project" | "both";
  readOnly?: "strict" | "lenient";
  wait?: boolean;
}

/**
 * Render options for the `pi_task_codemode` call row.
 *
 * `sessionModel` is ADR-0044's caller-session snapshot, read by the host at session/turn start.
 * The row is a REQUEST view, so it uses the snapshot only to say what an omitted request will
 * inherit; the model the child actually ran is an observation and belongs to the result.
 */
export interface SubagentRenderOptions extends PtcRenderOptions {
  expanded?: boolean;
  sessionModel?: SessionModel;
}

/**
 * The `pi_task_codemode` call row: a heading, then the task preview (collapsed) or the task block
 * (expanded with ctrl+e). ADR-0054: the heading says what the call creates — a task.
 *
 * This row is a REQUEST view. It states the pinned `model` / `agentScope` the caller passed, and
 * `model=inherit` when the call names no model and no agent (the generalist child, where ADR-0044's
 * definition tier cannot apply) while the host could read the caller's session model; the expanded
 * view names that inherited provider/id. A named agent definition may pin a model that outranks the
 * session tier, and the row cannot read that definition cheaply, so a named agent gets no inherit
 * claim. The model the child ACTUALLY ran is a result fact and appears in the tool-result text,
 * never here: the row is rendered before the run has a result.
 *
 * Collapsed: `└─ task → (generalist)` with the state flags right-aligned, one task line and
 * `… 还有 N 行（ctrl+e 展开）`. Expanded: `label` / `why` children and the task block. The task
 * row carries the first line; the continuation shows at most {@link MAX_LOG_LINES_EXPANDED} more,
 * the same expanded-block line budget the out/log blocks use, so a long task cannot make an
 * expanded row unbounded and no new cap has to be registered.
 *
 * `label` and `why` are flattened to their first non-empty line through {@link firstLine} — a
 * row is one line by construction, and a multi-line value pasted into one `RowLine` would put raw
 * newlines into the grid that `alignRow` does not split on.
 */
export function renderSubagentToolCall(
  args: SubagentCallArgs,
  theme: Theme,
  options: SubagentRenderOptions = {},
): PtcRow {
  const task = typeof args.task === "string" ? sanitizeText(args.task) : "";
  const taskLines = task
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const who =
    typeof args.agent === "string" && args.agent.trim().length > 0
      ? args.agent.trim()
      : "(generalist)";
  const flags = [args.wait === true ? "waited" : "not waited"];
  if (args.readOnly !== undefined) flags.push("read-only:" + args.readOnly);
  const requestedModel =
    typeof args.model === "string" && args.model.trim().length > 0 ? args.model.trim() : undefined;
  const agentNamed = typeof args.agent === "string" && args.agent.trim().length > 0;
  if (requestedModel !== undefined) {
    flags.push("model=" + requestedModel);
  } else if (options.sessionModel !== undefined && !agentNamed) {
    // ADR-0044: no call-site model and no definition (the generalist child), so resolution
    // inherits the caller session's. A NAMED definition may pin a model (tier 2 outranks the
    // session tier) and the row cannot read that file cheaply, so a named agent gets no claim.
    flags.push("model=inherit");
  }
  if (args.agentScope !== undefined) flags.push("scope=" + args.agentScope);
  const title = `${TREE_ROOT}${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("accent", "→ " + who)}`;
  const items: RowLine[] = [{ left: title, right: theme.fg("dim", flags.join(" · ")) }];
  if (options.expanded !== true) {
    const first = taskLines[0];
    if (first !== undefined) {
      items.push({ left: `${TREE_ROOT_CONT}${theme.fg("dim", "│ " + first)}` });
      const withheld = taskLines.length - 1;
      if (withheld > 0) {
        items.push({
          left: `${TREE_ROOT_CONT}${theme.fg("dim", "  … 还有 " + withheld + " 行（ctrl+e 展开）")}`,
        });
      }
    }
  } else {
    const column = (label: string): string => theme.fg("dim", label.padEnd(LABEL_WIDTH));
    const meta: Array<[string, string]> = [];
    if (requestedModel === undefined && !agentNamed && options.sessionModel !== undefined) {
      // `inherit →` keeps the two model facts apart: a pinned value is a `model=` flag, an
      // inherited one is a request fact whose value is only as current as the host's snapshot.
      meta.push(["model", "inherit → " + sanitizeText(formatSessionModel(options.sessionModel))]);
    }
    if (typeof args.label === "string") {
      const label = firstLine(sanitizeText(args.label));
      if (label.length > 0) meta.push(["label", label]);
    }
    if (typeof args.why === "string") {
      const why = firstLine(sanitizeText(args.why));
      if (why.length > 0) meta.push(["why", why]);
    }
    for (const [label, value] of meta) {
      items.push({ left: `${TREE_INDENT}${TREE_FIRST}${column(label)}${value}` });
    }
    const first = taskLines[0] ?? "(empty)";
    items.push({
      left: `${TREE_INDENT}${TREE_LAST}${column("task")}${first}${taskLines.length > 1 ? " (" + String(taskLines.length) + " 行)" : ""}`,
    });
    const shown = taskLines.slice(1, 1 + MAX_LOG_LINES_EXPANDED);
    const continuation = TREE_INDENT + TREE_CONT_LAST;
    for (const line of shown) items.push({ left: `${continuation}${theme.fg("dim", line)}` });
    const withheld = taskLines.length - 1 - shown.length;
    if (withheld > 0) {
      items.push({
        left: `${continuation}${theme.fg("dim", "… +" + String(withheld) + " 行（ctrl+e 收起）")}`,
      });
    }
  }
  return withShimmer(new PtcRow(items), {
    intervalMs: DEFAULT_SHIMMER_INTERVAL_MS,
    isPartial: options.isPartial ?? false,
    theme,
    requestInvalidate: options.requestInvalidate ?? noop,
    state: options.state ?? {},
  });
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
 * The `pi_task_ptc` selector returns `→ <agent>` (the binding's own `DispatchInput.agent`), so
 * task rows read as `pi_task_ptc → <agent>`; the rest pluck a known args key. Falls back to
 * `JSON.stringify(args)`
 * capped at `MAX_SUBCALL_PREVIEW_CHARS` with embedded newlines folded to spaces — this is the one
 * place `JSON.stringify` is acceptable on a sub-row because the input is one args object whose
 * keys are already known.
 */
function previewArgs(name: string, args: unknown): string {
  if (name === DISPATCH_BINDING_NAME && typeof args === "object" && args !== null) {
    const agent = (args as { agent?: unknown }).agent;
    // A usable name is what the row is for: it says which agent the call reached. Anything else
    // is one of two different situations and they must not read the same.
    if (typeof agent === "string" && agent.trim().length > 0) return `→ ${agent}`;
    // Absent: the generalist child (#185). This is the common case now, so falling through to the
    // JSON preview — which is capped at 40 characters and dumps the task text — would make the
    // default path the illegible one.
    if (agent === undefined) return "→ (generalist)";
    // Present but unusable: a value the dispatch will refuse. Rendered with `JSON.stringify`
    // rather than `String`, so an object-shaped value shows its contents instead of
    // `[object Object]` — and showing it is the point, since the refusal does not put the value
    // on this row.
    return `→ ${JSON.stringify(agent)}`;
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
 * The `renderCall` / `renderResult` pair the two program tools register.
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
