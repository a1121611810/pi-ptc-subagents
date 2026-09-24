/**
 * SPECIFICATION tests for `src/runtime/task-notification.ts` — the pure ADR-0022 §7
 * background-task notification renderer (BG-15 / GitHub issue #67).
 *
 * Oracle discipline (docs/testing-constraints.md #4 + #6): every expected XML string below is
 * a LITERAL derived from the ADR-0022 §7 code block, never captured from the implementation.
 * The counterfactual block at the bottom builds the "obviously wrong but satisfies a naive
 * assertion" variants named in the ticket and shows the real assertions reject them (#5).
 * This module has no IO / clock / network, so constraint #1's dual-path rule maps onto the
 * pure boundary cases (empty input, oversized item, preview ceiling) rather than IO failures.
 */

import { describe, expect, test } from "vitest";

import { DEFAULT_MAX_BATCH_BYTES } from "../../src/runtime/notification-pipeline.ts";
import { OUTPUT_PREVIEW_MAX_BYTES } from "../../src/runtime/task-registry.ts";
import {
  renderTaskNotifications,
  shouldDeliverTaskNotification,
  splitTaskNotificationBatches,
  type TaskNotificationItem,
} from "../../src/runtime/task-notification.ts";
import type { TaskEvent, TaskRecord, TaskStatus, ULID } from "../../src/runtime/task-storage.ts";

// --- Fixtures -------------------------------------------------------------------------------

const TASK_ID: ULID = "01JBZ00000000000000000000A" as ULID;
const SUBSCRIBER_ID: ULID = "01JBZ00000000000000000010S" as ULID;
const EVENT_ID: ULID = "01JBZ00000000000000000001E" as ULID;
/** ADR-0022 §7 batch-id is a ULID; the renderer treats it as an opaque escaped string. */
const BATCH_ID = "01JBZ00000000000000000000B";
const DELIVERED_AT_MS = 1_700_000_002_000;
const OPTS = { batchId: BATCH_ID, deliveredAtMs: DELIVERED_AT_MS };

/** All 21 TaskRecord fields from ADR-0022 §3; overrides vary only what a test reads. */
function fixtureRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TASK_ID,
    label: "research X",
    agentName: "researcher",
    depth: 0,
    status: "running",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    finishedAt: undefined,
    durationMs: undefined,
    transitionAt: 1_700_000_001_000,
    outputRef: undefined,
    outputBytes: undefined,
    outputPreview: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    exitCode: undefined,
    spawnSource: { kind: "ptc-program", callerId: "run-001" },
    parentTaskId: undefined,
    sessionFile: undefined,
    ...overrides,
  };
}

/** TaskEvent per ADR-0022 §5/§7; the join partner of a TaskRecord. */
function fixtureEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    eventId: EVENT_ID,
    subscriptionId: SUBSCRIBER_ID,
    taskId: TASK_ID,
    type: `task:${TASK_ID}:running`,
    status: "running",
    transitionAtMs: 1_700_000_001_000,
    outputBytes: undefined,
    outputPreview: undefined,
    ...overrides,
  };
}

function makeItem(
  recordOverrides: Partial<TaskRecord> = {},
  eventOverrides: Partial<TaskEvent> = {},
): TaskNotificationItem {
  return { event: fixtureEvent(eventOverrides), record: fixtureRecord(recordOverrides) };
}

/** Distinct item for batch tests; ids are opaque to the renderer. */
function itemAt(index: number, label = "x"): TaskNotificationItem {
  const suffix = String(index + 1).padStart(2, "0");
  const taskId = `task-fixture-${suffix}` as ULID;
  return {
    event: fixtureEvent({ eventId: `event-fixture-${suffix}` as ULID, taskId }),
    record: fixtureRecord({ id: taskId, label }),
  };
}

// --- Golden literals (provenance: ADR-0022 §7 "G2 verdict, locked") --------------------------

/**
 * Provenance: ADR-0022 §7 code block, placeholders filled from the fixtures above. The parent
 * carries exactly the two §7 attributes; the child carries the full §7 attribute set
 * (id / task-id / subscription-id / status / label / agent-name / depth / duration-ms /
 * transition-at-ms) plus <output-bytes> always. No <output-ref> / <output-preview> when the
 * task is still running with no captured output.
 */
