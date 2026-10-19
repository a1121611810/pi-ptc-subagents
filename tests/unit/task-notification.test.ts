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

/**
 * 19 keys — the full ADR-0022 §3 field set, with no ADR-0023 owner fields (`ownerPid` /
 * `ownerBootMs` are left unset here; the notification renderer never reads them). Overrides vary
 * only what a test reads.
 */
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

/**
 * Provenance: the real failure shape behind the 2026-10-19 field report — a child killed by a
 * 429 after pi retried writes `stopReason: "error"` + this `errorMessage` onto its assistant
 * `message_end`, produces an empty content list, and leaves a 0-byte output.log (pi 0.87.1
 * capture recorded in `dispatch.ts`'s child-failure doc). The first line is that captured
 * string verbatim; the second line is adversarial text added on purpose so the element is
 * exercised on `<`, `>`, `&`, `"` and a literal newline — the same characters every other
 * text field must survive.
 */
const FAILED_ERROR_RAW =
  '429 {"type":"error","error":{"type":"rate_limit_error",...}}\n' +
  "child produced 0 bytes of output & no final text <exit=1>";

/**
 * Provenance: ADR-0022 §7 layout as amended on 2026-10-19 (field report): the
 * `<error-message>` child sits between `<output-bytes>` and `<output-ref>`. The zero byte count
 * is the report's real case, not a placeholder — the log reference exists and the log is
 * empty, which is exactly why the empty log alone (with no diagnosis beside it) read to the
 * model as an infrastructure fault.
 */
const EXPECTED_FAILED_WITH_ERROR = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
  <bg-task-notification
    id="task:01JBZ00000000000000000000A:->failed"
    task-id="01JBZ00000000000000000000A"
    subscription-id="01JBZ00000000000000000010S"
    status="failed"
    label="research X"
    agent-name="researcher"
    depth="0"
    duration-ms="3000"
    transition-at-ms="1700000004000">
    <output-bytes>0</output-bytes>
    <error-message>429 {&quot;type&quot;:&quot;error&quot;,&quot;error&quot;:{&quot;type&quot;:&quot;rate_limit_error&quot;,...}}&#10;child produced 0 bytes of output &amp; no final text &lt;exit=1></error-message>
    <output-ref>tasks/01JBZ00000000000000000000A/output.log</output-ref>
  </bg-task-notification>
</bg-task-notifications>`;

/**
 * Provenance: same amendment layout for a failed record that has no output.log at all
 * (`record.outputRef === undefined`): the diagnosis still follows `<output-bytes>` and
 * `<output-preview>` keeps its own ADR-0022 §7 rule, so the two optional children do not
 * interfere.
 */
const EXPECTED_FAILED_NO_REF = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
  <bg-task-notification
    id="task:01JBZ00000000000000000000A:->failed"
    task-id="01JBZ00000000000000000000A"
    subscription-id="01JBZ00000000000000000010S"
    status="failed"
    label="research X"
    agent-name="researcher"
    depth="0"
    duration-ms="2000"
    transition-at-ms="1700000003000">
    <output-bytes>5</output-bytes>
    <error-message>child exited 1</error-message>
    <output-preview>boom</output-preview>
  </bg-task-notification>
</bg-task-notifications>`;

/**
 * Provenance: ADR-0022 §7 as amended a second time on 2026-10-19 — ADR-0032's report channel
 * rides the completion push, between `<output-bytes>` and `<output-ref>`. Same succeeded record
 * as {@link EXPECTED_SUCCEEDED} (the registry writes `reportChannel` only on the `succeeded`
 * close, so this pair is the real shape), channel `tool`: the child declared its report over
 * the report tool's `structuredContent`.
 */
