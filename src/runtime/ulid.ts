/**
 * ULID: the single source of truth for lexically-sortable identifiers (WS-ULID / review R-M2).
 *
 * Before this module there were two independent implementations that had to not drift:
 * the module-global `createULID()` in `child-process-lifecycle.ts` (Date.now + crypto
 * randomness, increment-on-same-ms) and the registry-private encoder in `task-registry.ts`
 * (injected clock + bigint sequence). They had two incompatible `ULID` types and were joined
 * by an `as ULID` cast in `dispatch.ts`. This module owns the alphabet, the time encoder, the
 * default minter and the instance minter; nothing else may define them.
 *
 * Shape (ULID spec): 26 chars of Crockford base32, `TTTTTTTTTTRRRRRRRRRRRRRRRR` — 10 chars
 * (48 bits) of ms-epoch followed by 16 chars (80 bits) of entropy. The alphabet omits I, L, O
 * and U; its order means lexical sort equals creation order. Entropy comes from
 * `crypto.randomBytes` (never `Math.random()`), so two ids minted in the same millisecond are
 * distinct, and a per-ms increment makes them strictly increasing.
 *
 * `createUlidMinter` keeps its monotonic state (`lastTime`, the 80-bit entropy sequence)
 * **per instance**, so the `TaskRegistry` can mint ids from its injected clock without sharing
 * module-global state with the default minter. Both callers get the same algorithm — the
 * differential test in `tests/unit/ulid.test.ts` is what keeps them from drifting apart again.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * Lexically-sortable identifier (26-char Crockford base32). Brand-only: the runtime value is a
 * plain `string`, the brand is a compile-time distinction that keeps a taskId from being
 * passed into a cursor slot.
 */
export type ULID = string & { readonly __brand: "ULID" };

/** Crockford base32 alphabet (ULID spec) - deliberately omits I, L, O, U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a 48-bit ms timestamp as 10 Crockford chars (most-significant first). */
function encodeTime(ms: number): string {
  let out = "";
  let v = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[v % 32] ?? "0") + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** Encode 80 bits of entropy as 16 Crockford chars (5 bits per char). */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length && out.length < 16; i++) {
    acc = (acc << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
  }
  return out.padEnd(16, "0");
}

/** Increment an 80-bit big-endian byte tail by one (wraps at 2^80, never in practice). */
function incrementRandom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if ((out[i] ?? 0) < 0xff) {
      out[i] = (out[i] ?? 0) + 1;
      return out;
    }
    out[i] = 0;
  }
  return out;
}

/** Dependencies for {@link createUlidMinter}. Both are injectable for deterministic tests. */
export interface UlidMinterOptions {
  /** The time source, in ms epoch. The registry passes its injected clock. */
  now: () => number;
  /** 80-bit entropy source; defaults to `crypto.randomBytes`. */
  randomBytes?: (n: number) => Uint8Array;
}

/** An instance minter with its own monotonic state. See {@link createUlidMinter}. */
export interface UlidMinter {
  /** Mint the next strictly-increasing id. */
  next(): ULID;
}

/**
 * Build a minter whose monotonic state (`lastTime` + 80-bit entropy sequence) is private to the
 * instance. The time component is clamped to the high-water mark so a regressing clock cannot
 * invert order; within one millisecond the entropy tail is incremented, so two ids minted at
 * the same `now()` still compare in emission order. When the clock advances, fresh entropy is
 * drawn so ids are not predictable from their predecessors.
 */
export function createUlidMinter(options: UlidMinterOptions): UlidMinter {
  const random =
    options.randomBytes ?? ((n: number): Uint8Array => new Uint8Array(nodeRandomBytes(n)));
  let lastTime = -1;
  let sequence: Uint8Array = new Uint8Array(10);
  return {
    next(): ULID {
      const requested = Math.max(0, Math.floor(options.now()));
      // Never let a backwards clock step (NTP) break the lexical-ordering invariant.
      const time = requested > lastTime ? requested : lastTime;
      const bytes = time === lastTime ? incrementRandom(sequence) : random(10);
      lastTime = time;
      sequence = bytes;
      return (encodeTime(time) + encodeRandom(bytes)) as ULID;
    },
  };
}

/** The process-wide default minter; `createULID` delegates here so global monotonicity holds. */
const DEFAULT_ULID_MINTER = createUlidMinter({ now: () => Date.now() });

/** Generate a fresh `ULID` from `Date.now()` + crypto randomness. Monotonic within a ms. */
export function createULID(): ULID {
  return DEFAULT_ULID_MINTER.next();
}
