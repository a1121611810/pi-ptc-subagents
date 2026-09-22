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
 * connectors used in the expanded view.
 */
import { describe, expect, test, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  firstMeaningfulCodeLine,
  renderPtcToolCall,
  renderPtcToolResultCollapsed,
  renderPtcToolResultExpanded,
} from "../src/tools/render.ts";
import type { PtcToolDetails } from "../src/tools/common.ts";

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

/** `\n` written as two characters — the escape this renderer must never emit. */
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
});

describe("renderPtcToolResultCollapsed", () => {
  test("success: summary under the call, right-aligned meta on the same line", () => {
    const theme = makeTheme();
    const result = {
      content: [{ type: "text", text: "unused" }],
      details: makeDetails({
        result: { version: "0.1.0", name: "pi-ptc-subagents" },
        logs: ["a", "b"],
      }),
    };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 80);
    expect(out).toHaveLength(1);
    const line = out[0] ?? "";
    // The summary hangs at column 3 (the call's content column) with three spaces of indent.
    expect(line).toContain('   → {version: "0.1.0", name: "pi-ptc-subagents"}');
    expect(line).toContain("2 output lines");
    expect(line).toContain("123ms");
    // The meta is pinned to the right edge: the row is padded to exactly the viewport width.
    expect(visibleWidth(line)).toBe(80);
    expect(line.endsWith("123ms")).toBe(true);
  });

  test("multi-line string result collapses to its first line — never an escaped payload", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({ result: "line one\nline two\nline three", durationMs: 412 }),
    };
    const out = lines(renderPtcToolResultCollapsed(result, false, theme), 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("→ line one (+2 lines)");
    expect(out[0]).not.toContain(ESCAPED_NEWLINE);
  });

  test("large object result reports its shape instead of its contents", () => {
    const theme = makeTheme();
    const big: Record<string, string> = {};
    for (const key of ["file", "clipNow", "extra", "more", "evenMore"]) big[key] = "x".repeat(80);
    const out = visible(
      renderPtcToolResultCollapsed({ details: makeDetails({ result: big }) }, false, theme),
    );
    expect(out).toContain("→ {file, clipNow, extra, more, +1}");
    expect(out).not.toContain("x".repeat(80));
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

  test("narrow viewport keeps the meta and stays on one line", () => {
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

  test("summary line then tree children: code, phases, log, out, warn, value", () => {
    const theme = makeTheme();
    const result = {
      content: [{ type: "text", text: "Phases: init → compute" }],
      details: makeDetails({
        surface: "workflow",
        narrations: ["log line A"],
        logs: ["[ptc] out 1"],
        phases: ["init", "compute"],
        warnings: ['phase "extra" is not listed in meta.phases'],
        result: { version: "0.1.0", node: "v24" },
        durationMs: 1500,
      }),
    };
    const out = visible(renderPtcToolResultExpanded(result, codeArgs, false, theme));
    // The summary line carries the hint), with ` +`,
    expect(out).toContain('   → {version: "0.1.0", node: "v24"}');
    // Each child block is led by its connector, with the label padded into the gutter.
    expect(out).toContain('├─ phases  init → compute');
    expect(out).toContain('├─ log     log line A');
    expect(out).toContain('├─ out     [ptc] out 1');
    expect(out).toContain('├─ warn    phase "extra" is not listed');
    expect(out).toContain('└─ value   {version: "0.1.0", node: "v24"}');
    // The first child uses `├─`; the last child uses `└─`.
    expect(out).toContain('├─ code    // preamble');
    expect(out).toContain('└─ value   {version: "0.1.0", node: "v24"}');
    // The description lives on the call row; repeating it here would be noise.
    expect(out).not.toContain("Ship the release");
  });

  test("value blocks keep real newlines and indent continuations past the gutter", () => {
    const theme = makeTheme();
    const result = {
      details: makeDetails({
        result: { file: "one\ntwo\nthree", clipNow: "«class PNGf»" },
        durationMs: 536,
      }),
    };
    const out = visible(renderPtcToolResultExpanded(result, { code: "return x;" }, false, theme));
    // The `value` block opens on a `├─ ` (last child here, so actually `└─ `); check both prefixes.
    expect(out).toMatch(/[├└]─ value\s+\{/);
    expect(out).toContain("file:");
    // Continuations are prefixed with `│          ` (3 indent + 2 connector + 3 gutter = 8), so
    // a value-line at the same indent as the label sits beneath, e.g. the file content lines.
    expect(out).toMatch(/^\s+one$/m);
    expect(out).not.toContain(ESCAPED_NEWLINE);
  });

  test("caps long blocks and says how much it withheld", () => {
    const theme = makeTheme();
    const logs = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = { details: makeDetails({ logs, durationMs: 10 }) };
    const out = visible(renderPtcToolResultExpanded(result, {}, false, theme));
    // First 12 logs (MAX_LOG_LINES_EXPANDED) are shown; line 12+ is truncated.
    expect(out).toContain("line 11");
    expect(out).not.toContain("line 12");
    // `+8 more lines` (20 - 12 = 8) appears as a continuation line under the out block.
    expect(out).toContain("…+8 more lines");
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
        { details: makeDetails({ fullOutputPath: "/tmp/pi-ptc-output-1.txt" })},
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
    const collapsed = visible(renderPtcToolResultCollapsed({ details: makeDetails({ imageCount: 2 }) }, false, theme));
    expect(collapsed).toContain("2 images");
    expect(fgTagsUsed(theme)).toContain("toolOutput");
    // Expanded: a tree child `img` child block at the end with the image description.
    const expanded = visible(renderPtcToolResultExpanded({ details: makeDetails({ imageCount: 2 }) }, {}, false, theme));
    expect(expanded).toContain("└─ image");
    expect(expanded).toContain("2 images attached");
  });

  test("tree connectors: first child uses `├─`, last child uses `└─`, mid children use `├─`", () => {
    const theme = makeTheme();
    // Three blocks: code, out, value (value is last).
    const result = {
      details: makeDetails({
        logs: ["a", "b"],
        result: { x: 1 },
      }),
    };
    const args = { description: "d", code: "return 1;" };
    const out = visible(renderPtcToolResultExpanded(result, args, false, theme));
    const lines = out.split("\n");
    const codeLine = lines.find((l) => l.startsWith("   ├─ code") || l.startsWith("   └─ code"));
    const outLine = lines.find((l) => l.startsWith("   ├─ out") || l.startsWith("   └─ out"));
    const valueLine = lines.find((l) => l.startsWith("   ├─ value") || l.startsWith("   └─ value"));
    expect(codeLine).toMatch(/^   ├─ code/);
    expect(outLine).toMatch(/^   ├─ out/);
    expect(valueLine).toMatch(/^   └─ value/);
    // Continuation lines under `├─ ` children use `│          `; under `└─ ` they use spaces.
    const continuations = lines.filter((l) => /^[│ ]+\s{8}/.test(l));
    expect(continuations.length).toBeGreaterThan(0);
  });
});
