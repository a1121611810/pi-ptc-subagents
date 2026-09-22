/**
 * Model-facing text hygiene: the step pi's built-in tools take and PTC's own text assembly missed.
 *
 * Every built-in tool result is cleaned before the model reads it —
 * `stripAnsi` → `sanitizeBinaryOutput` → drop `\r` (`pi-coding-agent`:
 * `dist/core/tools/render-utils.js`) — because a tool's output is arbitrary bytes: ANSI colour
 * codes from `pnpm`/`vitest`, carriage-return progress bars, NUL bytes from a binary file.
 *
 * The PTC tools assemble their own text block (`common.ts: renderToolResult`) and did none of
 * that, so a program returning captured `bash` output shipped `\u001b[38;2;212;212;212m` to the
 * model as literal escapes, and any string with a real newline arrived JSON-escaped as `\n`.
 * Both are pure noise the model has to read — and ANSI noise is charged per character, in tokens.
 *
 * **Scope: the text block only.** `details` stays raw so the TUI keeps rendering real colours
 * (`@earendil-works/pi-tui`'s `Text` understands ANSI), and a binding's result inside a program
 * is untouched — a program that wants coloured bytes for a file still has them. See ADR-0012.
 *
 * pi exports neither helper (its `exports` map has only `.`, `./rpc-entry`, `./client`,
 * `./experimental/plugin`), so both are mirrored here rather than imported. The ANSI pattern
 * follows ansi-regex / strip-ansi (MIT, Sindre Sorhus) via pi's own implementation.
 */
import type { PtcJsonValue } from "../runtime/protocol.ts";

/** Hard cap for one rendered line; longer lines are truncated with `…`. */
export const MAX_LINE_CHARS = 200;

/** A value stays on one line while its inline form fits this; otherwise it renders as a block. */
const INLINE_MAX_CHARS = 100;

/** Indent applied per nesting level in block form. */
const INDENT = "  ";

/**
 * ANSI escapes, in the two shapes that matter: OSC (\`ESC ] …\` to BEL, \`ESC \\\\` or C1 ST) and
 * CSI plus friends (introducer, optional intermediates, optional params, final byte).
 *
 * Built through the \`RegExp\` constructor from an escaped source so no control character appears
 * literally — the repo lints via oxlint, whose \`no-control-regex\` rule rejects that.
 */
const ANSI_PATTERN = new RegExp(
  [
    "(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))",
    "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
  ].join("|"),
  "g",
);

/** Drop ANSI escape sequences (colours, cursor moves, OSC hyperlinks). */
export function stripAnsi(value: string): string {
  // Fast path: without an ESC or C1 introducer there is nothing to strip.
  if (!value.includes(String.fromCharCode(27)) && !value.includes(String.fromCharCode(155))) {
    return value;
  }
  return value.replace(ANSI_PATTERN, "");
}

/**
 * Make arbitrary program output safe to hand the model.
 *
 * Same three steps as pi's built-ins: strip ANSI, remove `\r` (a progress bar's carriage
 * return is not a line break), then drop control characters other than `\n`/`\t` and the
 * Unicode format characters that break width math. Lone surrogates fall out of code-point
 * iteration for free.
 */
export function sanitizeText(value: string): string {
  const stripped = stripAnsi(value).replace(/\r/g, "");
  if (stripped.length === 0) return stripped;
  let out = "";
  for (const char of stripped) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x0a || code === 0x09) {
      out += char;
      continue;
    }
    if (code <= 0x1f) continue;
    if (code >= 0xfff9 && code <= 0xfffb) continue;
    out += char;
  }
  return out;
}

/** Object keys that read as identifiers in the summary style are left unquoted. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function keyText(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/**
 * The inline form of a value, or `undefined` when it cannot be inlined.
 *
 * A string with a real newline is never inlined: keeping its line structure is the whole point
 * (see ADR-0012), and quoting it would turn one readable block back into `\n` escapes.
 */
