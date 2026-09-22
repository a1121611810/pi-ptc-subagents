/**
 * Model-facing text hygiene (`src/tools/text.ts`): what pi's built-in tools already do to a
 * result before the model reads it, and what PTC's own text assembly used to skip (ADR-0012).
 */
import { expect, test } from "vitest";
import { MAX_LINE_CHARS, renderModelValue, sanitizeText, stripAnsi } from "../src/tools/text.ts";

const ESC = "\u001b";
const BEL = "\u0007";

test("stripAnsi removes SGR colours, OSC hyperlinks and cursor moves", () => {
  expect(stripAnsi(`${ESC}[38;2;212;212;212mgrey${ESC}[39m`)).toBe("grey");
  expect(stripAnsi(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe("link");
  expect(stripAnsi(`${ESC}[2Kclean`)).toBe("clean");
});

test("stripAnsi leaves text with no introducer untouched", () => {
  expect(stripAnsi("plain \\u001b text")).toBe("plain \\u001b text");
});

test("sanitizeText normalizes line endings and drops what crashes width math", () => {
  expect(sanitizeText("a\r\nb")).toBe("a\nb");
  // pi's built-ins remove a lone CR rather than treating it as a break, and so do we.
  expect(sanitizeText("a\rb")).toBe("ab");
  expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
  expect(sanitizeText("tab\there\nline")).toBe("tab\there\nline");
  expect(sanitizeText("a\ufffab")).toBe("ab");
});

test("renderModelValue keeps a top-level string verbatim", () => {
  expect(renderModelValue("content through ptc_run_code\n")).toBe("content through ptc_run_code\n");
  expect(renderModelValue(`${ESC}[1mbold${ESC}[0m`)).toBe("bold");
});

test("renderModelValue renders scalars as themselves", () => {
  expect(renderModelValue(42)).toBe("42");
  expect(renderModelValue(true)).toBe("true");
  expect(renderModelValue(null)).toBe("null");
});

test("a small object stays on one line, with unquoted keys", () => {
  expect(renderModelValue({ answer: 42 })).toBe("{answer: 42}");
  expect(renderModelValue({ list: [1, 2, 3], ok: true })).toBe("{list: [1, 2, 3], ok: true}");
  expect(renderModelValue({ "two words": 1 })).toBe('{"two words": 1}');
});

test("a string with a real newline goes to block form instead of JSON escaping it", () => {
  expect(renderModelValue({ path: "a.ts", text: "line1\nline2" })).toBe(
    ["{", '  path: "a.ts"', "  text:", "    line1", "    line2", "}"].join("\n"),
  );
});

test("ANSI never reaches the value: it is stripped wherever it appears", () => {
  // The shape the bug report showed: bash output captured into a program's return value.
  const rendered = renderModelValue({
    stdout: `${ESC}[32mPASS${ESC}[39m src/index.ts\n${ESC}[31mFAIL${ESC}[39m src/broken.ts`,
  });
  expect(rendered).toBe(
    ["{", "  stdout:", "    PASS src/index.ts", "    FAIL src/broken.ts", "}"].join("\n"),
  );
  expect(rendered).not.toContain("\\u001b");
});

test("no rendered line carries trailing whitespace", () => {
  // A value ending in a newline used to leave an indented, whitespace-only line behind.
  const rendered = renderModelValue({ log: "one\n\ntwo\n" });
  expect(rendered.split("\n").every((line) => line === line.trimEnd())).toBe(true);
});

test("short nested containers stay inline", () => {
  expect(renderModelValue({ nested: { count: 2 }, deep: { a: { b: { c: 1 } } } })).toBe(
    "{nested: {count: 2}, deep: {a: {b: {c: 1}}}}",
  );
});

test("block form puts a container's brace on its key's line", () => {
  expect(renderModelValue({ outer: { inner: { text: "a\nb" } } })).toBe(
    [
      "{",
      "  outer: {",
      "    inner: {",
      "      text:",
      "        a",
      "        b",
      "    }",
      "  }",
      "}",
    ].join("\n"),
  );
});

test("a long inline form falls back to block form rather than one dense line", () => {
  const rendered = renderModelValue({ first: "x".repeat(60), second: "y".repeat(60) });
  expect(rendered.split("\n")[0]).toBe("{");
  expect(rendered).toContain('  first: "');
  expect(rendered).toContain('  second: "');
});

test("arrays of containers render one element per line", () => {
  const rendered = renderModelValue([{ a: "1\n2" }, { b: "3\n4" }]);
  expect(rendered).toBe(
    [
      "[",
      "  {",
      "    a:",
      "      1",
      "      2",
      "  }",
      "  {",
      "    b:",
      "      3",
      "      4",
      "  }",
      "]",
    ].join("\n"),
  );
});

test("no rendered line exceeds the cap", () => {
  const rendered = renderModelValue({ blob: "y".repeat(400) });
  for (const line of rendered.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
  }
  expect(rendered.split("\n").at(-2)).toMatch(/…$/);
});