const EXPECTED_SUCCEEDED_WITH_CHANNEL = `<bg-task-notifications batch-id="01JBZ00000000000000000000B" delivered-at-ms="1700000002000">
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
    <report-channel>tool</report-channel>
    <output-ref>tasks/01JBZ00000000000000000000A/output.log</output-ref>
    <output-preview>partial out</output-preview>
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

// --- <error-message> amendment (ADR-0022 §7, 2026-10-19 field report) -----------------------

describe("<error-message> amendment (ADR-0022 §7, 2026-10-19)", () => {
  test("renders <error-message> between <output-bytes> and <output-ref>, XML-escaped", () => {
    const item = makeItem(
      {
        status: "failed",
        exitCode: 1,
        durationMs: 3000,
        transitionAt: 1_700_000_004_000,
        outputRef: "tasks/01JBZ00000000000000000000A/output.log",
        outputBytes: 0,
        errorMessage: FAILED_ERROR_RAW,
      },
      {
        type: `task:${TASK_ID}:->failed`,
        status: "failed",
        transitionAtMs: 1_700_000_004_000,
        outputBytes: 0,
      },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    expect(rendered).toBe(EXPECTED_FAILED_WITH_ERROR);
    // Position is an amendment invariant of its own: the diagnosis sits between the byte
    // count and the log reference, so a model that can read the bytes can read why they are
    // zero. (The golden literal would catch a move; this names the order directly.)
    const bytesAt = rendered.indexOf("<output-bytes>");
    const errorAt = rendered.indexOf("<error-message>");
    const refAt = rendered.indexOf("<output-ref>");
    expect(bytesAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(bytesAt);
    expect(refAt).toBeGreaterThan(errorAt);
    // Counterfactual: interpolating without escapeXml leaves the raw quotes/newline in and
    // this fails; the golden literal above differs too, but this is the direct claim.
    expect(rendered).not.toContain(FAILED_ERROR_RAW);
  });

  test("omits <error-message> when the record carries no errorMessage", () => {
    // Three shapes the registry can actually produce: running has no terminal diagnosis;
    // succeeded resolves with errorMessage undefined (#resolveExit returns undefined for
    // succeeded); a failed non-zero exit that nothing labelled (resolveExitErrorMessage's
    // fall-through) also has none. All three keep the pre-amendment golden literals intact.
    const running = renderTaskNotifications([makeItem()], OPTS);
    expect(running).toBe(EXPECTED_RUNNING);
    expect(running).not.toContain("<error-message>");

    const succeededItem = makeItem(
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
    const succeeded = renderTaskNotifications([succeededItem], OPTS);
    expect(succeeded).toBe(EXPECTED_SUCCEEDED);
    expect(succeeded).not.toContain("<error-message>");

    const failedUnlabelled = renderTaskNotifications(
      [
        makeItem(
          { status: "failed", exitCode: 1 },
          { type: `task:${TASK_ID}:->failed`, status: "failed" },
        ),
      ],
      OPTS,
    );
    expect(failedUnlabelled).not.toContain("<error-message>");
  });

  test("truncates an overlong errorMessage to 1023 head chars + an ellipsis", () => {
    // The cap is a CHARACTER budget, not a byte one: 1024 chars expand to at most ~6 KiB under
    // escapeXml and the ADR-0022 §7 batch budget is 100 KiB, while estimateItemBytes renders
    // through this same function so the split accounting agrees by construction. Keep the
    // head, drop the tail, and say so with a visible ellipsis.
    const head = "A".repeat(1023);
    const raw = head + "TAIL-MARKER" + "B".repeat(1000);
    const rendered = renderTaskNotifications(
      [
        makeItem(
          { status: "failed", errorMessage: raw },
          { type: `task:${TASK_ID}:->failed`, status: "failed" },
        ),
      ],
      OPTS,
    );

    const match = /<error-message>([\s\S]*?)<\/error-message>/.exec(rendered);
    expect(match?.[1]).toBe(`${head}…`);
    // Counterfactual: a slice(0, 1024) truncation that skips the ellipsis fails the exact
    // comparison above; one that keeps 1024 head chars keeps a marker character and fails here.
    expect(rendered).not.toContain("TAIL-MARKER");
    expect(rendered).not.toContain("B".repeat(10));
  });

  test("keeps an errorMessage of exactly 1024 chars intact (cap boundary)", () => {
    const exact = "C".repeat(1024);
    const rendered = renderTaskNotifications(
      [
        makeItem(
          { status: "failed", errorMessage: exact },
          { type: `task:${TASK_ID}:->failed`, status: "failed" },
        ),
      ],
      OPTS,
    );

    // Counterfactual: a >= cap or an unconditional truncation appends the ellipsis here and
    // fails both assertions, so the boundary states which side of 1024 is untouched.
    expect(rendered).toContain(`<error-message>${exact}</error-message>`);
    expect(rendered).not.toContain("…");
  });

  test("truncates on code points, never splitting a surrogate pair at the cap boundary", () => {
    // The cap is a CHARACTER budget, and a JavaScript string is UTF-16: 1022 ASCII characters
    // put an astral character's HIGH surrogate exactly where a `slice(0, 1023)` would cut. The
    // helper counts code points, so the emoji is kept whole in the head (1022 + 1 = 1023 code
    // points) and the ellipsis follows it. Counterfactual: a code-unit slice yields a lone high
    // surrogate here, the exact string comparison fails, and the lone-surrogate scan below
    // catches the U+FFFD class even if a different tail were chosen.
    const emoji = "\u{1F600}"; // a surrogate PAIR in UTF-16: code units 2, code points 1
    const raw = "A".repeat(1022) + emoji + "B".repeat(10);
    const rendered = renderTaskNotifications(
      [
        makeItem(
          { status: "failed", errorMessage: raw },
          { type: `task:${TASK_ID}:->failed`, status: "failed" },
        ),
      ],
      OPTS,
    );

    const match = /<error-message>([\s\S]*?)<\/error-message>/.exec(rendered);
    expect(match?.[1]).toBe("A".repeat(1022) + emoji + "…");
    // A lone surrogate cannot survive this scan: the valid pair is two adjacent surrogates,
    // while a split pair leaves one unpaired. Either direction of the pair is checked.
    expect(rendered).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(rendered).not.toContain("\uFFFD");
  });

  test("renders <error-message> for a failed record with no outputRef, before <output-preview>", () => {
    const item = makeItem(
      {
        status: "failed",
        exitCode: 1,
        durationMs: 2000,
        transitionAt: 1_700_000_003_000,
        outputBytes: 5,
        outputPreview: "boom",
        errorMessage: "child exited 1",
      },
      {
        type: `task:${TASK_ID}:->failed`,
        status: "failed",
        transitionAtMs: 1_700_000_003_000,
        outputBytes: 5,
        outputPreview: "boom",
      },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    expect(rendered).toBe(EXPECTED_FAILED_NO_REF);
    // No log reference exists, yet the diagnosis still follows <output-bytes>; the preview
    // keeps its own ADR-0022 §7 rule and stays after the diagnosis.
    expect(rendered).not.toContain("<output-ref>");
    const errorAt = rendered.indexOf("<error-message>");
    expect(errorAt).toBeGreaterThan(rendered.indexOf("<output-bytes>"));
    expect(rendered.indexOf("<output-preview>")).toBeGreaterThan(errorAt);
  });
});

// --- <report-channel> amendment 2 (ADR-0022 §7, 2026-10-19, ADR-0032) -----------------------

/**
 * The four ADR-0032 channels, literal from `ChildReportChannel` in `src/runtime/child-report.ts`.
 * The expected values are the spec's value domain, not a capture from the renderer.
 */
const REPORT_CHANNELS = ["tool", "prompt-json", "none", "opted-out"] as const;

/**
 * A succeeded record carrying one channel. `reportChannel` is written by the registry ONLY on
 * the `succeeded` close (`#resolveExit`'s `to === "succeeded"` branch), so a `running` /
 * `failed` / `canceled` / `lost` record never reaches this renderer with one.
 */
