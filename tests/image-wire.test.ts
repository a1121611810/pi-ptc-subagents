/**
 * Image hoist tests — ADR-0017 §8.
 *
 * `PtcImage` carries base64 (`data`), the same representation pi's own `read` tool returns,
 * so the tool layer forwards it to pi without re-encoding. `captureImages` accepts both
 * shapes from a binding: `data: <base64>` passes through, `bytes: ArrayBuffer` (a binding
 * that produces raw bytes) is normalised to base64 once, host-side.
 *
 * Every case runs through `runPtcProgram()` against a real worker, so the JSON-only channel
 * (which is what makes base64 the wire shape in the first place) is part of the verified
 * path — a program may return part of a binding result, and an `ArrayBuffer` could not
 * survive that.
 */
import { describe, expect, test } from "vitest";
import { runPtcProgram } from "../src/runtime/dispatcher.ts";
import type { BindingTable } from "../src/runtime/bindings.ts";
import {
  makeBindings,
  ONE_PIXEL_PNG_BASE64,
  onePixelPngBytes,
  RUN_TIMEOUT_MS,
} from "./helpers/ptc.ts";

/** Run a program whose single `shot` call returns the supplied `content`. */
async function capture(content: unknown[]): Promise<{ data: string; mimeType: string }[]> {
  const bindings: BindingTable = makeBindings({
    shot: async () => ({ content, details: null }),
  });
  const outcome = await runPtcProgram({
    code: "await tools.shot({}); return 1;",
    surface: "run_code",
    cwd: process.cwd(),
    bindings,
  });
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBe(1);
  return (outcome.images ?? []) as { data: string; mimeType: string }[];
}

describe("captureImages — base64 pass-through (the pi shape)", () => {
  test(
    "a binding emitting `data: <base64>` is forwarded character-for-character",
    async () => {
      const images = await capture([
        { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(images).toHaveLength(1);
      // Character-for-character equality proves there is no decode/encode round trip.
      expect(images[0]?.data).toBe(ONE_PIXEL_PNG_BASE64);
      expect(images[0]?.mimeType).toBe("image/png");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a block with no mimeType defaults to application/octet-stream",
    async () => {
      const images = await capture([{ type: "image", data: ONE_PIXEL_PNG_BASE64 }]);
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe("application/octet-stream");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "an empty `data` string hoists nothing",
    async () => {
      const images = await capture([{ type: "image", data: "", mimeType: "image/png" }]);
      expect(images).toHaveLength(0);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "non-image blocks are ignored, image blocks are not filtered out by their neighbours",
    async () => {
      const images = await capture([
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
        { type: "text", text: "trailing text" },
      ]);
      expect(images).toHaveLength(1);
      expect(images[0]?.data).toBe(ONE_PIXEL_PNG_BASE64);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("captureImages — raw bytes compatibility path", () => {
  test(
    "a binding emitting `bytes: ArrayBuffer` is normalised to the same base64",
    async () => {
      const images = await capture([
        { type: "image", bytes: onePixelPngBytes(), mimeType: "image/png" },
      ]);
      expect(images).toHaveLength(1);
      // The host encoded the raw bytes once; the result is the pi representation.
      expect(images[0]?.data).toBe(ONE_PIXEL_PNG_BASE64);
      expect(images[0]?.mimeType).toBe("image/png");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "an empty ArrayBuffer hoists nothing",
    async () => {
      const images = await capture([
        { type: "image", bytes: new ArrayBuffer(0), mimeType: "image/png" },
      ]);
      expect(images).toHaveLength(0);
    },
    RUN_TIMEOUT_MS,
  );
});
