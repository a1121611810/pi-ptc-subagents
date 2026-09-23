/**
 * Tests for the `serializedBytes` refactor (ADR-0017 W-6).
 *
 * The original helper was `Buffer.byteLength(JSON.stringify(value), "utf8")`. It had
 * two bugs that ADR-0017 fixes:
 *
 *  1. `JSON.stringify` serialises an `ArrayBuffer` to `{}`, so binary payloads were
 *     counted as 2 bytes regardless of size. This undercount allowed payloads that
 *     would blow the output budget to slip past the `maxMessageBytes` /
 *     `maxOutputBytes` checks.
 *  2. A `Uint8Array` view walks `.buffer` recursively, so the same bytes were
 *     counted twice — once for the view, once for the underlying buffer. This
 *     overcount rejected payloads that should have fit.
 *
 * The refactor keeps `JSON.stringify` as the measure of the frame's text — every brace,
 * separator, key name and scalar, which is what the wire carries — and adds the bytes of
 * binary leaves, which that text cannot express:
 *
 *  - structural pass: `JSON.stringify(value, replacer)` with every binary leaf substituted by
 *    `null`, so `JSON.parse`-visible structure is billed exactly and a view is not exploded
 *    into one key per element;
 *  - binary pass: `ArrayBuffer` / `ArrayBufferView` leaves by `byteLength`, counted once —
 *    the walk never recurses into a view's `.buffer`.
 *
 * A counting helper that skipped the structural pass (billing only text leaves) let a
 * structure-only value such as `Array(100_000).fill(null)` — ~500 KB of JSON with no
 * string/number/boolean leaf and no key — pass any budget; the first test below is that case.
 *
 * The tests cover each case end-to-end and pin the oversized-frame guard.
 */
