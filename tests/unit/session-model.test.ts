/**
 * ADR-0044's structural reader of the caller session's model.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value comes from the
 * contract in .scratch/fix/CONTRACT.md ("P2 — 会话模型继承", the validation list for
 * `readContextModel`) or from a real captured sample — the 429 fixture carries
 * `provider: "minimax-cn-512k", model: "MiniMax-M3.1-Flash-Preview"`, so that pair is used as
 * the non-deepseek oracle rather than invented. Nothing here is read back off the implementation.
 *
 * Why the invalid shapes are listed one by one: this value is handed to a child process as an
 * argv element, so each rejected shape is a distinct boundary — a non-string would crash
 * concatenation, whitespace would split into two args, a leading "-" would be read as a flag, and
 * a missing component would format as `undefined/...`. `undefined` is the documented fallback:
 * the dispatch then keeps pi's configured default, which is the behaviour every caller had
 * before ADR-0044.
 */
import { describe, expect, test } from "vitest";
import {
  formatSessionModel,
  readContextModel,
  type SessionModel,
} from "../../src/runtime/session-model.ts";

/** The repo-wide session-model sample for NEW tests (CONTRACT: provider "deepseek" / id "deepseek-flash"). */
const DS_FLASH: SessionModel = { provider: "deepseek", id: "deepseek-flash" };
/** A real captured pair from tests/fixtures/pi-1.3.0-429-token-plan.jsonl (independent source). */
const CAPTURED_MODEL: SessionModel = {
  provider: "minimax-cn-512k",
  id: "MiniMax-M3.1-Flash-Preview",
};

/**
 * One pi-shaped tool context carrying `model`. Shaped like the real 5th parameter's model:
 * pi's `ctx.model` is an object with `provider` and `id` (CONTRACT's baseline facts), alongside
 * every other field a live context has. The irrelevant fields are here on purpose: the reader is
 * structural, so it must not depend on the rest of the context's shape.
 */
function contextWith(model: unknown): unknown {
  return {
    cwd: "/tmp/does-not-matter",
    tools: [],
    model,
    sessionManager: { getEntries: () => [] },
  };
}

