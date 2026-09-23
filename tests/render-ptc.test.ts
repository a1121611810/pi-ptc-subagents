/**
 * Unit tests for the shared TUI renderer (`src/tools/render.ts`).
 *
 * The renderer produces a `PtcRow` component; we don't compare against ANSI-colored strings (theme
 * colors are opaque constants) but we do check:
 *  - the visible text content after `render(width)` (width-aware: the meta is pinned to the right)
 *  - which theme color tags the renderer asks for (a recording stub)
 *
 * The contract these tests pin down is ADR-0013: a collapsed PTC row never prints an escaped JSON
 * payload. The shape (tree-connector layout) is documented in `render.ts`; the tests below pin the
 * call row's `└─ ` root, the result row's `   ` continuation under it, and the `├─` / `│` / `└─`
 * connectors used in the expanded view. §5 of the ADR adds: container values expand as trees.
 */
import { describe, expect, test, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  firstMeaningfulCodeLine,
  isExpandableContainer,
  renderPtcToolCall,
  renderPtcToolResultCollapsed,
  renderPtcToolResultExpanded,
  renderValueTree,
  createPtcRenderers,
} from "../src/tools/render.ts";
import { MAX_SUBCALLS } from "../src/tools/common.ts";
import type { PtcToolDetails } from "../src/tools/common.ts";
import type { SubCallRecord } from "../src/runtime/protocol.ts";

/** Recording theme stub: returns the input text but records which color tag was used. */
function makeTheme(): Theme {
  const calls: string[] = [];
  const wrap =
    (tag: string) =>
    (_color: string, text: string): string => {
      calls.push(tag);
      return text;
    };
  return {
    fg: vi.fn(wrap("fg")) as unknown as Theme["fg"],
    bg: vi.fn(wrap("bg")) as unknown as Theme["bg"],
    bold: vi.fn((s) => `*${s}*`) as unknown as Theme["bold"],
    italic: vi.fn((s) => `_${s}_`) as unknown as Theme["italic"],
    underline: vi.fn((s) => `__${s}__`) as unknown as Theme["underline"],
    inverse: vi.fn((s) => s) as unknown as Theme["inverse"],
    strikethrough: vi.fn((s) => s) as unknown as Theme["strikethrough"],
    getFgAnsi: vi.fn(() => "") as unknown as Theme["getFgAnsi"],
    getBgAnsi: vi.fn(() => "") as unknown as Theme["getBgAnsi"],
    getColorMode: vi.fn(() => "truecolor") as unknown as Theme["getColorMode"],
    getThinkingBorderColor: vi.fn(
      () => (s: string) => s,
    ) as unknown as Theme["getThinkingBorderColor"],
    getBashModeBorderColor: vi.fn(
      () => (s: string) => s,
    ) as unknown as Theme["getBashModeBorderColor"],
  } as Theme;
}

/** Extract which fg color tags were passed to `theme.fg(...)` during one render. */
function fgTagsUsed(theme: Theme): string[] {
  return (theme.fg as unknown as { mock: { calls: string[][] } }).mock.calls.map(
    (c) => c[0] as string,
  );
}

/** Like `makeBracketedTheme` but emits real ANSI escape sequences — needed by the shimmer
 * decorator's `stripAnsi` so the band-position regex can locate the description after the
 * label/theme wrappers are removed. */
