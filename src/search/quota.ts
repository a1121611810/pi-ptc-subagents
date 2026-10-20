/**
 * The per-session quota for the built-in search module.
 *
 * ## What the quota counts, and what it does not
 *
 * **Only successful calls.** DeepSeek bills the Search and Fetch endpoints per *successful*
 * request — a request that fails, times out or returns nothing is not charged
 * (`docs/research/deepseek-search-api-20261020.md` §4.1). A local quota that counted failures
 * would therefore charge the user twice: once at DeepSeek's counter, once here. A failed call
 * must give its slot back.
 *
 * ## Why the slot is reserved before the call, not counted after it
 *
 * The calls in this package are concurrent — a PTC program can fan out to
 * `maxParallelSubCalls` at once (`src/runtime/limits.ts:53`). A quota that only counted
 * *completed* calls would let every parallel call pass the check before any of them finished, and
 * the session would spend N times its budget. So a call **reserves** a slot before it goes out,
 * and the slot becomes a counted success only when the call commits. Three states, and the
 * middle one is what makes the limit hold under concurrency:
 *
 *   reserve()  → the slot is held; `used()` does not move yet
 *   commit()   → the call succeeded; `used()` moves
 *   release()  → the call failed; the slot goes back and `used()` never moved
 *
 * ## Why an invalid limit throws
 *
 * A negative or fractional limit is a caller bug, and it is handled the way `resolveConfig`
 * handles an invalid config override (`src/runtime/limits.ts:177-188`): the override is rejected
 * rather than silently replaced by a default, because a default would hide the bug behind a
 * number that looks deliberate.
 */
export interface SearchQuotaOptions {
  /** How many successful calls one session may make. `0` means unlimited. */
  maxCallsPerSession: number;
}

export interface SearchQuotaReservation {
  /** Record this call as a success. */
  commit(): void;
  /** Give the slot back: this call failed, so it must not count. */
  release(): void;
}

export interface SearchQuota {
  /** Whether one more call may be started. */
  available(): boolean;
  /** How many successful calls have been counted. */
  used(): number;
  /** Take a slot; `undefined` when the quota is spent. */
  reserve(): SearchQuotaReservation | undefined;
}

/**
 * Build a quota.
 *
 * **The reservation is single-use.** Calling `commit()` twice counts one success, and calling
 * `release()` after a `commit()` (or the other way round) does not move the counters again.
 * Silently ignoring the second call is deliberate: a double commit would otherwise inflate the
 * count past the limit, and throwing would turn a bookkeeping mistake into a failed search.
 */
export function createSearchQuota(options: SearchQuotaOptions): SearchQuota {
  const max = options.maxCallsPerSession;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
    throw new TypeError(`invalid search quota limit: ${String(max)}`);
  }
  const unlimited = max === 0;
  let used = 0;
  let reserved = 0;

  return {
    available: () => unlimited || used + reserved < max,
    used: () => used,
    reserve: () => {
      if (!unlimited && used + reserved >= max) return undefined;
      reserved += 1;
      let settled = false;
      return {
        commit: () => {
          if (settled) return;
          settled = true;
          reserved -= 1;
          used += 1;
        },
        release: () => {
          if (settled) return;
          settled = true;
          reserved -= 1;
        },
      };
    },
  };
}