function succeededWithChannel(channel: (typeof REPORT_CHANNELS)[number]): TaskNotificationItem {
  return makeItem(
    {
      status: "succeeded",
      durationMs: 5432,
      transitionAt: 1_700_000_005_000,
      outputRef: "tasks/01JBZ00000000000000000000A/output.log",
      outputBytes: 11,
      outputPreview: "partial out",
      reportChannel: channel,
    },
    {
      type: `task:${TASK_ID}:->succeeded`,
      status: "succeeded",
      transitionAtMs: 1_700_000_005_000,
      outputBytes: 11,
      outputPreview: "partial out",
    },
  );
}

describe("<report-channel> amendment 2 (ADR-0022 §7, 2026-10-19)", () => {
  test("renders each of the four ADR-0032 channels, between <output-bytes> and <output-ref>", () => {
    for (const channel of REPORT_CHANNELS) {
      const rendered = renderTaskNotifications([succeededWithChannel(channel)], OPTS);

      expect(rendered).toContain(`<report-channel>${channel}</report-channel>`);
      // Position: the channel is a fact about the close, so it rides in the same slot the
      // amendment gives the other post-bytes metadata — before the log reference.
      expect(rendered.indexOf("<report-channel>")).toBeGreaterThan(
        rendered.indexOf("<output-bytes>"),
      );
      expect(rendered.indexOf("<report-channel>")).toBeLessThan(rendered.indexOf("<output-ref>"));
    }
  });

  test("renders the full amended golden literal for a succeeded channel-bearing record", () => {
    expect(renderTaskNotifications([succeededWithChannel("tool")], OPTS)).toBe(
      EXPECTED_SUCCEEDED_WITH_CHANNEL,
    );
  });

  test("omits <report-channel> when the record carries no channel", () => {
    // running has no close yet, and a failed close writes no channel (ADR-0032: a child that
    // did not finish has not reported). Both keep their pre-amendment golden literals intact.
    const running = renderTaskNotifications([makeItem()], OPTS);
    expect(running).toBe(EXPECTED_RUNNING);
    expect(running).not.toContain("<report-channel>");

    const failedWithError = renderTaskNotifications(
      [
        makeItem(
          {
            status: "failed",
            exitCode: 1,
            durationMs: 3000,
            transitionAt: 1_700_000_004_000,
            outputRef: "tasks/01JBZ00000000000000000000A/output.log",
            outputBytes: 0,
            errorMessage: FAILED_ERROR_RAW,
          },
          {
            type: `task:${TASK_ID}:->failed`,
            status: "failed",
            transitionAtMs: 1_700_000_004_000,
            outputBytes: 0,
          },
        ),
      ],
      OPTS,
    );
    expect(failedWithError).toBe(EXPECTED_FAILED_WITH_ERROR);
    expect(failedWithError).not.toContain("<report-channel>");
  });

  test("orders <error-message> before <report-channel> when a synthetic record carries both", () => {
    // The registry cannot produce this pair: reportChannel is written only on `succeeded`,
    // errorMessage only on `failed` / `lost`. The record is deliberately synthetic, and it pins
    // the amendment's stated order for a renderer that is policy-free about status and would
    // otherwise emit both children in whatever order their branches happen to sit.
    const item = makeItem(
      {
        status: "failed",
        errorMessage: "session ended while running",
        reportChannel: "none",
        outputRef: "tasks/01JBZ00000000000000000000A/output.log",
      },
      { type: `task:${TASK_ID}:->failed`, status: "failed" },
    );

    const rendered = renderTaskNotifications([item], OPTS);
    const bytesAt = rendered.indexOf("<output-bytes>");
    const errorAt = rendered.indexOf("<error-message>");
    const channelAt = rendered.indexOf("<report-channel>");
    const refAt = rendered.indexOf("<output-ref>");
    expect(errorAt).toBeGreaterThan(bytesAt);
    expect(channelAt).toBeGreaterThan(errorAt);
    expect(refAt).toBeGreaterThan(channelAt);
  });

  test("renders <error-message> for a lost record — lost is a deliverable status (§2/§8)", () => {
    const item = makeItem(
      { status: "lost", errorMessage: "session_ended_while_running" },
      { type: `task:${TASK_ID}:->lost`, status: "lost" },
    );

    const rendered = renderTaskNotifications([item], OPTS);

    // ADR-0022 §8 keeps the three lost reasons distinct in `errorMessage`, and a lost task is a
    // deliverable completion (the model must learn the task died), so the reason rides the same
    // element a failed close uses.
    expect(shouldDeliverTaskNotification(item.record)).toBe(true);
    expect(rendered).toContain("<error-message>session_ended_while_running</error-message>");
    // A lost record never reached a close, so no report channel was ever declared.
    expect(rendered).not.toContain("<report-channel>");
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

  test("the pipeline module is the single source: one budget constant, no second splitter", async () => {
    const pipelineModule = await import("../../src/runtime/notification-pipeline.ts");

    // ADR-0022 §7 line: `DEFAULT_MAX_BATCH_BYTES = 100 * 1024` (100 KiB). The pipeline module
    // is the only place that number is declared; the renderer consumes the same export.
    expect(pipelineModule.DEFAULT_MAX_BATCH_BYTES).toBe(100 * 1024);
    // Contract rule 6 (split is single-sourced): no competing event-level splitter remains in
    // the pipeline. Counterfactual: re-adding `splitBatch`/`estimateEventBytes` makes this red.
    expect("splitBatch" in pipelineModule).toBe(false);
    expect("estimateEventBytes" in pipelineModule).toBe(false);
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

// Counterfactual note (constraint #5, review-2 finding B5): this file used to carry a
// "counterfactual" block that mutated the RENDERED STRING and asserted the mutation differed.
// That is self-referential - a broken renderer leaves it green - so it was deleted. Each real
// assertion above already rejects the named wrong implementation:
//   - the 2049-byte case asserts the output does NOT contain `<output-preview>`, so an
//     implementation that always inlines the preview fails it;
//   - the 2048-byte case asserts it DOES, so `<` instead of `<=` fails it;
//   - the escaping case asserts the raw `<`/`&`/`"`/newline never appear, so a renderer that
//     interpolates without escaping fails it;
//   - the preservation case asserts the flattened batches equal the input, so a splitter that
//     drops an oversized item fails it.
// Weakening those assertions - not adding a string mutation - is what would weaken the suite.