function makeAnsiTheme(): Theme {
  const wrap =
    (code: string, close = "") =>
    (text: string): string =>
      `\x1b[${code}m${text}\x1b[${close}m`;
  return {
    fg: (slot: string, text: string) => {
      if (slot === "toolTitle") return `\x1b[34m${text}\x1b[39m`;
      if (slot === "accent") return `\x1b[36m${text}\x1b[39m`;
      if (slot === "dim") return `\x1b[2m${text}\x1b[22m`;
      if (slot === "muted") return `\x1b[2m${text}\x1b[22m`;
      if (slot === "error") return `\x1b[31m${text}\x1b[39m`;
      if (slot === "warning") return `\x1b[33m${text}\x1b[39m`;
      return text;
    },
    bg: wrap("44", "49"),
    bold: wrap("1", "22"),
    italic: wrap("3", "23"),
    underline: wrap("4", "24"),
    inverse: wrap("7", "27"),
    strikethrough: wrap("9", "29"),
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

interface Renderable {
  render(width: number): string[];
}

/** The rendered lines of a component, trailing padding dropped. */
function lines(component: Renderable, width = 200): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

function visible(component: Renderable, width = 200): string {
  return lines(component, width).join("\n");
}

/** `\\n` written as two characters — the escape this renderer must never emit. */
const ESCAPED_NEWLINE = String.fromCharCode(92) + "n";

function makeDetails(overrides: Partial<PtcToolDetails> = {}): PtcToolDetails {
  return {
    surface: "run_code",
    logs: [],
    narrations: [],
    phases: [],
    warnings: [],
    durationMs: 123,
    imageCount: 0,
    ...overrides,
  };
}

describe("firstMeaningfulCodeLine", () => {
  test("skips leading comments and blank lines, strips trailing inline comment", () => {
    expect(
      firstMeaningfulCodeLine(`// greeting\n\n/* block */\nconst x = 1; // tail\nreturn x;`),
    ).toBe("const x = 1;");
  });

  test("truncates long lines", () => {
    const long = `const x = ${"a".repeat(200)};`;
    const out = firstMeaningfulCodeLine(long);
    expect(out?.length).toBeLessThanOrEqual(120);
    expect(out?.endsWith("…")).toBe(true);
  });

  test("returns undefined when only comments / blanks are present", () => {
    expect(firstMeaningfulCodeLine("// nothing\n\n")).toBeUndefined();
  });
});

describe("isExpandableContainer", () => {
  test("recognises non-empty objects and arrays", () => {
    expect(isExpandableContainer({ a: 1 })).toBe(true);
    expect(isExpandableContainer([1, 2])).toBe(true);
  });
  test("rejects scalars, null, and empty containers", () => {
    expect(isExpandableContainer(null)).toBe(false);
    expect(isExpandableContainer(0)).toBe(false);
    expect(isExpandableContainer("")).toBe(false);
    expect(isExpandableContainer({})).toBe(false);
    expect(isExpandableContainer([])).toBe(false);
  });
});

describe("renderValueTree", () => {
  test("object with all-scalar values renders one row per property, key:value", () => {
    const rows = renderValueTree(
      { file: "x.ts", instantiations: [{ a: 1 }], totalLines: 47 },
      { maxChildren: 6 },
    );
    // Children that are objects: all-scalar nested arrays collapse to a single inline `{...}` row.
    // Root: 3 properties, all keys are bare.
    expect(rows[0]).toBe('├─ file: "x.ts"');
    // instantiations is an array of objects → not inline-eligible, gets a header.
    expect(rows).toContain("├─ instantiations: Array(1)");
    expect(rows[rows.length - 1]).toBe("└─ totalLines: 47");
  });

  test("array of objects recurses with [i] indices", () => {
    const rows = renderValueTree(
      [
        { file: "a", line: 12 },
        { file: "b", line: 47 },
      ],
      { maxChildren: 6 },
    );
    // Each item is an all-scalar object → inline `{file: ..., line: ...}`.
    expect(rows).toContain('├─ [0] {file: "a", line: 12}');
    expect(rows).toContain('└─ [1] {file: "b", line: 47}');
  });

  test("nested containers keep their own continuation bar", () => {
    const rows = renderValueTree({
      root: { inner: [{ deep: 1 }] },
    });
    // Expect the chain of ├── └── │ throughout; spot-check key indents.
    expect(rows).toEqual(["└─ root: {1 keys}", "   └─ inner: Array(1)", "      └─ [0] {deep: 1}"]);
  });

  test("maxChildren caps children with a +N more tail", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) big[`k${i}`] = i;
    const rows = renderValueTree(big, { maxChildren: 4, maxLineChars: 200 });
    // Limit 4 → 4 child rows + a tail.
    expect(rows.length).toBe(5);
    expect(rows[rows.length - 1]).toBe("└─ …+16 more keys");
  });

  test("arrays overflow with a +N more items tail", () => {
    const rows = renderValueTree([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
      maxChildren: 4,
      maxLineChars: 200,
    });
    expect(rows[rows.length - 1]).toBe("└─ …+6 more items");
  });

  test("maxDepth collapses deep nesting to a single … row", () => {
    const rows = renderValueTree({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2, maxChildren: 6 });
    expect(rows.some((r) => r.includes("…") && !r.includes("more"))).toBe(true);
    expect(rows.some((r) => r.endsWith("└─ a: {1 keys}"))).toBe(true);
  });

  test("long strings truncate with a trailing ellipsis, preserving the tree-prefix", () => {
    const rows = renderValueTree({ file: "x".repeat(200) }, { maxLineChars: 30, maxChildren: 6 });
    expect(rows[0]?.startsWith("└─ file: ")).toBe(true);
    expect(rows[0]?.endsWith("…")).toBe(true);
    expect(visibleWidth(rows[0] ?? "")).toBeLessThanOrEqual(30);
  });

  test("scalar values return a one-row preview", () => {
    expect(renderValueTree(47)).toEqual(["47"]);
    expect(renderValueTree("hello")).toEqual(['"hello"']);
    expect(renderValueTree(null)).toEqual(["null"]);
  });

  test("non-identifier keys are JSON-quoted", () => {
    const rows = renderValueTree({ "two words": 1 }, { maxChildren: 6 });
    expect(rows).toContain('└─ "two words": 1');
  });

  test("empty containers return one row", () => {
    expect(renderValueTree({})).toEqual(["{}"]);
    expect(renderValueTree([])).toEqual(["[]"]);
  });

  test("all-scalar array renders inline when it fits", () => {
    const rows = renderValueTree([1, 2, 3], { maxLineChars: 200, maxChildren: 6 });
    expect(rows).toContain("├─ [0] 1");
    expect(rows).toContain("├─ [1] 2");
    expect(rows).toContain("└─ [2] 3");
  });

  test("moreAfter keeps the last row's connector open for following siblings", () => {
    // The expanded view renders a value tree and then labelled blocks. One connector chain means
    // the tree's last row must stay `├─` while blocks follow, and `└─` when nothing follows.
    const closed = renderValueTree({ a: 1, b: 2 });
    const open = renderValueTree({ a: 1, b: 2 }, { moreAfter: true });
    expect(closed[closed.length - 1]).toBe("└─ b: 2");
    expect(open[open.length - 1]).toBe("├─ b: 2");
  });

  test("moreAfter also opens the tail row when children were withheld", () => {
    const big = { a: 1, b: 2, c: 3, d: 4 };
    const closed = renderValueTree(big, { maxChildren: 2 });
    const open = renderValueTree(big, { maxChildren: 2, moreAfter: true });
    expect(closed[closed.length - 1]).toBe("└─ …+2 more keys");
    expect(open[open.length - 1]).toBe("├─ …+2 more keys");
  });
});