const EXPECTED_RUNNING = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
  <bg-task-notification
    id="task:01JBZ00000000000000000000A:running"
    task-id="01JBZ00000000000000000000A"
    subscription-id="01JBZ00000000000000000010S"
    status="running"
    label="research X"
    agent-name="researcher"
    depth="0"
    duration-ms="0"
    transition-at-ms="1700000001000">
    <output-bytes>0</output-bytes>
  </bg-task-notification>
</bg-task-notifications>`;

/**
 * Provenance: same ADR-0022 §7 layout, terminal status. The two optional §7 children appear:
 * <output-ref> because record.outputRef exists, and <output-preview> because outputBytes (11)
 * is at or below OUTPUT_PREVIEW_MAX_BYTES. duration-ms comes from the joined TaskRecord
 * (the event does not carry it — that is why the join exists).
 */
const EXPECTED_SUCCEEDED = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
  <bg-task-notification
    id="task:01JBZ00000000000000000000A:->succeeded"
    task-id="01JBZ00000000000000000000A"
    subscription-id="01JBZ00000000000000000010S"
    status="succeeded"
    label="research X"
    agent-name="researcher"
    depth="0"
    duration-ms="5432"
    transition-at-ms="1700000005000">
    <output-bytes>11</output-bytes>
    <output-ref>tasks/01JBZ00000000000000000000A/output.log</output-ref>
    <output-preview>partial out</output-preview>
  </bg-task-notification>
</bg-task-notifications>`;

/** Raw text is arbitrary: these five characters must survive an XML round-trip. */
const ESCAPED_LABEL_RAW = 'a<b>c & d"e\nf';
const ESCAPED_PREVIEW_RAW = 'x<y & z"w\nv';

/**
 * Provenance: ADR-0022 §7 layout with adversarial text values. '&' -> &amp;, '<' -> &lt;,
 * '"' -> &quot;, newline -> &#10; so the attribute/element content stays well-formed no
 * matter what the child wrote. '>' stays raw: XML permits it and the §2/§8 emit key
 * (task:<id>:-><status>) contains it, so escaping it would corrupt the id attribute.
 */
const EXPECTED_ESCAPED = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
  <bg-task-notification
    id="task:01JBZ00000000000000000000A:->succeeded"
    task-id="01JBZ00000000000000000000A"
    subscription-id="01JBZ00000000000000000010S"
    status="succeeded"
    label="a&lt;b>c &amp; d&quot;e&#10;f"
    agent-name="researcher"
    depth="0"
    duration-ms="0"
    transition-at-ms="1700000001000">
    <output-bytes>7</output-bytes>
    <output-preview>x&lt;y &amp; z&quot;w&#10;v</output-preview>
  </bg-task-notification>
