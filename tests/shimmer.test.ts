import { describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type ShimmerState, withShimmer } from "../src/tools/shimmer.ts";

function makeTheme(): Theme {
  return {
    fg: (slot: string, text: string) => `[${slot}]${text}[/${slot}]`,
  } as unknown as Theme;
}

function makeFakeInner(lines: string[]): Component {
  return {
    render: (_width: number) => lines,
    invalidate: () => {},
  } as Component;
}

/** The production shape: one state bag per tool call, shared by every render of that call. */
function makeState(): ShimmerState {
  return {};
}

describe("ShimmerDecorator", () => {
  it("band position: bright character at floor(elapsed/intervalMs) % (desc.length + 1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const inner = makeFakeInner(["└─ PTC Verify file integrity"]);
    const wrapped = withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state: makeState(),
    });
    expect(wrapped.render(80)).toEqual([
      "└─ PTC [accent]V[/accent][dim]erify file integrity[/dim]",
    ]);
    vi.setSystemTime(450);
    expect(wrapped.render(80)).toEqual([
      "└─ PTC [dim]Ver[/dim][accent]i[/accent][dim]fy file integrity[/dim]",
    ]);
    vi.useRealTimers();
  });

  it("band survives row recreation: a fresh inner sharing the same state keeps sweeping", () => {
    // pi rebuilds the row on every `updateDisplay()`, and the shimmer interval itself triggers
    // one. Instance state would restart `startedAt` each tick and freeze the band at position 0;
    // the state bag is what carries it across.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = makeState();
    const options = {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state,
    };
    withShimmer(makeFakeInner(["└─ PTC Verify file integrity"]), options);
    expect(state.startedAt).toBe(0);

    vi.setSystemTime(300);
    // A brand-new component, as pi would build: same state bag, so the band continues.
    const rebuilt = withShimmer(makeFakeInner(["└─ PTC Verify file integrity"]), options);
    expect(state.startedAt).toBe(0);
    expect(rebuilt.render(80)).toEqual([
      "└─ PTC [dim]Ve[/dim][accent]r[/accent][dim]ify file integrity[/dim]",
    ]);
    vi.useRealTimers();
  });

  it("the sweep-off frame is all-dim, never all-accent (US2: never looks settled)", () => {
    // `pos % (length + 1)` spends one step with the highlight past the end of the description.
    // That frame must NOT render the description the way a settled row does (all accent), or one
    // frame per sweep would be indistinguishable from a finished run.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const description = "abcd";
    const inner = makeFakeInner([`└─ PTC ${description}`]);
    withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state: makeState(),
    });
    vi.setSystemTime(150 * description.length);
    const offEnd = inner.render(80)[0];
    expect(offEnd).toBe("└─ PTC [dim]abcd[/dim]");

    // …and the settled row really is all-accent, so the two are distinguishable.
    const settledInner = makeFakeInner([`└─ PTC ${description}`]);
    withShimmer(settledInner, {
      intervalMs: 150,
      isPartial: false,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state: makeState(),
    });
    expect(settledInner.render(80)[0]).not.toBe(offEnd);
    vi.useRealTimers();
  });

  it("settle turns the band off: no character is accent-wrapped", () => {
    vi.useFakeTimers();
    const state = makeState();
    const inner = makeFakeInner(["└─ PTC Verify file integrity"]);
    withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state,
    });
    expect(inner.render(80)).toEqual(["└─ PTC [accent]V[/accent][dim]erify file integrity[/dim]"]);
    withShimmer(inner, {
      intervalMs: 150,
      isPartial: false,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state,
    });
    expect(inner.render(80)).toEqual(["└─ PTC Verify file integrity"]);
    expect(state.startedAt).toBeUndefined();
    vi.useRealTimers();
  });

  it("interval lifecycle: repeated partial renders keep one interval, settle clears it", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const state = makeState();
    const options = {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state,
    };
    withShimmer(makeFakeInner(["└─ PTC test"]), options);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    // A re-render while still partial must not schedule a second interval.
    withShimmer(makeFakeInner(["└─ PTC test"]), options);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    withShimmer(makeFakeInner(["└─ PTC test"]), { ...options, isPartial: false });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("interval body calls the supplied requestInvalidate (the production re-render trigger)", () => {
    vi.useFakeTimers();
    const requestInvalidate = vi.fn();
    const state = makeState();
    withShimmer(makeFakeInner(["└─ PTC Verify file integrity"]), {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate,
      state,
    });
    expect(requestInvalidate).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(150);
    expect(requestInvalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(requestInvalidate).toHaveBeenCalledTimes(3);
    // Settling clears the interval; further ticks do not call requestInvalidate.
    withShimmer(makeFakeInner(["└─ PTC Verify file integrity"]), {
      intervalMs: 150,
      isPartial: false,
      theme: makeTheme(),
      requestInvalidate,
      state,
    });
    vi.advanceTimersByTime(600);
    expect(requestInvalidate).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("dispose() clears the interval (hook for a row torn down mid-run)", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const state = makeState();
    const wrapped = withShimmer(makeFakeInner(["└─ PTC test"]), {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state,
    }) as Component & { dispose?: () => void };
    expect(state.interval).toBeDefined();
    wrapped.dispose?.();
    expect(state.interval).toBeUndefined();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    // Idempotent.
    wrapped.dispose?.();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it("matches a 'PTC workflow' label (ADR-0021): band runs over the workflow description", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const inner = makeFakeInner(["└─ PTC workflow Ship the release"]);
    const wrapped = withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state: makeState(),
    });
    expect(wrapped.render(80)).toEqual([
      "└─ PTC workflow [accent]S[/accent][dim]hip the release[/dim]",
    ]);
    vi.useRealTimers();
  });

  it("matches ANSI-wrapped 'PTC' label: strip theme codes before matching, keep them around the prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // A production-shaped call row: bold+PTC wrapped in toolTitle colour, then accent description.
    // The decorator must recognise the "PTC" anchor despite the surrounding ANSI codes, and
    // must keep the prefix's ANSI intact while it rewrites the description's colours.
    const ansiTheme: Theme = {
      fg: (slot: string, text: string) => {
        if (slot === "toolTitle") return `\x1b[34m${text}\x1b[39m`;
        if (slot === "accent") return `\x1b[36m${text}\x1b[39m`;
        if (slot === "dim") return `\x1b[2m${text}\x1b[22m`;
        return text;
      },
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    } as unknown as Theme;
    const line = `└─ \x1b[34m\x1b[1mPTC\x1b[22m\x1b[39m \x1b[36mVerify file integrity\x1b[39m`;
    const inner = makeFakeInner([line]);
    const wrapped = withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: ansiTheme,
      requestInvalidate: () => {},
      state: makeState(),
    });
    const out = wrapped.render(80);
    expect(out).toHaveLength(1);
    // The prefix's ANSI codes are preserved verbatim.
    expect(out[0]?.startsWith("└─ \x1b[34m\x1b[1mPTC\x1b[22m\x1b[39m ")).toBe(true);
    // The description is now dim/accent/dim with the bright character at position 0.
    expect(out[0]).toContain("\x1b[36mV\x1b[39m");
    expect(out[0]).toContain("\x1b[2merify file integrity\x1b[22m");
    vi.useRealTimers();
  });

  it("does not match sub-row lines (US16: shimmer does not extend to sub-call descriptions)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const inner = makeFakeInner(["   ├─ read   running /tmp/foo.ts"]);
    const wrapped = withShimmer(inner, {
      intervalMs: 150,
      isPartial: true,
      theme: makeTheme(),
      requestInvalidate: () => {},
      state: makeState(),
    });
    // No PTC anchor → line is rendered unchanged.
    expect(wrapped.render(80)).toEqual(["   ├─ read   running /tmp/foo.ts"]);
    vi.useRealTimers();
  });
});