describe("renderPtcToolCall", () => {
  test("tree root + tool label + description, no code preview", () => {
    const theme = makeTheme();
    const out = visible(
      renderPtcToolCall(
        {
          description: "Read package.json and parse version",
          code: "const pkg = await tools.read({ path: '/x' });",
        },
        theme,
      ),
    );
    // The call row owns column 0–2 with `└─ `; the label and description follow on the same line.
    expect(out).toBe("└─ *PTC* Read package.json and parse version");
    expect(out).not.toContain("tools.read");
  });

  test("workflow surface gets its own label", () => {
    const theme = makeTheme();
    const out = visible(
      renderPtcToolCall(
        { description: "Ship the release", meta: { name: "release" } },
        theme,
        "workflow",
      ),
    );
    expect(out).toBe("└─ *PTC workflow* Ship the release");
  });

  test("falls back to meta.name, then to the first meaningful code line", () => {
    const theme = makeTheme();
    expect(visible(renderPtcToolCall({ meta: { name: "validate-config" } }, theme))).toBe(
      "└─ *PTC* validate-config",
    );
    expect(visible(renderPtcToolCall({ script: "// header\nreturn 1;" }, theme))).toBe(
      "└─ *PTC* return 1;",
    );
    expect(visible(renderPtcToolCall({ code: "// only a comment" }, theme))).toBe(
      "└─ *PTC* (no description)",
    );
  });

  test("truncates to the viewport instead of wrapping", () => {
    const theme = makeTheme();
    const out = lines(renderPtcToolCall({ description: "x".repeat(120) }, theme), 40);
    expect(out).toHaveLength(1);
    expect(visibleWidth(out[0] ?? "")).toBeLessThanOrEqual(40);
    expect(out[0]).toContain("…");
  });

  test("uses bold + toolTitle for the label", () => {
    const theme = makeTheme();
    renderPtcToolCall({ description: "x", code: "return 1;" }, theme);
    expect(fgTagsUsed(theme)).toContain("toolTitle");
  });

  test("partial call row shimmers: bright band advances on the 150ms cadence (ADR-0020)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const theme = makeAnsiTheme();
    const row = renderPtcToolCall({ description: "Verify file integrity" }, theme, "run_code", {
      isPartial: true,
      state: {},
      requestInvalidate: () => {},
    });
    const outAt0 = row.render(80);
    expect(outAt0).toHaveLength(1);
    // The label and prefix's ANSI wrappers are preserved verbatim…
    expect(outAt0[0]?.startsWith("└─ \x1b[34m\x1b[1mPTC\x1b[22m\x1b[39m ")).toBe(true);
    // …and the description is dim/accent/dim with the bright character at position 0.
    expect(outAt0[0]).toContain("\x1b[36mV\x1b[39m");
    expect(outAt0[0]).toContain("\x1b[2merify file integrity\x1b[22m");
    vi.setSystemTime(300);
    const outAt300 = row.render(80);
    expect(outAt300[0]).toContain("\x1b[2mVe\x1b[22m");
    expect(outAt300[0]).toContain("\x1b[36mr\x1b[39m");
    expect(outAt300[0]).toContain("\x1b[2mify file integrity\x1b[22m");
    vi.useRealTimers();
  });

  test("settled call row does not shimmer (isPartial: false)", () => {
    // The settle path: pi flips `isPartial` to false, the decorator drops `startedAt`, and the
    // row renders exactly as ADR-0013's settled row does.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const theme = makeAnsiTheme();
    const row = renderPtcToolCall({ description: "Verify file integrity" }, theme, "run_code", {
      isPartial: false,
      state: {},
      requestInvalidate: () => {},
    });
    const out = row.render(80);
    expect(out).toHaveLength(1);
    // No band: the description keeps its plain accent wrapper.
    expect(out[0]).toContain("\x1b[36mVerify file integrity\x1b[39m");
    expect(out[0]).not.toContain("\x1b[2m");
    vi.useRealTimers();
  });

  test("band survives the row recreation pi performs on every render (state bag carries startedAt)", () => {
    // pi rebuilds the row on every `updateDisplay()`, and the interval itself triggers one via
    // `requestInvalidate`. Component-instance state would restart `startedAt` each rebuild and
    // freeze the band at position 0; `context.state` is what carries it.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const theme = makeAnsiTheme();
    const state = {};
    const options = { isPartial: true, state, requestInvalidate: () => {} };
    renderPtcToolCall({ description: "Verify file integrity" }, theme, "run_code", options);

    vi.setSystemTime(450);
    const rebuilt = renderPtcToolCall(
      { description: "Verify file integrity" },
      theme,
      "run_code",
      options,
    );
    expect(rebuilt.render(80)[0]).toContain("\x1b[36mi\x1b[39m");
    vi.useRealTimers();
  });

  test("call row invokes requestInvalidate on the 150ms cadence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestInvalidate = vi.fn();
    const theme = makeAnsiTheme();
    renderPtcToolCall({ description: "Verify file integrity" }, theme, "run_code", {
      isPartial: true,
      state: {},
      requestInvalidate,
    });
    expect(requestInvalidate).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(450);
    expect(requestInvalidate).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  test("repeated partial renders keep exactly one interval (no leak across rebuilds)", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const theme = makeAnsiTheme();
    const state = {};
    const options = { isPartial: true, state, requestInvalidate: () => {} };
    for (let i = 0; i < 5; i += 1) {
      renderPtcToolCall({ description: "Verify file integrity" }, theme, "run_code", options);
    }
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });
});