describe("readContextModel", () => {
  test("reads the provider and id off a pi tool context", () => {
    const read = readContextModel(contextWith(DS_FLASH));
    // toEqual rather than toBe: the contract's return is a value, not the context's own object.
    expect(read).toEqual({ provider: "deepseek", id: "deepseek-flash" });
  });

  test("reads the real captured pair unchanged (independent source)", () => {
    expect(readContextModel(contextWith(CAPTURED_MODEL))).toEqual({
      provider: "minimax-cn-512k",
      id: "MiniMax-M3.1-Flash-Preview",
    });
  });

  test("ignores a context whose model is null, a string, a number, or absent", () => {
    // Four shapes rather than one: a context without the field is the direct-library-caller and
    // old-pi case, the rest are the type-confusion cases a structural reader must absorb.
    expect(readContextModel(contextWith(null))).toBeUndefined();
    expect(readContextModel(contextWith("deepseek/deepseek-flash"))).toBeUndefined();
    expect(readContextModel(contextWith(42))).toBeUndefined();
    expect(readContextModel({ sessionManager: {} })).toBeUndefined();
  });

  test("returns undefined for every non-object context", () => {
    // The reader accepts `unknown`, and a direct library caller may pass anything. Mutating the
    // guard away (`ctx.model` without the typeof check) throws here rather than returning
    // undefined, so this is the failure-path assertion for the structural read.
    for (const ctx of [undefined, null, "model", 0, true, [], () => {}]) {
      expect(readContextModel(ctx), "ctx=" + String(ctx)).toBeUndefined();
    }
  });

  test("returns undefined when the model has no usable id", () => {
    // A model with only a provider must NOT inherit: --model needs provider/id, and formatting
    // the absent half would hand the child "deepseek/undefined".
    expect(readContextModel(contextWith({ provider: "deepseek" }))).toBeUndefined();
  });

  test("returns undefined when the model has no usable provider", () => {
    // The symmetric case. pi's ctx.model always carries both, but the reader is the boundary a
    // value crosses, so a malformed shape is rejected here rather than formatted downstream.
    expect(readContextModel(contextWith({ id: "deepseek-flash" }))).toBeUndefined();
  });

  test("returns undefined for every non-string component", () => {
    const invalid: { label: string; provider: unknown; id: unknown }[] = [
      { label: "provider is a number", provider: 1, id: "deepseek-flash" },
      { label: "id is a boolean", provider: "deepseek", id: true },
      { label: "provider is an object", provider: {}, id: "deepseek-flash" },
      { label: "id is an array", provider: "deepseek", id: [] },
      { label: "provider is null", provider: null, id: "deepseek-flash" },
    ];
    for (const sample of invalid) {
      expect(
        readContextModel(contextWith({ provider: sample.provider, id: sample.id })),
        sample.label,
      ).toBeUndefined();
    }
  });

  test("returns undefined for every empty, whitespace-bearing, or control-character component", () => {
    // The contract's validation list, one case per line. The whitespace cases are the argv safety
    // property: a space-bearing `provider/id` is two arguments to the child, and a leading "-" is
    // read as a flag. The control-character cases are the gap plain `/\s/` does NOT cover.
    const invalidIds: string[] = [
      "",
      " ",
      "\t",
      "deepseek flash",
      "deepseek\nflash",
      " deepseek-flash",
      "deepseek-flash ",
      "deepseek\u0000flash",
      "deepseek\u0001flash",
    ];
    for (const id of invalidIds) {
      expect(
        readContextModel(contextWith({ provider: "deepseek", id })),
        JSON.stringify(id),
      ).toBeUndefined();
    }
    expect(
      readContextModel(contextWith({ provider: " deepseek ", id: "deepseek-flash" })),
      "surrounding whitespace in provider",
    ).toBeUndefined();
    expect(
      readContextModel(contextWith({ provider: "deep\u0000seek", id: "deepseek-flash" })),
      "control character in provider",
    ).toBeUndefined();
  });

  test("returns undefined for every component that starts with a dash", () => {
    // A value handed to a child as argv must never be parseable as a flag.
    expect(
      readContextModel(contextWith({ provider: "-deepseek", id: "deepseek-flash" })),
    ).toBeUndefined();
    expect(readContextModel(contextWith({ provider: "deepseek", id: "---force" }))).toBeUndefined();
  });

  test("returns undefined for an over-long component", () => {
    // A model id is short by construction; 10 000 characters is not a model, it is argv padding.
    // The exact cap is deliberately not pinned here — the contract says "length-bounded", not
    // "exactly 200" — so this asserts the property without copying the implementation's constant.
    const overlong = "x".repeat(10_000);
    expect(readContextModel(contextWith({ provider: "deepseek", id: overlong }))).toBeUndefined();
    expect(
      readContextModel(contextWith({ provider: overlong, id: "deepseek-flash" })),
    ).toBeUndefined();
  });
});

describe("formatSessionModel", () => {
  test("formats the session model as provider/id, pi's --model spelling", () => {
    // Literal from the contract's "可直接作为 pi 的 --model 参数" and pi's own resolver convention.
    expect(formatSessionModel(DS_FLASH)).toBe("deepseek/deepseek-flash");
  });

  test("formats a real captured pair byte for byte", () => {
    // Real sample: the 429 fixture's message_end message carries this exact provider/model pair.
    expect(formatSessionModel(CAPTURED_MODEL)).toBe("minimax-cn-512k/MiniMax-M3.1-Flash-Preview");
  });

  test("round-trips through readContextModel", () => {
    // Differential oracle (constraint #2/#4): the reader and the formatter must agree on the pair,
    // so a reader that reordered or dropped a field cannot stay green behind a correct formatter.
    const read = readContextModel(contextWith(DS_FLASH));
    if (read === undefined) throw new Error("the fixture context must yield a session model");
    expect(formatSessionModel(read)).toBe("deepseek/deepseek-flash");
  });
});
