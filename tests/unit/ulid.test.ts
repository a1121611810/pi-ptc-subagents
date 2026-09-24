/**
 * ULID unit tests (WS-ULID / review R-M2).
 *
 * SPECIFICATION tests, not characterization (docs/testing-constraints.md #4/#6): every
 * expectation traces to an independent source — the ULID spec's 26-char Crockford base32
 * alphabet (10 time chars + 16 entropy chars) INCLUDING its canonical example literal for
 * 1469918176385, the ADR-0022 §5 cursor invariant ("monotonic ULID that advances on every
 * event delivered"), or a test-side decoder that uses its own copy of the alphabet.
 *
 * The clock and the entropy source are both injected (constraint #1, IO boundary): tests pass
 * a fake clock and a deterministic `randomBytes`, never a real timer and never the crypto RNG.
 * The regressing-clock case is the failure path for the clock boundary.
 *
 * Counterfactual block (constraint #5): every assertion below goes red for an obviously-wrong
 * implementation — no same-ms increment duplicates ids, no clamp inverts order on a backwards
 * clock, a wrong alphabet breaks the literal membership check, and a drifted time encoder
 * breaks the spec-literal prefix ("01ARYZ6S41") or the test-side decode.
 */

import { describe, expect, test } from "vitest";
import { createULID, createUlidMinter, type ULID } from "../../src/runtime/ulid.ts";

/** ULID spec: 26 Crockford base32 chars; the alphabet omits I, L, O and U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_26 = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Deterministic 10-byte entropy filler: `byte` repeated, so ids are reproducible. */
function fixedRandom(byte: number): (n: number) => Uint8Array {
  return (n: number) => new Uint8Array(n).fill(byte);
}

/**
 * Independently decode the 48-bit ms prefix of a ULID using the literal alphabet above.
 * This is the test-side oracle for the differential test — it is deliberately not the
 * production encoder.
 */
function decodeTimePrefix(id: string): number {
  let value = 0;
  for (const ch of id.slice(0, 10)) {
    value = value * 32 + CROCKFORD.indexOf(ch);
  }
  return value;
}

describe("createULID (default minter)", () => {
  test("emits a 26-character Crockford-base32 id", () => {
    const id = createULID();
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD_26);
    for (const ch of id) {
      expect(CROCKFORD).toContain(ch);
    }
  });

  test("the alphabet never contains the ambiguous letters I, L, O or U", () => {
    // ULID spec §"Crockford's Base32": I/L/O/U are excluded to avoid transcription errors.
    expect(CROCKFORD).toHaveLength(32);
    expect(CROCKFORD).not.toMatch(/[ILOU]/);
  });

  test("ids minted in the same millisecond are distinct and lexically increasing", () => {
    // 200 calls normally land in one millisecond; the per-ms increment (not a fresh random
    // tail) is what keeps them distinct and sorted. A no-op increment duplicates them.
    const ids = Array.from({ length: 200 }, () => createULID());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("createUlidMinter (injected clock + entropy)", () => {
  test("emits 26-char Crockford ids from the injected clock and entropy", () => {
    const minter = createUlidMinter({
      now: () => 1_700_000_000_000,
      randomBytes: fixedRandom(0xff),
    });
    const id: ULID = minter.next();
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD_26);
    for (const ch of id) {
      expect(CROCKFORD).toContain(ch);
    }
  });

  test("same-millisecond ids are distinct and strictly increasing (per-ms increment)", () => {
    const minter = createUlidMinter({ now: () => 1_000_000, randomBytes: fixedRandom(0) });
    const ids = Array.from({ length: 200 }, () => minter.next());
    expect(new Set(ids).size).toBe(200);
    expect(ids).toEqual([...ids].sort());
  });

  test("lexical order equals creation order across identical and advancing milliseconds", () => {
    const times = [1_000_000, 1_000_000, 1_001_000, 1_001_000, 1_001_000, 1_002_000];
    let cursor = 0;
    const minter = createUlidMinter({
      now: () => times[cursor] ?? 1_002_000,
      randomBytes: fixedRandom(7),
    });
    const ids: string[] = [];
    for (let k = 0; k < times.length; k++) {
      ids.push(minter.next());
      cursor += 1;
    }
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a regressing clock is clamped: the time prefix never goes backwards", () => {
    // Failure path for the clock boundary (constraint #1): NTP steps the clock back.
    let now = 5_000_000;
    const minter = createUlidMinter({ now: () => now, randomBytes: fixedRandom(0) });
    const first = minter.next();
    now = 4_000_000;
    const second = minter.next();
    // The clamp holds the high-water time, so the prefix is unchanged...
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
    // ...and the sequence increment still makes the id strictly larger.
    expect(second > first).toBe(true);
  });

  test("the time prefix is the spec's Crockford encoding of the injected instant", () => {
    // Two INDEPENDENT oracles, neither read out of the implementation (constraint #4):
    //   1. the test-side decoder below recovers the injected millisecond, and
    //   2. the ULID spec's canonical example: 1469918176385 encodes to the literal
    //      "01ARYZ6S41" (10 chars x 5 bits of base32). The full id below is that prefix
    //      followed by the zero entropy this test injects.
    const minter = createUlidMinter({
      now: () => 1_469_918_176_385,
      randomBytes: fixedRandom(0),
    });
    const id = minter.next();
    expect(decodeTimePrefix(id)).toBe(1_469_918_176_385);
    expect(id).toBe("01ARYZ6S410000000000000000");
    // Counterfactual: a drifted time encoder, a shifted alphabet or a wrong width breaks the
    // literal above (or the decode), not merely a round-trip through the same encoder.
  });

  test("the default seam mints a decodable 26-char id from the shared encoder", () => {
    // createULID() reads the real clock, so its instant cannot be pinned; what IS pinned is
    // that its prefix decodes through the test-side oracle and its shape matches the spec.
    const id = createULID();
    expect(id).toMatch(CROCKFORD_26);
    expect(decodeTimePrefix(id)).toBeGreaterThan(1_400_000_000_000);
  });

  test("the same now + entropy sequence yields identical ids (deterministic seam)", () => {
    const make = (): ULID =>
      createUlidMinter({ now: () => 1_700_000_000_000, randomBytes: fixedRandom(3) }).next();
    expect(make()).toBe(make());
  });
});