describe("renderPtcToolResultCollapsed", () => {
  test("scalar result: one-line summary, meta pinned to right", () => {
    const theme = makeTheme();
    const out = lines(
      renderPtcToolResultCollapsed(
        { details: makeDetails({ result: "hello", logs: ["a"] }) },
        false,
        theme,
      ),
      80,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("   → hello");
    expect(out[0]).toContain("1 output line");
    expect(visibleWidth(out[0] ?? "")).toBe(80);
    expect(out[0]?.endsWith("123ms")).toBe(true);
  });

  test("container result: tree rows, meta on first row only", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({
        result: { file: "x.ts", totalLines: 47 },
        logs: ["a"],
      }),
    };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 80);
    // Two property rows.
    expect(out.length).toBe(2);
    expect(out[0]).toContain('├─ file: "x.ts"');
    expect(out[0]).toContain("1 output line");
    expect(out[1]).toBe("   └─ totalLines: 47");
    // Meta on first row only — second row has no right meta.
    expect(out[0]?.endsWith("123ms")).toBe(true);
    expect(out[1]?.endsWith("123ms")).toBe(false);
  });

  test("multi-line string scalar result collapses to its first line — never an escaped payload", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({ result: "line one\nline two\nline three", durationMs: 412 }),
    };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("→ line one (+2 lines)");
    expect(out[0]).not.toContain(ESCAPED_NEWLINE);
  });

  test("large object result renders as a tree, never a JSON-escaped payload", () => {
    const theme = makeTheme();
    const big: Record<string, string> = {};
    for (const key of ["file", "clipNow", "extra", "more", "evenMore"]) big[key] = "x".repeat(80);
    const out = lines(
      renderPtcToolResultCollapsed({ details: makeDetails({ result: big }) }, false, theme),
      120,
    );
    // Five properties → 5 tree rows in default budget.
    expect(out).toHaveLength(5);
    // One row per key, never a JSON-escaped payload.
    for (const key of Object.keys(big)) {
      expect(out.some((row) => row.includes(`${key}: "`))).toBe(true);
    }
    expect(out.join(String.fromCharCode(10))).not.toContain(ESCAPED_NEWLINE);
  });

  test("no completion value: 'done'", () => {
    const theme = makeTheme();
    const out = visible(renderPtcToolResultCollapsed({ details: makeDetails() }, false, theme));
    expect(out).toContain("done");
  });

  test("failure: reason on the left in the error color, with the tree-indent", () => {
    const theme = makeTheme();
    const result = {
      content: [{ type: "text", text: "code run failed (exception): boom\nCaptured output:\n..." }],
      details: makeDetails(),
    };
    const out = visible(renderPtcToolResultCollapsed(result, true, theme));
    expect(out).toContain("failed: code run failed (exception): boom");
    expect(out).toContain("123ms");
    expect(fgTagsUsed(theme)).toContain("error");
  });

  test("failure without details still names the error", () => {
    const theme = makeTheme();
    const out = visible(
      renderPtcToolResultCollapsed({ content: [{ type: "text", text: "boom" }] }, true, theme),
    );
    expect(out).toContain("failed: boom");
  });

  test("workflow: logs, phases and warnings share the meta segment", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({
        surface: "workflow",
        narrations: ["log line A"],
        phases: ["init", "compute", "report"],
        warnings: ['phase "extra" is not listed in meta.phases'],
        durationMs: 1500,
      }),
    };
    const out = visible(renderPtcToolResultCollapsed(result, false, theme));
    expect(out).toContain("1 output line · 3 phases · 1 warning");
    expect(out).toContain("1.5s");
    expect(fgTagsUsed(theme)).toContain("warning");
  });

  test("narrow viewport keeps the meta and stays on one line for scalar values", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({
        result: "y".repeat(200),
        logs: Array.from({ length: 12 }, (_, i) => `${i}`),
      }),
    };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 30);
    expect(out).toHaveLength(1);
    expect(visibleWidth(out[0] ?? "")).toBeLessThanOrEqual(30);
    expect(out[0]).toContain("12 output lines");
  });
});

