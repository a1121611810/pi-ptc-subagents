/**
 * TaskNotification renderer: turns drained `TaskEvent`s into the ADR-0022 §7 model-facing
 * XML — one `<bg-task-notifications>` parent per batch wrapping N `<bg-task-notification>`
 * children (GitHub issue #67 / BG-15).
 *
 * Layer: 2 (core), deliberately **pure**. This module has no IO, no timers, no global state,
 * and no pi imports; the host adapter (a different ticket) calls it and sends the string.
 * Everything here is synchronous and side-effect-free so the renderer is trivially testable
 * and the delivery layer stays swappable.
 *
 * ### Why a renderer takes `{ event, record }` instead of a `TaskEvent`
 *
 * `TaskEvent` (src/runtime/task-storage.ts) carries only the per-event projection:
 * `eventId / subscriptionId / taskId / type / status / transitionAtMs / outputBytes /
 * outputPreview`. It deliberately does **not** carry `label`, `agentName`, `depth`,
 * `durationMs`, or `outputRef` — those are TaskRecord fields (ADR-0022 §3), written at
 * spawn / terminal-transition time, not per event. ADR-0022 §7 requires all of them in each
 * child element, so a caller must join the drained event with its record. This module makes
 * that join explicit in the type ({@link TaskNotificationItem}) rather than re-reading the
 * record internally, which keeps the function pure and the data dependency visible.
 *
 * ### Byte budget: one constant, cited from the ADR
 *
 * ADR-0022 (`docs/adr/0022-background-dispatch.md §7`) names the byte budget
 * `DEFAULT_MAX_BATCH_BYTES = 100 * 1024` (100 KiB) and the split-along-event-boundaries
 * rule. That export from `notification-pipeline.ts` is the only declaration of the
 * number; {@link splitTaskNotificationBatches} consumes it and never re-declares it, so the
 * renderer's split is the single source of the batching rule.
 *
 * ### Amendment: `<error-message>` (ADR-0022 §7, 2026-10-19 field report)
 *
 * §7 shows only `<output-bytes>` / `<output-ref>` / `<output-preview>` under the child, which
 * assumes a failed child leaves something to read. A real background dispatch disproved that:
 * a child killed on a 429 wrote an **empty** `output.log` (0 bytes), and the model — seeing
 * only `<output-bytes>0</output-bytes>` beside a valid log reference — reported an
 * infrastructure fault. The diagnosis already existed on the `TaskRecord` (`errorMessage`;
 * ADR-0022 §8 gives `failed` / `lost` one, `succeeded` / `canceled` none) but the §7 message
 * dropped it, so the record was the only place the reason survived.
 *
 * The child element therefore carries one more optional child, `<error-message>`, rendered
 * between `<output-bytes>` and `<output-ref>` **only when the joined record has an
 * `errorMessage`** — it is not a field every status carries. Its text is XML-escaped and
 * head-truncated to {@link MAX_NOTIFICATION_ERROR_CHARS} so a single failure cannot crowd the
 * §7 batch budget; the splitter renders through this same function, so the two agree by
 * construction.
 *
 * ### Amendment 2: `<report-channel>` (ADR-0022 §7, 2026-10-19, ADR-0032)
 *
 * ADR-0032 makes the report channel a total fact about a completed background child: the pump
 * knows which channel the child's report came over — `tool` (the report tool's
 * `structuredContent`), `prompt-json` (the fenced block in its last message), `none` (the
 * contract was on and the child did not comply), or `opted-out` (the agent is not under the
 * contract at all). Before this amendment the completion push omitted it, so a parent that saw
 * `succeeded` had to poll `ptc_task_output` to learn whether the child had complied at all —
 * the distinction ADR-0032 exists to keep visible was reachable only on the second surface.
 *
 * The child element now carries `<report-channel>` between `<error-message>` (when present) and
 * `<output-ref>`, **only when the record has a channel**. The registry writes `reportChannel`
 * on the `succeeded` close alone, so a `running` / `failed` / `canceled` / `lost` record omits
 * the element entirely: absence means "no channel was declared", which is why it is not folded
 * into `status`. The value domain is fixed, but it goes through the same `escapeXml` as every
 * other text field — a renderer that special-cased it would be the one place a fixed domain
 * silently stopped being enforced.
 *
 * ### Delivery policy lives in one place
 *
 * {@link shouldDeliverTaskNotification} is the **only** place the completion-notification
 * suppression rule (T4.4 "谁停谁报告") lives. The renderer itself is policy-free: it renders
 * whatever batch it is handed, because the registry may legitimately surface a `running`
 * transition to the model UI while the host adapter decides which transitions become
 * completion wakes.
 */

