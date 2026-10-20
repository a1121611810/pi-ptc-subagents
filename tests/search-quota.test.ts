/**
 * The per-session search quota.
 *
 * ## What the counterfactual is
 *
 * The quota's one load-bearing rule is that **a failed call does not count**. DeepSeek charges
 * per successful request (`docs/research/deepseek-search-api-20261020.md` §4.1), so an
 * implementation that counted failures would charge the user twice. Changing the implementation
 * to count a released reservation turns "a released call does not count" red.
 *
 * The second rule is that an **in-flight call holds its slot**: the calls in this package run
 * concurrently (`maxParallelSubCalls`), so a quota that only counted finished calls would let a
 * whole fan-out through the check before any of them completed.
 */
import { describe, expect, test } from "vitest";

import {
  createSearchQuota,
  type SearchQuota,
  type SearchQuotaReservation,
} from "../src/search/quota.ts";

function reserveOrFail(quota: SearchQuota): SearchQuotaReservation {
  const reservation = quota.reserve();
  if (!reservation) throw new Error("expected a reservation, the quota handed out none");
  return reservation;
}

describe("createSearchQuota", () => {
  test("a committed call counts and a released one does not", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 2 });

    reserveOrFail(quota).commit();
    expect(quota.used()).toBe(1);

    reserveOrFail(quota).release();
    // The failed call gave its slot back and left the count alone. Counting the failure here is
    // exactly the mutation this test exists to catch.
    expect(quota.used()).toBe(1);
  });

  test("a released slot can be taken again", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 1 });

    reserveOrFail(quota).release();
    expect(quota.available()).toBe(true);

    reserveOrFail(quota).commit();
    expect(quota.available()).toBe(false);
  });

  test("an in-flight reservation holds its slot against the next call", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 1 });

    reserveOrFail(quota);
    // The first call is still out, so a second one has to wait — that is what keeps a parallel
    // fan-out from spending the whole budget at once.
    expect(quota.available()).toBe(false);
    expect(quota.reserve()).toBeUndefined();
    expect(quota.used()).toBe(0);
  });

  test("the limit is spent once the committed calls reach it", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 2 });

    reserveOrFail(quota).commit();
    reserveOrFail(quota).commit();

    expect(quota.used()).toBe(2);
    expect(quota.available()).toBe(false);
    expect(quota.reserve()).toBeUndefined();
  });

  test("a limit of zero means unlimited", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 0 });

    for (let index = 0; index < 5; index += 1) reserveOrFail(quota).commit();

    expect(quota.available()).toBe(true);
    expect(quota.reserve()).toBeDefined();
    // The count still moves: "unlimited" is about the ceiling, not about the tally.
    expect(quota.used()).toBe(5);
  });

  test("a reservation is single-use", () => {
    const quota = createSearchQuota({ maxCallsPerSession: 2 });

    const reservation = reserveOrFail(quota);
    reservation.commit();
    reservation.commit();
    reservation.release();

    expect(quota.used()).toBe(1);
    expect(quota.available()).toBe(true);
  });

  test("an invalid limit is rejected instead of being replaced by a default", () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createSearchQuota({ maxCallsPerSession: invalid })).toThrow(TypeError);
    }
    expect(() => createSearchQuota({ maxCallsPerSession: "3" as unknown as number })).toThrow(
      TypeError,
    );
  });
});
