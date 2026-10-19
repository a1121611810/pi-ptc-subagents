/**
 * ADR-0044's structural reader of the caller session's model, and the formatter of the model the
 * host observed a child running.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value comes from an
 * in-repo source — ADR-0044 Decision 1 (docs/adr/0044-a-dispatch-inherits-the-session-model.md)
 * for the validation list and precedence, Decision 2 for the observed-model rendering — or from
 * a real captured sample: the live 429 capture
 * (tests/fixtures/pi-1.3.0-429-token-plan.jsonl) carries
 * `provider: "minimax-cn-512k", model: "MiniMax-M3.1-Flash-Preview"`, used as the
 * non-deepseek oracle rather than invented. Nothing here is read back off the implementation.
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
  formatObservedModel,
  formatSessionModel,
  readContextModel,
  type SessionModel,
} from "../../src/runtime/session-model.ts";

/** The session-model sample the ADR-0044 tests share: provider "deepseek" / id "deepseek-flash". */
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
/**
 * ADR-0044 Decision 2: the observed provider/model is HOST data read off the child's wire, and it
 * is rendered into text a model reads. It is therefore untrusted input, and the formatter is the
 * one place that normalises it. These tests pin the INVARIANT rather than the implementation: one
 * bounded single line, no ANSI escape, no control character.
 */
const OBSERVED_MODEL_MAX_CHARS = 200; // Decision 2's rendering bound (the value, not "model: ")
const INJECTED_PROVIDER = "\x1b[31mP\x1b[0m";
const INJECTED_MODEL = "M\nX".repeat(3_000);

describe("formatObservedModel sanitizes the child-observed pair", () => {
  test("ANSI escapes and control characters never reach the rendered model", () => {
    const value = formatObservedModel(INJECTED_PROVIDER, INJECTED_MODEL);
    if (value === undefined) throw new Error("a non-empty model must format");
    expect(value).not.toContain("\x1b");
    expect(value).not.toContain("\n");
    expect(value).not.toContain("\r");
    // C0/C1 controls are all stripped, not only the ones this injection happens to carry.
    expect(value).not.toMatch(/\p{Cc}/u);
  });

  test("the rendered value is capped at 200 characters, and the cap keeps the front", () => {
    // Chosen truncation (Lead's contract): sanitize first ("M\nX" becomes "MX"), then keep the
    // first 200 characters with no ellipsis. The provider prefix is part of the rendered VALUE,
    // so the total stays within the same bound.
    const modelOnly = formatObservedModel(undefined, INJECTED_MODEL);
    expect(modelOnly).toBe("MX".repeat(100));
    expect(modelOnly?.length).toBe(OBSERVED_MODEL_MAX_CHARS);
    const withProvider = formatObservedModel(INJECTED_PROVIDER, INJECTED_MODEL);
    if (withProvider === undefined) throw new Error("a non-empty pair must format");
    expect(withProvider.length).toBeLessThanOrEqual(OBSERVED_MODEL_MAX_CHARS);
    expect(withProvider.startsWith("P/")).toBe(true);
  });

  test("the sanitized value is ONE line, so an injected newline cannot forge text", () => {
    // The rendered-surface half of this invariant lives in dispatch-diagnostics.test.ts: exactly
    // one `model: ` line, and no line spelled "X".
    const value = formatObservedModel(INJECTED_PROVIDER, INJECTED_MODEL);
    expect(value?.split("\n")).toHaveLength(1);
  });
});