import { DEFAULT_MAX_BATCH_BYTES } from "./notification-pipeline.ts";
import { OUTPUT_PREVIEW_MAX_BYTES } from "./task-registry.ts";
import type { TaskEvent, TaskRecord, TaskStatus } from "./task-storage.ts";

/**
 * One drained event joined to the TaskRecord it describes. The join is required: the event
 * lacks `label` / `agentName` / `depth` / `durationMs` / `outputRef` (see the module
 * note above), all of which the ADR-0022 §7 child element must carry.
 */
export interface TaskNotificationItem {
  event: TaskEvent;
  record: TaskRecord;
}

/**
 * Parent-batch identity for one render call. Kept to exactly the two ADR-0022 §7 parent
 * attributes — no size/token counters, no cursor bookkeeping (the registry owns the cursor).
 */
export interface TaskNotificationRenderOptions {
  /** Parent `batch-id`; ADR-0022 §7 shows a ULID. Rendered as an escaped string. */
  batchId: string;
  /** Parent `delivered-at-ms`; ms epoch. */
  deliveredAtMs: number;
}

/**
 * Statuses that produce a completion notification. ADR-0022 §2/§8 terminal outcomes a child
 * reached on its own or via host recovery:
 *
 * - `succeeded` — child exited 0.
 * - `failed` — child exited non-zero.
 * - `lost` — session ended / aborted / restart-reconcile; the model must learn the task died.
 *
 * Deliberately excluded:
 * - `canceled` — T4.4 "谁停谁报告": the model stopped the task, so the model already knows;
 *   a completion notification would be a redundant echo. This is the suppression rule.
 * - `running` / `stopping` — non-terminal; there is no completion to report.
 */
const DELIVERABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "lost",
]);

/**
 * The single home of the completion-notification suppression policy (T4.4). Returns `true`
 * only for the terminal completion statuses (see {@link DELIVERABLE_STATUSES}); `canceled`
 * and the non-terminal `running` / `stopping` return `false`.
 */
export function shouldDeliverTaskNotification(record: TaskRecord): boolean {
  return DELIVERABLE_STATUSES.has(record.status);
}

/**
 * Render one batch of joined events as the ADR-0022 §7 XML. Pure and deterministic.
 *
 * Empty input returns the empty string (a zero-event batch that the host adapter should not
 * send); a non-empty input always yields one parent wrapper around the children.
 */
export function renderTaskNotifications(
  items: readonly TaskNotificationItem[],
  opts: TaskNotificationRenderOptions,
): string {
  if (items.length === 0) return "";
  const children = items.map(renderTaskNotificationChild).join("\n");
  const open =
    `<bg-task-notifications batch-id="${escapeXml(opts.batchId)}" ` +
    `delivered-at-ms="${opts.deliveredAtMs}">`;
  return `${open}\n${children}\n</bg-task-notifications>`;
}