describe("renderPtcToolResultExpanded", () => {
  const codeArgs = {
    description: "Ship the release",
    code: "// preamble\nconst pkg = await tools.read({ path: 'x' });\nconst y = 2;\nreturn pkg;",
  };

  test("scalar result: summary line then tree children (code, phases, log, out, warn) — no value block", () => {
    const theme = makeTheme();
    const result = {
      content: [{ type: "text", text: "Phases: init → compute" }],
      details: makeDetails({
        surface: "workflow",
        narrations: ["log line A"],
        logs: ["[ptc] out 1"],
        phases: ["init", "compute"],
        warnings: ['phase "extra" is not listed in meta.phases'],
        result: 42,
        durationMs: 1500,
      }),
    };
    const out = visible(renderPtcToolResultExpanded(result, codeArgs, false, theme));
    // Scalar value → summary line.
    expect(out).toContain("   → 42");
    // Child blocks still present, with their connectors, but no "value" label.
    expect(out).toContain("├─ phases  init → compute");
    expect(out).toContain("├─ log     log line A");
    expect(out).toContain("├─ out     [ptc] out 1");
    expect(out).toContain('└─ warn    phase "extra" is not listed');
    // Description lives on the call row, not duplicated here.
    expect(out).not.toContain("Ship the release");
    // No more "value" child block.
    expect(out).not.toContain("├─ value");
    expect(out).not.toContain("└─ value");
  });

  test("container result: tree rows replace the summary line, child blocks follow", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({
        result: {
          version: "0.1.0",
          install: { npm: "pi-ptc-subagents", depth: 0 },
        },
        logs: ["[ptc] out 1"],
        durationMs: 536,
      }),
    };
    const out = visible(renderPtcToolResultExpanded(result, { code: "return 1;" }, false, theme));
    // No single-line → preview.
    expect(out).not.toMatch(/^   →/m);
    // Tree rows for the value, with a children block in between.
    expect(out).toContain('├─ version: "0.1.0"');
    expect(out).toContain('├─ install: {npm: "pi-ptc-subagents", depth: 0}');
    // Other child blocks follow.
    expect(out).toContain("└─ out     [ptc] out 1");
  });

  test("failure: the full error text is surfaced in the error color, with the tree-indent", () => {
    const theme = makeTheme();
    const result = {
      content: [
        {
          type: "text",
          text: "code run failed (timeout): exceeded 120 s\nCaptured output:\n[log] a",
        },
      ],
      details: makeDetails({ logs: ["[log] a"] }),
    };
    const out = visible(renderPtcToolResultExpanded(result, codeArgs, true, theme));
    expect(out).toContain("failed: code run failed (timeout): exceeded 120 s");
    expect(out).toContain("Captured output:");
    expect(fgTagsUsed(theme)).toContain("error");
  });

  test("a truncated text block says so in the meta (ADR-0015)", () => {
    const theme = makeTheme();
    const out = visible(
      renderPtcToolResultCollapsed(
        { details: makeDetails({ fullOutputPath: "/tmp/pi-ptc-output-1.txt" }) },
        false,
        theme,
      ),
    );
    expect(out).toContain("truncated");
    expect(fgTagsUsed(theme)).toContain("warning");
  });

  test("hoisted images ride the meta and get their own child block (ADR-0014)", () => {
    const theme = makeTheme();
    // Collapsed: image count goes into the meta segment.
    const collapsed = visible(
      renderPtcToolResultCollapsed({ details: makeDetails({ imageCount: 2 }) }, false, theme),
    );
    expect(collapsed).toContain("2 images");
    expect(fgTagsUsed(theme)).toContain("toolOutput");
    // Expanded: an image child block at the end.
    const expanded = visible(
      renderPtcToolResultExpanded({ details: makeDetails({ imageCount: 2 }) }, {}, false, theme),
    );
    expect(expanded).toContain("└─ image");
    expect(expanded).toContain("2 images attached");
  });

  test("caps long blocks and says how much it withheld", () => {
    const theme = makeTheme();
    const logs = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = { details: makeDetails({ logs, durationMs: 10 }) };
    const out = visible(renderPtcToolResultExpanded(result, {}, false, theme));
    expect(out).toContain("line 11");
    expect(out).not.toContain("line 12");
    expect(out).toContain("…+8 more lines");
  });

  test("child blocks keep their own ├─ / └─ connectors based on position in the children list", () => {
    const theme = makeTheme();
    // Two non-value children: code, out. Out is last → └─.
    const result = {
      details: makeDetails({
        logs: ["a", "b"],
        result: 7,
      }),
    };
    const args = { description: "d", code: "return 1;" };
    const outLines = visible(renderPtcToolResultExpanded(result, args, false, theme)).split("\n");
    const codeLine = outLines.find((l) => l.startsWith("   ├─ code") || l.startsWith("   └─ code"));
    const outLine = outLines.find((l) => l.startsWith("   ├─ out") || l.startsWith("   └─ out"));
    expect(codeLine).toMatch(/^   ├─ code/);
    expect(outLine).toMatch(/^   └─ out/);
    // Continuation lines under ├─ children use `│          `; under └─ they use spaces.
    const continuations = outLines.filter((l) => /^[│ ]+\s{8}/.test(l));
    expect(continuations.length).toBeGreaterThan(0);
  });
});