function inlineForm(value: PtcJsonValue): string | undefined {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const sanitized = sanitizeText(value);
    return sanitized.includes("\n") ? undefined : JSON.stringify(sanitized);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const rendered = inlineForm(item);
      if (rendered === undefined) return undefined;
      items.push(rendered);
    }
    return `[${items.join(", ")}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const parts: string[] = [];
  for (const key of keys) {
    const rendered = inlineForm(value[key] ?? null);
    if (rendered === undefined) return undefined;
    parts.push(`${keyText(key)}: ${rendered}`);
  }
  return `{${parts.join(", ")}}`;
}

/** Inline rendering, but only while it stays short enough to read on one line. */
function tryInline(value: PtcJsonValue): string | undefined {
  const rendered = inlineForm(value);
  if (rendered === undefined) return undefined;
  return rendered.length <= INLINE_MAX_CHARS ? rendered : undefined;
}

/** A non-container value on its own line (block form only meets these defensively). */
function scalarText(value: string | number | boolean | null): string {
  if (value === null) return "null";
  return typeof value === "string" ? sanitizeText(value) : String(value);
}

/** One key per line, braces kept, string values raw (real newlines preserved, indented). */
function blockLines(value: PtcJsonValue, indent: string): string[] {
  if (value === null || typeof value !== "object") return [`${indent}${scalarText(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines = [`${indent}[`];
    for (const item of value) {
      const inline = tryInline(item);
      if (inline !== undefined) {
        lines.push(`${indent}${INDENT}${inline}`);
        continue;
      }
      lines.push(...valueLines(item, indent + INDENT));
    }
    lines.push(`${indent}]`);
    return lines;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return [`${indent}{}`];
  const lines = [`${indent}{`];
  const inner = indent + INDENT;
  for (const key of keys) {
    const child = value[key] ?? null;
    const inline = tryInline(child);
    if (inline !== undefined) {
      lines.push(`${inner}${keyText(key)}: ${inline}`);
      continue;
    }
    if (typeof child === "string") {
      // A multi-line string keeps its own lines; the key line above delimits it.
      lines.push(`${inner}${keyText(key)}:`);
      for (const line of sanitizeText(child).split("\n")) {
        // A blank line inside a multi-line value stays blank — indenting it would leave trailing
        // whitespace in every transcript that shows a block ending in a newline.
        lines.push(line.length === 0 ? "" : `${inner}${INDENT}${line}`);
      }
      continue;
    }
    // A container opens on its key's line (`outer: {`) and closes back at the key's indent, so a
    // nested value does not push its braces onto lines of their own.
    const nested = blockLines(child, inner);
    lines.push(
      `${inner}${keyText(key)}: ${(nested[0] ?? "").trimStart()}`.trimEnd(),
      ...nested.slice(1),
    );
  }
  lines.push(`${indent}}`);
  return lines;
}

function valueLines(value: PtcJsonValue, indent: string): string[] {
  if (typeof value === "string") return sanitizeText(value).split("\n");
  if (value === null || typeof value !== "object") return [String(value)];
  return blockLines(value, indent);
}

/** Truncate every line that exceeds {@link MAX_LINE_CHARS}. */
function capLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line))
    .join("\n");
}

/**
 * Render a completion value for the model: strings verbatim, everything else as a compact
 * `{key: value}` summary or an indented block — never `JSON.stringify` on the whole value, whose
 * escaping destroys exactly the content a reader needs (newlines, quotes, non-ASCII spacing).
 */
export function renderModelValue(value: PtcJsonValue): string {
  // A program that returns text reads as text — quoting a top-level string would turn a report
  // into one escaped line, which is the failure mode this module exists to remove.
  if (typeof value === "string") return capLines(sanitizeText(value));
  if (value === null || typeof value !== "object") return String(value);
  const inline = tryInline(value);
  const body = inline !== undefined ? [inline] : valueLines(value, "");
  return capLines(body.join("\n"));
}