/**
 * Split a batch along event boundaries so each rendered batch stays within `maxBytes` of
 * UTF-8 payload (ADR-0022 §7). Pure and order-preserving: flattening the result yields the
 * input exactly, so no event (and no joined record) is dropped.
 *
 * The budget is {@link DEFAULT_MAX_BATCH_BYTES} (100 KiB) unless overridden. Per ADR-0022 §7
 * an item that alone exceeds the budget still becomes its own batch — split, never drop.
 *
 * Size model: each item's contribution is the UTF-8 byte length of the exact child element
 * {@link renderTaskNotifications} would emit, plus one byte for the joining newline. The
 * parent wrapper is subtracted up front using {@link CANONICAL_BATCH_WRAPPER_BYTES}, which
 * assumes the ADR's 26-char ULID `batch-id` and a 13-digit ms epoch. A caller that renders
 * with a longer `batch-id` loosens that bound slightly; the ULID is the spec shape.
 *
 * The budget defaults to {@link DEFAULT_MAX_BATCH_BYTES}
 * (`docs/adr/0022-background-dispatch.md §7`); this function never re-declares the number.
 */
export function splitTaskNotificationBatches(
  items: readonly TaskNotificationItem[],
  maxBytes: number = DEFAULT_MAX_BATCH_BYTES,
): TaskNotificationItem[][] {
  const batches: TaskNotificationItem[][] = [];
  let current: TaskNotificationItem[] = [];
  let currentBytes = 0;
  const childBudget = maxBytes - CANONICAL_BATCH_WRAPPER_BYTES;

  for (const item of items) {
    const itemBytes = estimateItemBytes(item);
    if (current.length > 0 && currentBytes + 1 + itemBytes > childBudget) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    if (current.length > 0) currentBytes += 1; // joining newline between children
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------
//  Internals
// ---------------------------------------------------------------------------

/**
 * Cap on the `<error-message>` text, in Unicode code points (not UTF-16 code units).
 *
 * Why a cap at all: a failed child may leave **zero** output, so `errorMessage` is the only
 * diagnosis the model receives — but it is child-produced text of unbounded length, and the
 * whole point of ADR-0022 §7's batching is a bounded model-facing payload
 * ({@link DEFAULT_MAX_BATCH_BYTES}, 100 KiB). One error message must not crowd that budget.
 * 1024 code points is generous for a failure line, and even in the worst case where every
 * character escapes to a six-byte entity (`&quot;`), it stays around 6 KiB — well under the
 * batch budget. The splitter's size model ({@link estimateItemBytes}) renders through this same
 * function, so the truncated text is what gets counted and there is no second size model to
 * drift. Truncation happens **before** escaping, so the cap counts source characters rather than
 * their entity forms.
 *
 * The unit matters: `String#length` and `String#slice` count UTF-16 code units, so a slice at
 * the cap can land between a high and a low surrogate. A lone surrogate is not a character; it
 * reaches the model as U+FFFD and makes the "character" claim false. The helper below counts
 * code points instead, so an astral character (an emoji, a rare CJK extension) is kept whole or
 * cut whole — never split.
 */
const MAX_NOTIFICATION_ERROR_CHARS = 1024;

/**
 * Keep the head of an overlong error message and mark the cut with an ellipsis: the reason a
 * failed child died is usually in its first line (an HTTP status, an exit label), while the
 * tail is the part that would get cut off anyway by the model's reader.
 */
function truncateNotificationError(errorMessage: string): string {
  const codePoints = Array.from(errorMessage);
  if (codePoints.length <= MAX_NOTIFICATION_ERROR_CHARS) return errorMessage;
  return codePoints.slice(0, MAX_NOTIFICATION_ERROR_CHARS - 1).join("") + "…";
}

/**
 * Render one `<bg-task-notification>` child block: the ADR-0022 §7 attribute set and children
 * plus the two 2026-10-19 amendments' children (see the module note). Attribute order is the
 * ADR's order; `<output-bytes>` is always present, then the optional `<error-message>`
 * (`failed` / `lost` in practice) and `<report-channel>` (`succeeded` alone) in the amendment
 * order, `<output-ref>` only once the record has a ref, and `<output-preview>` only when the
 * byte count proves the payload is at or below {@link OUTPUT_PREVIEW_MAX_BYTES}.
 */
function renderTaskNotificationChild(item: TaskNotificationItem): string {
  const { event, record } = item;
  const knownOutputBytes = event.outputBytes ?? record.outputBytes;
  const displayedOutputBytes = knownOutputBytes ?? 0;
  const outputPreview = event.outputPreview ?? record.outputPreview;
  const lines: string[] = [
    "  <bg-task-notification",
    `    id="${escapeXml(event.type)}"`,
    `    task-id="${escapeXml(event.taskId)}"`,
    `    subscription-id="${escapeXml(event.subscriptionId)}"`,
    `    status="${escapeXml(event.status)}"`,
    `    label="${escapeXml(record.label)}"`,
    `    agent-name="${escapeXml(record.agentName)}"`,
    `    depth="${record.depth}"`,
    `    duration-ms="${record.durationMs ?? 0}"`,
    `    transition-at-ms="${event.transitionAtMs}">`,
    `    <output-bytes>${displayedOutputBytes}</output-bytes>`,
  ];
  // The 2026-10-19 amendment (module note): the diagnosis is rendered only when the record has
  // one. succeeded / canceled never carry an errorMessage, and an unlabelled failure has none,
  // so this element's presence is itself the signal that a reason exists. Truncate before
  // escaping: the cap counts source characters, not their entity forms.
  if (record.errorMessage !== undefined) {
    lines.push(
      `    <error-message>${escapeXml(truncateNotificationError(record.errorMessage))}</error-message>`,
    );
  }
  // Amendment 2 (module note): ADR-0032's channel rides the completion push so a parent that
  // sees `succeeded` learns HOW the child reported without polling ptc_task_output. The registry
  // writes reportChannel only on the succeeded close, so running / failed / canceled / lost
  // records omit the element rather than claiming any channel.
  if (record.reportChannel !== undefined) {
    lines.push(`    <report-channel>${escapeXml(record.reportChannel)}</report-channel>`);
  }
  if (record.outputRef !== undefined) {
    lines.push(`    <output-ref>${escapeXml(record.outputRef)}</output-ref>`);
  }
  // ADR-0022 §7 gates the preview on a *known* byte count at or below the ceiling. An
  // unknown count (event and record both absent) cannot prove the payload is small, so the
  // raw output must be fetched through outputRef instead.
  if (
    knownOutputBytes !== undefined &&
    knownOutputBytes <= OUTPUT_PREVIEW_MAX_BYTES &&
    outputPreview !== undefined
  ) {
    lines.push(`    <output-preview>${escapeXml(outputPreview)}</output-preview>`);
  }
  lines.push("  </bg-task-notification>");
  return lines.join("\n");
}

/**
 * XML text/attribute escaping. `&` is replaced first so the entities introduced by the
 * later replacements are not double-escaped. Only the characters XML actually requires are
 * transformed — `&`, `<`, and `"` — plus whitespace controls (a literal newline in an
 * attribute would be normalised away by an XML parser). `>` is deliberately left raw: it
 * is legal in attribute / text content and the §2/§8 emit key `task:<id>:-><status>`
 * contains it; escaping it would corrupt the `id` attribute the ADR specifies.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

/** Estimated UTF-8 payload of one rendered child element (see the split size model). */
function estimateItemBytes(item: TaskNotificationItem): number {
  return Buffer.byteLength(renderTaskNotificationChild(item), "utf8");
}

/**
 * Conservative upper bound on the wrapper bytes shared by every batch: the opening
 * `<bg-task-notifications ...>` line (26-char ULID batch id, 13-digit ms epoch) plus the
 * newline before the closing tag. Individual child separators are counted per item.
 */
const CANONICAL_BATCH_WRAPPER_BYTES: number = Buffer.byteLength(
  `<bg-task-notifications batch-id="${"0".repeat(26)}" delivered-at-ms="${"9".repeat(13)}">\n\n</bg-task-notifications>`,
  "utf8",
);