describe("MAX_SUBCALLS (ADR-0021 §5)", () => {
  test("is exported from common.ts with the ADR-pinned value 32", () => {
    expect(typeof MAX_SUBCALLS).toBe("number");
    expect(MAX_SUBCALLS).toBe(32);
  });
});

describe("error-result shape from pi (a thrown tool)", () => {
  test("a bare `details: {}` renders the failure line instead of throwing", () => {
    // pi builds `details: {}` for a throwing tool (`pi-agent-core` agent-loop). The renderer
    // indexes `details.logs` / `narrations` / `phases` / `warnings` directly, so a missing field
    // used to throw a second time inside the renderer, dropping ADR-0013's formatted failure row
    // and falling back to pi's raw-text path.
    const result = { content: [{ type: "text", text: "code run failed (exception): boom" }] };
    const collapsed = renderPtcToolResultCollapsed({ ...result, details: {} }, true, makeTheme());
    expect(collapsed.render(80).join("\n")).toContain("failed: code run failed (exception): boom");

    const expanded = renderPtcToolResultExpanded(
      { ...result, details: {} },
      { description: "x" },
      true,
      makeTheme(),
    );
    expect(expanded.render(80).join("\n")).toContain("boom");
  });

  test("a failed run invents no meta — no '0ms' duration it was never told", () => {
    const collapsed = renderPtcToolResultCollapsed(
      { content: [{ type: "text", text: "boom" }], details: {} },
      true,
      makeTheme(),
    );
    expect(collapsed.render(80).join("\n")).not.toContain("0ms");
  });
});

describe("createPtcRenderers (the pair both tools register)", () => {
  test("renderResult dispatches collapsed / expanded / partial for either surface", () => {
    const details = {
      surface: "workflow" as const,
      logs: [],
      narrations: [],
      phases: ["build"],
      warnings: [],
      durationMs: 12,
      imageCount: 0,
      subCalls: [
        {
          callId: 1,
          name: "bash",
          args: { command: "pnpm test" },
          status: "ok" as const,
          startMs: 0,
          endMs: 12,
          durationMs: 12,
        },
      ],
    };
    const context = { args: { description: "Verify", script: "return 1;" }, isError: false };
    const renderers = createPtcRenderers("workflow");
    const renderResult = renderers.renderResult;
    if (renderResult === undefined) throw new Error("renderResult must be defined");

    const collapsed = renderResult(
      { content: [], details },
      { expanded: false, isPartial: false },
      makeTheme(),
      context as never,
    );
    expect(collapsed.render(80).join("\n")).toContain("pnpm test");

    const expanded = renderResult(
      { content: [], details },
      { expanded: true, isPartial: false },
      makeTheme(),
      context as never,
    );
    // The expanded view adds the labelled blocks; the sub-call tree stays in both.
    expect(expanded.render(80).join("\n")).toContain("phases");
    expect(expanded.render(80).join("\n")).toContain("pnpm test");

    // A partial push renders the tree alone, with no completion-value placeholder.
    const partial = renderResult(
      { content: [], details },
      { expanded: false, isPartial: true },
      makeTheme(),
      context as never,
    );
    const partialText = partial.render(80).join("\n");
    expect(partialText).toContain("pnpm test");
    expect(partialText).not.toContain("done");
  });
});

