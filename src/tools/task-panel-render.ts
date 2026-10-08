/**
 * TaskPanelRenderer: the TUI face of the three model-facing background-task tools
 * (`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`, ADR-0022, BG-09).
 *
 * `ptc-task.ts` owns the model-facing text and the structured `details`; this module turns those
 * details into a pi `Component` without introducing a second source of truth. It follows the
 * visual grammar of `render.ts`:
 *
 * ```
 *   └─ PTC task list  status=all                 (call row)
 *      ├─ ● research X  researcher · 2m14s · 12B  (result — one row per TaskRecord)
 *      └─ ◐ build Y  builder · 5s
 * ```
 *
 * Like `render.ts` the row shape is a private component (left text + optional right meta). The two
 * modules cannot share `PtcRow`: `render.ts` keeps it module-private and BG-09 is forbidden from
 * widening that module's exports, so the ~30-line layout class is mirrored here.
 *
 * ## Status colour (ADR-0022 §2)
 *
 * The 6-state machine maps one-to-one onto theme slots — `running` is the only "active" state
 * (`accent`), `stopping` is the transient one (`warning`), and the four terminals are
 * success / error / dim / muted. {@link STATUS_COLOR} is the single table; the unit tests pin
 * every row, so swapping two slots is a red test.
 *
 * ## Live age
 *
 * A `running`/`stopping` record has no frozen duration yet (ADR-0022 §3 writes `durationMs` at
 * transition time), so the row shows `now - createdAt`. While pi reports the row as partial the
 * component holds a 1s interval in `ToolRenderContext.state` — not on the component, which pi
 * recreates on every render, the same reason `shimmer.ts` keeps `startedAt` there — and calls
 * `context.invalidate` so the timer ticks. A settled render clears it.
 */

import type { Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskRecord, TaskStatus } from "../runtime/task-storage.ts";
import { sanitizeText } from "./text.ts";

/** The three management surfaces this module renders. */
export type TaskPanelSurface = "task-list" | "task-output" | "task-stop";

/** One rendered row: left content, plus an optional segment pinned to the right edge. */
interface RowLine {
  readonly left: string;
  readonly right?: string;
}

/**
 * Tree-connector layout, matching `render.ts` (which keeps its copies module-private):
 * the call row owns columns 0–2 (`└─ `); results hang at column 3 with `├─` / `└─` connectors.
 */
const TREE_ROOT = "└─ ";
const TREE_ROOT_CONT = "   ";
const TREE_INDENT = "   ";
const TREE_FIRST = "├─ ";
const TREE_LAST = "└─ ";

/**
 * ADR-0022 §2 status -> theme slot. `running` = accent (the only active state), `stopping` =
 * warning (in transition), `succeeded` = success, `failed` = error, `lost` = dim (the host
 * rebooted, nothing is running), `canceled` = muted (a deliberate, clean stop).
 */
const STATUS_COLOR: Record<TaskStatus, ThemeColor> = {
  running: "accent",
  stopping: "warning",
  succeeded: "success",
  failed: "error",
  lost: "dim",
  canceled: "muted",
};

/** One distinct glyph per state, so the row is readable with colour stripped. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  running: "●",
  stopping: "◐",
  succeeded: "✓",
  failed: "✗",
  lost: "◌",
  canceled: "⊘",
};

/** Elapsed-time refresh cadence for a live record: one tick per second, matching the display. */
const AGE_TICK_MS = 1000;

const MAX_LABEL_CHARS = 48;
const MAX_ERROR_CHARS = 120;
const MAX_OUTPUT_LINE_CHARS = 160;
const MAX_OUTPUT_PREVIEW_LINES = 6;

/**
 * Hard cap on the number of task rows `ptc_task_list` renders in one panel. This is the flat-list
 * analogue of `MAX_SUBCALLS` (render.ts), not the README's "6 children per container" rule — that
 * one caps object / array *value* containers. The registry still returns up to
 * `DEFAULT_TASK_LIST_LIMIT` records; the renderer withholds the tail behind a `…+N more` marker.
 */
export const MAX_TASK_PANEL_ROWS = 32;

/**
 * Per-tool-call state bag, held in `ToolRenderContext.state` so the interval outlives the row
 * pi recreates on every `updateDisplay()` (see `shimmer.ts` for the same pattern).
 */
interface TaskPanelTimerState {
  interval?: ReturnType<typeof setInterval>;
}

/** Everything the renderers need, resolved once at the entry point. */
interface RenderContext {
  readonly theme: Theme;
  readonly partial: boolean;
  readonly requestInvalidate: () => void;
  readonly state: TaskPanelTimerState;
  readonly now: number;
}

/** One row component that right-aligns an optional meta segment per line (render.ts: `PtcRow`). */
export class TaskPanelRow {
  private readonly items: readonly RowLine[];