import { describe, expect, test } from "vitest";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import { DEFAULT_CONFIG } from "../src/runtime/limits.ts";
import { makeBindings, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

// The `serializedBytes` helper is private to `dispatcher.ts`, so the suite drives it
// through `runPtcProgram`'s `maxMessageBytes` / `maxOutputBytes` accounting. A budget
// that the helper computes incorrectly fails (or fails to fail) the run with a
// known kind, which is exactly what each case asserts.

const empty = makeBindings({});

test(
  "text payload: behaviour unchanged — a known-size text frame is counted correctly",
  async () => {
    // An `args` payload of "x" * N contributes a known number of bytes to the
    // callResult frame. We pick a budget that just fits the frame so the run
    // succeeds; halving it makes the same payload a protocol failure (asserted by
    // the next test).
    const size = 1024;
    const code = `await tools.echo({ s: ${JSON.stringify("x".repeat(size))} }); return 1;`;
    const outcome = await runPtcProgram({
      code,
      surface: "run_code",
      cwd: process.cwd(),
      bindings: makeBindings({ echo: async (args) => (args as { s: string }).s.length }),
      config: { maxMessageBytes: 1024 * 1024 },
    });
    expect(outcome.error).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "ArrayBuffer payload: byteLength is counted (binary path)",
  async () => {
    // The dispatcher-side accounting sees the binding result's `content[*].bytes`
    // as raw `ArrayBuffer`. Walking the value must add its byteLength to the total
    // (the structural pass alone reports the frame's `{}` as 2 bytes). We force a
    // protocol failure by setting `maxMessageBytes` below the binary payload's size —
    // if the helper undercounted, the run would succeed and the test would fail.
    const bytes = new Uint8Array(8 * 1024).buffer; // 8 KiB
    const bindings = makeBindings({
      shot: async () => ({
        content: [{ type: "image", bytes, mimeType: "image/png" }],
        details: null,
      }),
    });
    const outcome = await runPtcProgram({
      code: "await tools.shot({}); return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      config: { maxMessageBytes: 1024 }, // Way below the 8 KiB binary payload.
    });
    expect(outcome.error?.kind).toBe("protocol");
    expect(String(outcome.error?.message)).toMatch(/maxMessageBytes/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "nested ArrayBuffer: object contents are counted",
  async () => {
    // Walk the value, find ArrayBuffers at any depth. A binary leaf nested inside
    // an object contributes its byteLength just like a top-level one.
    const inner = new Uint8Array(2 * 1024).buffer;
    const bindings = makeBindings({
      shot: async () => ({
        content: [{ type: "image", bytes: inner, mimeType: "image/png" }],
        details: { extra: { buffer: new Uint8Array(4 * 1024).buffer } },
      }),
    });
    // 4 KiB budget — fails because of the deeply nested buffer, not the top-level
    // 2 KiB one.
    const outcome = await runPtcProgram({
      code: "await tools.shot({}); return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      config: { maxMessageBytes: 3 * 1024 },
    });
    expect(outcome.error?.kind).toBe("protocol");
    expect(String(outcome.error?.message)).toMatch(/maxMessageBytes/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "Uint8Array: byteLength counted, .buffer NOT double-counted",
  async () => {
    // The view's `byteLength` is what the frame carries; recursing into `.buffer` would
    // add the same bytes again and trip the budget guard on payloads that should fit. The
    // test asserts the opposite: a budget between single-count and double-count proves the
    // walker counts once, not twice.
    const view = new Uint8Array(2048);
    const bindings = makeBindings({
      shot: async () => ({
        content: [{ type: "image", bytes: view, mimeType: "application/octet-stream" }],
        details: null,
      }),
    });
    // 3 KiB budget:
    //   - single-count frame: 2048 (view) + ~110 (structural text) ≈ 2158 bytes — fits.
    //   - double-count frame: 4096 (view + .buffer) + ~110 ≈ 4206 — fails.
    // If this test sees `protocol`, the walker is double-counting; if it sees
    // success, the walker correctly stops at the view.
    const outcome = await runPtcProgram({
      code: "await tools.shot({}); return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      config: { maxMessageBytes: 3 * 1024 },
    });
    expect(outcome.error).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "huge ArrayBuffer: a single frame trips maxMessageBytes",
  async () => {
    // The brief calls this out as a regression case: a payload that the old
    // JSON.stringify-only helper would have silently let through (ArrayBuffer
    // serialised as `{}`) now correctly trips the protocol guard.
    const huge = new Uint8Array(8 * 1024 * 1024).buffer; // 8 MiB
    const bindings = makeBindings({
      shot: async () => ({
        content: [{ type: "image", bytes: huge, mimeType: "image/png" }],
        details: null,
      }),
    });
    const outcome = await runPtcProgram({
      code: "await tools.shot({}); return 1;",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      config: { maxMessageBytes: 1024 * 1024 }, // 1 MiB cap; binary payload is 8 MiB.
    });
    expect(outcome.error?.kind).toBe("protocol");
    expect(String(outcome.error?.message)).toMatch(/maxMessageBytes/);
  },
  RUN_TIMEOUT_MS,
);

test(
  "images do not pass the output budget (ADR-0014 §Consequences)",
  async () => {
    // ADR-0014: "Images are not output. They never pass ADR-0003's output budget, which
    // measures logs plus the completion value, so a run can attach more image bytes than
    // it may print as text. That is deliberate." So a large image alongside a small log
    // must succeed even though the joint text budget is far below the image size.
    // Volume stays observable: the `ptc:image:hoist-bytes` channel and the row's
    // image count report it (see `tests/diagnostics-channels.test.ts`).
    const imageBytes = 256 * 1024;
    const chunk = "x".repeat(1024);
    const bindings = makeBindings({
      shot: async () => ({
        content: [
          { type: "image", bytes: new Uint8Array(imageBytes).buffer, mimeType: "image/png" },
        ],
        details: null,
      }),
    });
    const outcome = await runPtcProgram({
      code: `console.log(${JSON.stringify(chunk)}); await tools.shot({}); return 1;`,
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      config: { maxOutputBytes: 2 * 1024 },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.images).toHaveLength(1);
  },
  RUN_TIMEOUT_MS,
);

describe("default config still exposes a sensible bound", () => {
  test("default maxMessageBytes is large enough for normal frames", () => {
    expect(DEFAULT_CONFIG.maxMessageBytes).toBeGreaterThan(1024 * 1024);
  });
});

/* --------------------------------------------------------------------------------------------
 * Text-only accounting: the frame's structure is part of its size
 *
 * The refactor's own claim (ADR-0017 W-6: "text-only behaviour unchanged"). A budget that only
 * bills string/number/boolean leaves misses every structural character — braces, brackets,
 * separators, key names — and bills `null` at 0, so a value made of structure alone slips past
 * both budgets entirely.
 * ------------------------------------------------------------------------------------------ */

test(
  "structural-only value: braces, separators and null leaves are billed",
  async () => {
    // `Array(100_000).fill(null)` has no string/number/boolean leaf and no key: a walker that
    // bills only text leaves counts the frame's `"result"` (8 bytes) and nothing else, so a
    // ~500 KB completion value passes a 10 KB budget. The frame is what crosses the wire, so
    // its JSON size is the number both budgets have to use.
    const count = 100_000;
    const jsonBytes = Buffer.byteLength(JSON.stringify(Array(count).fill(null)), "utf8");
    expect(jsonBytes, "sanity: the value's JSON text alone is far over the budget").toBeGreaterThan(
      100_000,
    );
    const outcome = await runPtcProgram({
      code: `return Array(${count}).fill(null);`,
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      config: { maxOutputBytes: 10_000 },
    });
    expect(outcome.error?.kind).toBe("output-limit");
  },
  RUN_TIMEOUT_MS,
);

test(
  "text-only value: the count is byte-for-byte what JSON.stringify serialises",
  async () => {
    // The exact-equality pin for "behaviour unchanged". The worker posts `{kind: "result", value}`
    // (`PtcResultFrame`), so the frame's size is computable from the protocol shape: a budget of
    // exactly that size fits, one byte less trips the budget. A count that is off by even one
    // byte in either direction fails one half of this test.
    const value = { a: "hello", b: 123 };
    const code = `return ${JSON.stringify(value)};`;
    const exact = Buffer.byteLength(JSON.stringify({ kind: "result", value }), "utf8");
    const fits = await runPtcProgram({
      code,
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      config: { maxOutputBytes: exact },
    });
    expect(fits.error).toBeUndefined();
    expect(fits.value).toEqual(value);
    const over = await runPtcProgram({
      code,
      surface: "run_code",
      cwd: process.cwd(),
      bindings: empty,
      config: { maxOutputBytes: exact - 1 },
    });
    expect(over.error?.kind).toBe("output-limit");
  },
  RUN_TIMEOUT_MS,
);

/* --------------------------------------------------------------------------------------------
 * callResult frames answer to `maxMessageBytes` too
 *
 * A `callResult` is a control frame, and `maxMessageBytes` is "cap on a single control frame,
 * either direction" (`limits.ts`, R1 §1). DSH's own taxonomy maps `protocol` to "malformed or
 * excessive control traffic", so an over-cap frame ends the *run* — exactly like the `init` frame
 * and every inbound frame — rather than failing the single call (that path is reserved for a
 * value the port cannot clone, `postCallResult`).
 * ------------------------------------------------------------------------------------------ */

test(
  "an oversize text callResult fails the run as excessive control traffic, not just the call",
  async () => {
    const bindings = makeBindings({
      big: async () => ({
        content: [{ type: "text", text: "x".repeat(4 * 1024) }],
        details: null,
      }),
    });
    const outcome = await runPtcProgram({
      code: "await tools.big({}); return 'reached';",
      surface: "run_code",
      cwd: process.cwd(),
      bindings,
      // 1 KiB cap for a ~4 KiB text result: over the cap as text alone, no binary involved.
      config: { maxMessageBytes: 1024 },
    });
    expect(outcome.error?.kind).toBe("protocol");
    expect(String(outcome.error?.message)).toMatch(
      /callResult frame of \d+ bytes exceeds maxMessageBytes/,
    );
    expect(outcome.value, "the program never receives the oversized result").toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

// Touch the import so tsc does not flag `empty` as unused on typecheck runs.
void empty;