describe("sub-row label gutter", () => {
  test("a name longer than the gutter still gets a separator before the status", () => {
    // `pi.dispatch` is 11 characters and the gutter is 8, so `padEnd` alone left it glued to the
    // status text — the flagship dispatch row read `pi.dispatchrejected: …`.
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "pi.dispatch",
        args: { agent: "agent-research" },
        status: "rejected",
        startMs: 0,
        durationMs: 0,
        errorMessage: "dispatch depth limit reached",
      },
    ];
    const out = renderPtcToolResultCollapsed(
      {
        content: [],
        details: {
          surface: "run_code",
          logs: [],
          narrations: [],
          phases: [],
          warnings: [],
          durationMs: 1,
          imageCount: 0,
          subCalls,
        },
      },
      false,
      makeTheme(),
      { isPartial: true },
    ).render(120);
    const row = out.find((line) => line.includes("pi.dispatch"));
    expect(row).toBeDefined();
    expect(row).toContain("pi.dispatch ");
    expect(row).not.toContain("pi.dispatchrejected");
  });
});

describe("partial sub-call tree (ADR-0021 §4)", () => {
  test("a partial render shows the tree and claims no completion value", () => {
    // While the run is in flight there is no completion value yet. Rendering the settled
    // placeholder ("done") here would claim the program had finished; the live push must show
    // only the tree.
    const theme = makeTheme();
    const row = renderPtcToolResultCollapsed(
      {
        content: [],
        details: {
          surface: "run_code",
          logs: [],
          narrations: [],
          phases: [],
          warnings: [],
          durationMs: 42,
          imageCount: 0,
          subCalls: [
            {
              callId: 1,
              name: "bash",
              args: { command: "sleep 5" },
              status: "running",
              startMs: 0,
            },
          ],
        },
      },
      false,
      theme,
      { isPartial: true },
    );
    const lines = row.render(80);
    expect(lines.join("\n")).not.toContain("done");
    expect(lines.join("\n")).toContain("running");
    expect(lines.join("\n")).toContain("sleep 5");
  });

  test("a settled render still shows the completion value placeholder", () => {
    // The guard is scoped to partial renders: once settled with no return value, "done" is right.
    const row = renderPtcToolResultCollapsed(
      {
        content: [],
        details: {
          surface: "run_code",
          logs: [],
          narrations: [],
          phases: [],
          warnings: [],
          durationMs: 42,
          imageCount: 0,
        },
      },
      false,
      makeTheme(),
    );
    expect(row.render(80).join("\n")).toContain("done");
  });
});