  constructor(items: readonly RowLine[]) {
    this.items = items;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.items.map((line) => alignRow(line, safeWidth));
  }
}

/**
 * Lay out one row inside `width` columns. The right meta is what must survive truncation — a
 * count cut in half tells the reader nothing — so the left side gives up room first.
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

/** Truncate `value` to `max` chars, appending `…` when the input was longer. */
function truncateChars(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** First non-blank line of a block, sanitized and capped. */
function firstLine(value: string): string {
  const line = sanitizeText(value)
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return truncateChars((line ?? "").trim(), MAX_ERROR_CHARS);
}

/** A missing/non-object `details` payload reads as an empty bag, never a throw. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `running`/`stopping` are the only states whose duration is still growing. */
function isLiveStatus(status: TaskStatus): boolean {
  return status === "running" || status === "stopping";
}

/**
 * Compact elapsed time: `850ms` / `14s` / `2m14s` / `3h07m`. Used for both the live age and the
 * frozen terminal duration so a reader compares like with like.
 */
function formatElapsed(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The elapsed cell for one record: live age for `running`/`stopping`, the frozen `durationMs`
 * for terminals (falling back to `finishedAt - createdAt` when a record predates the duration
 * field). Returns `undefined` when nothing was measured — the row then omits the cell rather than
 * inventing `0ms`.
 */
function elapsedText(record: TaskRecord, now: number): string | undefined {
  if (isLiveStatus(record.status)) return formatElapsed(now - record.createdAt);
  if (record.durationMs !== undefined) return formatElapsed(record.durationMs);
  if (record.finishedAt !== undefined) return formatElapsed(record.finishedAt - record.createdAt);
  return undefined;
}

/**
 * Attach the age interval, mirroring `withShimmer`'s lifecycle: start it once while the row is
 * partial and has something live to tick, clear it on settle, and expose `dispose()` so a
 * torn-down row cannot leave a timer behind.
 */
function withAgeTimer(
  row: TaskPanelRow,
  options: { isLive: boolean; state: TaskPanelTimerState; requestInvalidate: () => void },
): TaskPanelRow {
  const { state } = options;
  if (options.isLive) {
    state.interval ??= setInterval(() => options.requestInvalidate(), AGE_TICK_MS);
  } else if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  const disposable = row as TaskPanelRow & { dispose: () => void };
  disposable.dispose = (): void => {
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  };
  return row;
}

function noop(): void {}

// ---------------------------------------------------------------------------
//  renderCall
// ---------------------------------------------------------------------------

function callRow(label: string, detail: string, theme: Theme): TaskPanelRow {
  const title = theme.fg("toolTitle", theme.bold(label));
  const suffix = detail.length > 0 ? ` ${detail}` : "";
  return new TaskPanelRow([{ left: `${TREE_ROOT}${title}${suffix}` }]);
}

/** The call row each surface shows while the management call is in flight. */
function renderTaskPanelCall(surface: TaskPanelSurface, args: unknown, theme: Theme): TaskPanelRow {
  const raw = asRecord(args);
  switch (surface) {
    case "task-list": {
      const status = Array.isArray(raw.status) ? (raw.status as TaskStatus[]) : undefined;
      const filter = status !== undefined && status.length > 0 ? status.join(",") : "all";
      const limit = typeof raw.limit === "number" ? ` · limit=${raw.limit}` : "";
      return callRow("PTC task list", theme.fg("dim", `status=${filter}${limit}`), theme);
    }
    case "task-output": {
      const taskId =
        typeof raw.taskId === "string" && raw.taskId.length > 0 ? raw.taskId : undefined;
      const since = typeof raw.sinceBytes === "number" ? ` · since=${raw.sinceBytes}B` : "";
      const detail =
        taskId === undefined
          ? theme.fg("muted", "(unknown task)")
          : `${theme.fg("accent", taskId)}${theme.fg("dim", since)}`;
      return callRow("PTC task output", detail, theme);
    }
    case "task-stop": {
      const taskId =
        typeof raw.taskId === "string" && raw.taskId.length > 0 ? raw.taskId : undefined;
      const reason =
        typeof raw.reason === "string" && raw.reason.length > 0
          ? ` · reason=${sanitizeText(raw.reason)}`
          : "";
      const detail =
        taskId === undefined
          ? theme.fg("muted", "(unknown task)")
          : `${theme.fg("accent", taskId)}${theme.fg("dim", reason)}`;
      return callRow("PTC task stop", detail, theme);
    }
  }
}

// ---------------------------------------------------------------------------
//  renderResult — one branch per surface
// ---------------------------------------------------------------------------

/** `task-list`: one line per TaskRecord, with the elapsed/frozen age and the byte count. */
function taskRecordRow(record: TaskRecord, isLast: boolean, theme: Theme, now: number): RowLine {
  const color = STATUS_COLOR[record.status] ?? "muted";
  const glyph = theme.fg(color, STATUS_GLYPH[record.status] ?? "?");
  const label = truncateChars(sanitizeText(record.label), MAX_LABEL_CHARS);
  const segments = [
    `${glyph} ${theme.fg("text", label)}`,
    theme.fg("dim", sanitizeText(record.agentName)),
  ];
  const elapsed = elapsedText(record, now);
  if (elapsed !== undefined) segments.push(theme.fg("dim", elapsed));
  if (record.outputBytes !== undefined) segments.push(theme.fg("dim", `${record.outputBytes}B`));
  const connector = isLast ? TREE_LAST : TREE_FIRST;
  return { left: `${TREE_INDENT}${connector}${segments.join(theme.fg("dim", " · "))}` };
}

function renderTaskList(details: unknown, ctx: RenderContext): TaskPanelRow {
  const raw = asRecord(details);
  const tasks = Array.isArray(raw.tasks) ? (raw.tasks as TaskRecord[]) : [];
  if (tasks.length === 0) {
    const empty = new TaskPanelRow([
      { left: `${TREE_ROOT_CONT}${ctx.theme.fg("muted", "(no background tasks)")}` },
    ]);
    return withAgeTimer(empty, {
      isLive: false,
      state: ctx.state,
      requestInvalidate: ctx.requestInvalidate,
    });
  }
  const hasLive = tasks.some((task) => isLiveStatus(task.status));
  const visible = tasks.slice(0, MAX_TASK_PANEL_ROWS);
  const tail = tasks.length - visible.length;
  const rows = visible.map((task, index) =>
    taskRecordRow(task, index === visible.length - 1 && tail === 0, ctx.theme, ctx.now),
  );
  if (tail > 0) {
    rows.push({
      left: `${TREE_INDENT}└─ ${ctx.theme.fg("dim", `…+${tail} more tasks`)}`,
    });
  }
  return withAgeTimer(new TaskPanelRow(rows), {
    isLive: ctx.partial && hasLive,
    state: ctx.state,
    requestInvalidate: ctx.requestInvalidate,
  });
}

/** Right-aligned facts for `task-output`: byte count (dim) and the truncation flag (warning). */
function outputMeta(
  outputBytes: number | undefined,
  truncated: boolean,
  theme: Theme,
): string | undefined {
  const segments: string[] = [];
  if (outputBytes !== undefined) segments.push(theme.fg("dim", `${outputBytes}B`));
  if (truncated) segments.push(theme.fg("warning", "truncated"));
  if (segments.length === 0) return undefined;
  return `${theme.fg("dim", "•")} ${segments.join(theme.fg("dim", " · "))}`;
}

function fullOutputLine(fullPath: string, theme: Theme): string {
  return `${TREE_ROOT_CONT}${theme.fg("dim", "full output: ")}${theme.fg("accent", fullPath)}`;
}

/**
 * `task-output`: the stored output preview while there is one, otherwise a pointer naming
 * `outputFullPath`. The `truncated` flag is stated in-band (next to the byte count) whenever
 * ADR-0015 cut the text, and the full-output pointer follows the preview.
 */
function renderTaskOutput(details: unknown, ctx: RenderContext): TaskPanelRow {
  const raw = asRecord(details);
  const output = typeof raw.output === "string" ? raw.output : "";
  const outputBytes = typeof raw.outputBytes === "number" ? raw.outputBytes : undefined;
  const truncated = raw.outputTruncated === true;
  const fullPath =
    typeof raw.outputFullPath === "string" && raw.outputFullPath.length > 0
      ? raw.outputFullPath
      : undefined;
  const meta = outputMeta(outputBytes, truncated, ctx.theme);
  const items: RowLine[] = [];
  if (output.length > 0) {
    const allLines = sanitizeText(output).split("\n");
    const shown = allLines.slice(0, MAX_OUTPUT_PREVIEW_LINES);
    shown.forEach((line, index) => {
      const content = ctx.theme.fg("toolOutput", truncateChars(line, MAX_OUTPUT_LINE_CHARS));
      items.push(
        index === 0 && meta !== undefined
          ? { left: `${TREE_ROOT_CONT}${content}`, right: meta }
          : { left: `${TREE_ROOT_CONT}${content}` },
      );
    });
    if (allLines.length > shown.length) {
      items.push({
        left: `${TREE_ROOT_CONT}${ctx.theme.fg("dim", `…+${allLines.length - shown.length} more lines`)}`,
      });
    }
    if (truncated && fullPath !== undefined) {
      items.push({ left: fullOutputLine(fullPath, ctx.theme) });
    }
  } else if (fullPath !== undefined) {
    items.push({
      left: fullOutputLine(fullPath, ctx.theme),
      ...(meta === undefined ? {} : { right: meta }),
    });
  } else {
    items.push({
      left: `${TREE_ROOT_CONT}${ctx.theme.fg("muted", "(no output yet)")}`,
      ...(meta === undefined ? {} : { right: meta }),
    });
  }
  return new TaskPanelRow(items);
}

/**
 * `task-stop`: the transition the stop tool drove. `PtcTaskStopDetails.fromStatus` is the tool's
 * atomic record of the source state (ADR-0022 §8), so the arrow is `fromStatus → status` — an
 * idempotent late stop renders `stopping → stopping`, not the `running → stopping` transition
 * that never happened (R-m3). Only a details payload without `fromStatus` falls back to deriving
 * the arrow from `task.status`.
 */
function renderTaskStop(details: unknown, ctx: RenderContext): TaskPanelRow {
  const raw = asRecord(details);
  const task = raw.task as TaskRecord | undefined;
  if (task === undefined || task === null || typeof task !== "object") {
    return new TaskPanelRow([{ left: `${TREE_ROOT_CONT}${ctx.theme.fg("muted", "(no task)")}` }]);
  }
  const color = STATUS_COLOR[task.status] ?? "muted";
  const glyph = ctx.theme.fg(color, STATUS_GLYPH[task.status] ?? "?");
  const fromStatus =
    typeof raw.fromStatus === "string" ? (raw.fromStatus as TaskStatus) : undefined;
  const transition =
    fromStatus !== undefined
      ? `${fromStatus} → ${task.status}`
      : task.status === "stopping"
        ? "running → stopping"
        : `→ ${String(task.status)}`;
  const segments = [
    `${glyph} ${ctx.theme.fg("text", sanitizeText(task.id))}`,
    ctx.theme.fg(color, transition),
  ];
  if (typeof task.stopReason === "string" && task.stopReason.length > 0) {
    segments.push(ctx.theme.fg("dim", `reason=${sanitizeText(task.stopReason)}`));
  }
  return new TaskPanelRow([{ left: `${TREE_ROOT_CONT}${segments.join(" ")}` }]);
}

/** A thrown tool reaches pi as `isError`; render ADR-0013's formatted failure row. */
function renderTaskPanelError(
  result: { content?: ReadonlyArray<{ type: string; text?: string }> },
  theme: Theme,
): TaskPanelRow {
  const block = result.content?.find(
    (candidate) => candidate.type === "text" && (candidate.text ?? "").length > 0,
  );
  const line = firstLine(block?.text ?? "") || "failed";
  return new TaskPanelRow([{ left: `${TREE_ROOT_CONT}${theme.fg("error", `failed: ${line}`)}` }]);
}

function renderTaskPanelResult(
  surface: TaskPanelSurface,
  result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
  ctx: RenderContext,
): TaskPanelRow {
  switch (surface) {
    case "task-list":
      return renderTaskList(result.details, ctx);
    case "task-output":
      return renderTaskOutput(result.details, ctx);
    case "task-stop":
      return renderTaskStop(result.details, ctx);
  }
}

/**
 * The `renderCall` / `renderResult` pair the three `ptc_task_*` tools register (ADR-0022 §3/§7),
 * mirroring `createPtcRenderers` in `render.ts`. The surface is the only parameter: each tool has
 * one details shape, and the factory picks the matching branch.
 *
 * `context.isPartial` (or the `options.isPartial` mirror) keeps a live row's age ticking;
 * `context.invalidate` is the re-render trigger the 1s interval calls; `context.state` is the bag
 * that lets the interval outlive the row recreation pi performs on every `updateDisplay()`.
 */
export function createTaskPanelRenderers(
  surface: TaskPanelSurface,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
  return {
    renderCall(args: unknown, theme: Theme): TaskPanelRow {
      return renderTaskPanelCall(surface, args, theme);
    },
    renderResult(
      result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
      options: { isPartial?: boolean } | undefined,
      theme: Theme,
      context:
        | {
            invalidate?: () => void;
            state?: unknown;
            isPartial?: boolean;
            isError?: boolean;
          }
        | undefined,
    ): TaskPanelRow {
      if (context?.isError === true) return renderTaskPanelError(result, theme);
      const ctx: RenderContext = {
        theme,
        partial: options?.isPartial === true || context?.isPartial === true,
        requestInvalidate: context?.invalidate ?? noop,
        state: (context?.state ?? {}) as TaskPanelTimerState,
        now: Date.now(),
      };
      return renderTaskPanelResult(surface, result, ctx);
    },
  };
}