</bg-task-notifications>`;

// --- renderTaskNotifications (ADR-0022 §7) ---------------------------------------------------

describe("renderTaskNotifications (ADR-0022 §7)", () => {
  test("renders the ADR §7 running golden literal", () => {
    expect(renderTaskNotifications([makeItem()], OPTS)).toBe(EXPECTED_RUNNING);
  });

  test("renders output-bytes / output-ref / output-preview for a terminal event", () => {
    const item = makeItem(
      {
        status: "succeeded",
        durationMs: 5432,
        transitionAt: 1_700_000_005_000,
        outputRef: "tasks/01JBZ00000000000000000000A/output.log",
        outputBytes: 11,
        outputPreview: "partial out",
      },
      {
        type: `task:${TASK_ID}:->succeeded`,
        status: "succeeded",
        transitionAtMs: 1_700_000_005_000,
        outputBytes: 11,
        outputPreview: "partial out",
      },
    );

    expect(renderTaskNotifications([item], OPTS)).toBe(EXPECTED_SUCCEEDED);
  });

  test("escapes arbitrary label and preview text", () => {
    const item = makeItem(
      {
        status: "succeeded",
        outputBytes: 7,
        outputPreview: ESCAPED_PREVIEW_RAW,
        label: ESCAPED_LABEL_RAW,
      },
      {
        type: `task:${TASK_ID}:->succeeded`,
        status: "succeeded",
        outputBytes: 7,
        outputPreview: ESCAPED_PREVIEW_RAW,
      },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    expect(rendered).toBe(EXPECTED_ESCAPED);
    // Counterfactual: dropping the escape lets the raw label through and this fails.
    expect(rendered).not.toContain(ESCAPED_LABEL_RAW);
    expect(rendered).not.toContain(ESCAPED_PREVIEW_RAW);
  });

  test("renders nothing for an empty item list (zero-event batch)", () => {
    expect(renderTaskNotifications([], OPTS)).toBe("");
  });
});

// --- output-preview ceiling (ADR-0022 §3/§7) ------------------------------------------------

describe("output-preview ceiling (ADR-0022 §3/§7)", () => {
  test("the shipped ceiling is the ADR literal 2048 bytes", () => {
    // Oracle: ADR-0022 §3 "≤2 KB inline preview" and §7 "output-preview only when
    // outputBytes <= 2048". The constant is single-sourced in task-registry.ts.
    expect(OUTPUT_PREVIEW_MAX_BYTES).toBe(2048);
  });

  test("preview is present at the ceiling (2048)", () => {
    const item = makeItem(
      { status: "succeeded", outputBytes: OUTPUT_PREVIEW_MAX_BYTES, outputPreview: "p" },
      { status: "succeeded", outputBytes: OUTPUT_PREVIEW_MAX_BYTES, outputPreview: "p" },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    // Counterfactual: swapping the renderer's `<=` for `<` drops the tag and this fails.
    expect(rendered).toContain("<output-preview>p</output-preview>");
  });

  test("preview is absent one byte over the ceiling (2049)", () => {
    const item = makeItem(
      { status: "succeeded", outputBytes: OUTPUT_PREVIEW_MAX_BYTES + 1, outputPreview: "p" },
      { status: "succeeded", outputBytes: OUTPUT_PREVIEW_MAX_BYTES + 1, outputPreview: "p" },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    // Counterfactual: removing the ceiling check (always emit the preview) adds the tag and
    // this assertion fails. The raw output must be fetched via outputRef instead.
    expect(rendered).not.toContain("<output-preview>");
    expect(rendered).toContain("<output-bytes>2049</output-bytes>");
  });

  test("preview is absent when outputBytes is unknown even if preview text exists", () => {
    const item = makeItem(
      { status: "succeeded", outputBytes: undefined, outputPreview: "p" },
      { status: "succeeded", outputBytes: undefined, outputPreview: "p" },
    );

    // ADR-0022 §7 gates the preview on the byte count; without it the renderer cannot prove
    // the payload is small, so outputRef is the only source of truth.
    expect(renderTaskNotifications([item], OPTS)).not.toContain("<output-preview>");
  });
});

// --- splitTaskNotificationBatches (ADR-0022 §7) ---------------------------------------------

describe("splitTaskNotificationBatches (ADR-0022 §7)", () => {
  test("returns an empty array for an empty item list", () => {
    expect(splitTaskNotificationBatches([], DEFAULT_MAX_BATCH_BYTES)).toEqual([]);
    expect(splitTaskNotificationBatches([])).toEqual([]);
  });

  test("keeps a multi-event batch that fits the budget in one order-preserving batch", () => {
    const items = [itemAt(0), itemAt(1), itemAt(2)];

    const batches = splitTaskNotificationBatches(items);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(items);
  });

  test("splits an over-budget payload on event boundaries without losing anything", () => {
    // ~500-char labels push each rendered child well past a 900-byte batch budget, so the
    // greedy packer must split along item boundaries.
    const items = [
      itemAt(0, "L".repeat(500)),
      itemAt(1, "L".repeat(500)),
      itemAt(2, "L".repeat(500)),
    ];

    const batches = splitTaskNotificationBatches(items, 900);

    expect(batches.length).toBeGreaterThan(1);
    // Invariant (#4 source: structural property): order + multiset preserved, so the union
    // of the batches equals the input set and the event count is conserved.
    expect(batches.flat()).toEqual(items);
    expect(batches.flat()).toHaveLength(items.length);
  });

  test("gives a single oversized item its own batch and never drops it", () => {
    const smallBefore = itemAt(0);
    const huge = itemAt(1, "H".repeat(500));
    const smallAfter = itemAt(2);
    const items = [smallBefore, huge, smallAfter];

    const batches = splitTaskNotificationBatches(items, 900);

    expect(batches).toEqual([[smallBefore], [huge], [smallAfter]]);
    expect(batches.flat()).toEqual(items);
  });

  test("never exceeds the byte budget for a multi-event batch", () => {
    for (const maxBytes of [1, 200, 900, 1500, DEFAULT_MAX_BATCH_BYTES]) {
      const items = [itemAt(0, "a".repeat(100)), itemAt(1, "b".repeat(50)), itemAt(2)];
      const batches = splitTaskNotificationBatches(items, maxBytes);

      expect(batches.flat()).toEqual(items);

      for (const batch of batches) {
        if (batch.length > 1) {
          const renderedBytes = Buffer.byteLength(renderTaskNotifications(batch, OPTS), "utf8");
          expect(renderedBytes).toBeLessThanOrEqual(maxBytes);
        }
      }
    }
  });
});

// --- shouldDeliverTaskNotification (T4.4 suppression) ----------------------------------------

describe("shouldDeliverTaskNotification (T4.4 suppression)", () => {
  const cases: ReadonlyArray<{ status: TaskStatus; deliver: boolean }> = [
    { status: "succeeded", deliver: true },
    { status: "failed", deliver: true },
    { status: "lost", deliver: true },
    { status: "canceled", deliver: false },
    { status: "running", deliver: false },
    { status: "stopping", deliver: false },
  ];

  for (const c of cases) {
    test(`${c.status} -> ${String(c.deliver)}`, () => {
      // T4.4 "谁停谁报告": a canceled task is owned by whoever stopped it, so it must not
      // emit a completion notification. Non-terminal states have no completion yet.
      expect(shouldDeliverTaskNotification(fixtureRecord({ status: c.status }))).toBe(c.deliver);
    });
  }
});

// --- counterfactual (constraint #5) ----------------------------------------------------------

describe("counterfactual (constraint #5)", () => {
  // These build the obviously-wrong variants the ticket names and show the spec assertions
  // above genuinely reject them. A regression that weakened an assertion would lose this
  // property, so the counterfactual guards the spec.

  test("removing the preview ceiling would break the 2049 test", () => {
    const item = makeItem(
      { status: "succeeded", outputBytes: 2049, outputPreview: "p" },
      { status: "succeeded", outputBytes: 2049, outputPreview: "p" },
    );
    const real = renderTaskNotifications([item], OPTS);
    const ceilingless = real.replace(
      "  </bg-task-notification>",
      "    <output-preview>p</output-preview>\n  </bg-task-notification>",
    );

    expect(real).not.toContain("<output-preview>");
    expect(ceilingless).not.toBe(real);
    expect(ceilingless).toContain("<output-preview>p</output-preview>");
  });

  test("swapping <= for < would break the 2048 test", () => {
    const item = makeItem(
      { status: "succeeded", outputBytes: 2048, outputPreview: "p" },
      { status: "succeeded", outputBytes: 2048, outputPreview: "p" },
    );
    const real = renderTaskNotifications([item], OPTS);
    const strictLess = real.replace("    <output-preview>p</output-preview>\n", "");

    expect(real).toContain("<output-preview>p</output-preview>");
    expect(strictLess).not.toContain("<output-preview>");
    expect(strictLess).not.toBe(real);
  });

  test("dropping XML escaping would break the escaping test", () => {
    const item = makeItem(
      {
        status: "succeeded",
        outputBytes: 7,
        outputPreview: ESCAPED_PREVIEW_RAW,
        label: ESCAPED_LABEL_RAW,
      },
      { status: "succeeded", outputBytes: 7, outputPreview: ESCAPED_PREVIEW_RAW },
    );
    const real = renderTaskNotifications([item], OPTS);
    const unescaped = real.replace("a&lt;b>c &amp; d&quot;e&#10;f", ESCAPED_LABEL_RAW);

    expect(real).not.toContain(ESCAPED_LABEL_RAW);
    expect(unescaped).not.toBe(real);
    expect(unescaped).toContain(ESCAPED_LABEL_RAW);
  });

  test("dropping an oversized item would break the preservation assertion", () => {
    const huge = itemAt(0, "H".repeat(500));
    const small = itemAt(1);
    const batches = splitTaskNotificationBatches([huge, small], 900);
    const dropped = batches.filter((batch) => !(batch.length === 1 && batch[0] === huge));

    expect(batches.flat()).toEqual([huge, small]);
    expect(dropped).not.toEqual([huge, small]);
  });
});