describe("sub-call tree in collapsed view (ADR-0021)", () => {
  test("appends five sub-rows after the result area, one per status, with the right connectors and previews", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "read",
        args: { path: "/tmp/foo.ts" },
        status: "running",
        startMs: 0,
      },
      {
        callId: 2,
        name: "bash",
        args: { command: "pnpm test" },
        status: "ok",
        startMs: 0,
        endMs: 1200,
        durationMs: 1200,
      },
      {
        callId: 3,
        name: "pi.dispatch",
        args: { agent: "agent-research" },
        status: "error",
        startMs: 0,
        endMs: 100,
        errorMessage: "boom",
      },
      {
        callId: 4,
        name: "bash",
        args: { command: "long-running-cmd" },
        status: "cancelled",
        startMs: 0,
        endMs: 50,
        durationMs: 50,
      },
      {
        callId: 5,
        name: "pi.dispatch",
        args: { agent: "agent-extra" },
        status: "rejected",
        startMs: 0,
        endMs: 0,
        durationMs: 0,
        errorMessage: "capacity",
      },
    ];
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    // Result area + 5 sub-rows = 6 lines.
    expect(out).toHaveLength(6);
    expect(out[0]).toContain("→ hello");
    // First sub-row: running read with path preview, muted slot.
    expect(out[1]).toMatch(/^   ├─ read/);
    expect(out[1]).toContain("/tmp/foo.ts");
    expect(out[1]).toContain("running");
    // Middle sub-row: ok bash with command preview and duration, accent slot.
    expect(out[2]).toMatch(/^   ├─ bash/);
    expect(out[2]).toContain("pnpm test");
    expect(out[2]).toContain("ok 1.2s");
    // Mid sub-row: failed pi.dispatch with → agent preview, error slot.
    expect(out[3]).toMatch(/^   ├─ pi.dispatch/);
    expect(out[3]).toContain("→ agent-research");
    expect(out[3]).toContain("failed: boom");
    // Mid sub-row: cancelled bash, muted slot.
    expect(out[4]).toMatch(/^   ├─ bash/);
    expect(out[4]).toContain("cancelled");
    // Last sub-row: rejected pi.dispatch with default concurrency message, warning slot.
    expect(out[5]).toMatch(/^   └─ pi.dispatch/);
    expect(out[5]).toContain("→ agent-extra");
    expect(out[5]).toContain("rejected: capacity");
    // All five status colour slots show up in the render path (running + cancelled both use muted).
    expect(fgTagsUsed(theme)).toContain("muted");
    expect(fgTagsUsed(theme)).toContain("accent");
    expect(fgTagsUsed(theme)).toContain("error");
    expect(fgTagsUsed(theme)).toContain("warning");
  });

  test("rejected with no errorMessage falls back to 'rejected: concurrency'", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "pi.dispatch",
        args: { agent: "agent-extra" },
        status: "rejected",
        startMs: 0,
        endMs: 0,
        durationMs: 0,
      },
    ];
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("rejected: concurrency");
  });

  test("cancelled sub-row has no duration suffix (US12 says it was interrupted, not timed)", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "bash",
        args: { command: "pnpm test" },
        status: "cancelled",
        startMs: 0,
        endMs: 50,
        durationMs: 50,
      },
    ];
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    expect(out).toHaveLength(2);
    // Cancelled status is the literal "cancelled" — no duration suffix (ADR-0021 §6).
    expect(out[1]).toMatch(/cancelled(?!\s+\d)/);
    expect(out[1]).not.toContain("50ms");
  });

  test("32-row hard cap with a +18 more calls tail when fed 50 records", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = Array.from({ length: 50 }, (_, i): SubCallRecord => ({
      callId: i,
      name: "read",
      args: { path: `/tmp/file${i}.ts` },
      status: "ok",
      startMs: 0,
      durationMs: 100 + i,
    }));
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    // Result area + 32 sub-rows + 1 tail = 34 lines.
    expect(out).toHaveLength(34);
    // First sub-row is `├─` (not `└─`) because a tail follows.
    expect(out[1]).toMatch(/^   ├─ read/);
    // The 32nd sub-row (index 32) is still `├─` for the same reason.
    expect(out[32]).toMatch(/^   ├─ read/);
    // Tail row carries `└─ …+18 more calls`.
    expect(out[33]).toBe("   └─ …+18 more calls");
  });

  test("args preview falls back to JSON.stringify(args) when no name selector matches", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "tools.foo",
        args: { x: 1 },
        status: "running",
        startMs: 0,
      },
    ];
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('{"x":1}');
    // JSON.stringify produced no newlines.
    expect(out[1]).not.toContain("\n");
  });

  test("args preview folds embedded newlines and caps at 40 chars", () => {
    const theme = makeTheme();
    const longKey = "k".repeat(80);
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "tools.foo",
        args: { [longKey]: "value\nwith\nbreaks" },
        status: "running",
        startMs: 0,
      },
    ];
    const result = { details: makeDetails({ result: "hello", subCalls }) };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 200);
    expect(out).toHaveLength(2);
    // No embedded newlines in the rendered line.
    expect(out[1]).not.toContain("\n");
    // The preview segment (after `running ` and its leading space) is at most 40 chars and
    // capped with `…` (ADR-0021 §3: 40-char preview cap with ellipsis when longer).
    const preview = out[1]?.split("running ")[1] ?? "";
    expect(preview.length).toBeLessThanOrEqual(40);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("sub-call tree in expanded view (ADR-0021)", () => {
  test("renders the sub-call tree between the result area and the labelled blocks", () => {
    const theme = makeTheme();
    const subCalls: SubCallRecord[] = [
      {
        callId: 1,
        name: "read",
        args: { path: "/tmp/foo.ts" },
        status: "ok",
        startMs: 0,
        durationMs: 12,
      },
    ];
    const result = {
      details: makeDetails({
        result: 42,
        logs: ["[ptc] out 1"],
        subCalls,
      }),
    };
    const out = lines(
      renderPtcToolResultExpanded(result, { code: "return 42;" }, false, theme),
      200,
    );
    // Result area is the summary line for the scalar value.
    expect(out[0]).toContain("→ 42");
    // Sub-call row sits between the result area and the `out` labelled block.
    const subRowIndex = out.findIndex((l) => l.includes("read"));
    const outBlockIndex = out.findIndex((l) => l.includes("└─ out") || l.includes("├─ out"));
    expect(subRowIndex).toBeGreaterThan(0);
    expect(outBlockIndex).toBeGreaterThan(subRowIndex);
    expect(out[subRowIndex]).toContain("/tmp/foo.ts");
  });
});
