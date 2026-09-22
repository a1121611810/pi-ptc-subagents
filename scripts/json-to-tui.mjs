#!/usr/bin/env node
// Convert pi's --mode json event stream into TUI-style compact lines.
// Reads NDJSON from stdin, writes one log line per top-level event.
//
// Usage:
//   pi --mode json ... -p '...' | node scripts/json-to-tui.mjs
//
// Emits lines like:
//   · Thought for 1.2s
//   · Ran ptc_run_code  Read pkg + node --version
//   · Used WebFetch (https://...)
//
// Each line is {verb} + ({arg} or empty) + optional {detail}; the verb is
// chosen from the event / tool name. Lines are flushed as soon as an event
// closes (turn_end, message_end on a tool result, tool_execution_end).

import { createInterface } from "node:readline";

const COLORS = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};
const BULLET = COLORS.dim("·");
const TOOL_COLOR = {
  read: COLORS.yellow,
  bash: COLORS.magenta,
  edit: COLORS.green,
  write: COLORS.cyan,
  grep: COLORS.gray,
  find: COLORS.gray,
  ls: COLORS.gray,
  ptc_run_code: COLORS.blue,
  ptc_workflow: COLORS.blue,
  web_search: COLORS.blue,
  source_check: COLORS.blue,
  fetch_content: COLORS.blue,
  get_search_content: COLORS.gray,
  moonshot_search: COLORS.blue,
  moonshot_fetch: COLORS.blue,
  kimi_datasource: COLORS.blue,
  webfetch: COLORS.blue,
  subagent: COLORS.cyan,
};
const colorFor = (name) => TOOL_COLOR[name] ?? COLORS.blue;

// Per-event transient state
const state = {
  thinkingStartedAt: null,
  thinkingCharCount: 0,
  toolArgs: new Map(), // toolCallId -> { name, argsPreview }
  lastTurnHadAction: false,
};

function fmtDuration(ms) {
  if (ms == null) return "?s";
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s, n = 120) {
  if (s == null) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// Render a "tool call / execution" line. We merge toolcall_end (model wrote
// the tool call) and tool_execution_end (host ran it) into one "Ran <name>"
// line, matching the TUI's "· Ran <tool> <args>" rendering.
function emitToolRun(toolCallId, name, args, result, isError) {
  const verb = name.startsWith("ptc_") ? "Ran" : "Ran";
  const argStr = renderArgs(name, args);
  const color = colorFor(name);
  const errTag = isError ? " " + COLORS.red("(failed)") : "";
  process.stdout.write(
    `${BULLET} ${color(verb)} ${color(name)}${argStr ? " " + COLORS.gray(argStr) : ""}${errTag}\n`,
  );
}

function renderArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  switch (name) {
    case "read":
      return truncate(args.path ?? "");
    case "bash":
      return truncate(args.command ?? "");
    case "edit":
      return truncate(args.path ?? args.file_path ?? "");
    case "write":
      return truncate(args.path ?? args.file_path ?? "");
    case "grep":
    case "find":
    case "ls":
      return truncate(args.pattern ?? args.query ?? args.path ?? "");
    case "ptc_run_code":
    case "ptc_workflow": {
      const code = typeof args.code === "string" ? args.code : "";
      // First non-blank line is usually the most informative
      const firstLine =
        code
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("//")) ?? "";
      const desc = args.description ? ` [${args.description}]` : "";
      return `${truncate(firstLine, 80)}${desc}`;
    }
    case "web_search":
      return truncate(args.query ?? args.queries?.join(" | ") ?? "");
    case "source_check":
      return truncate(args.claim ?? "");
    case "fetch_content":
      return truncate(args.url ?? "");
    case "get_search_content":
      return truncate(args.findText ?? args.url ?? "");
    case "moonshot_search":
      return truncate(args.query ?? "");
    case "moonshot_fetch":
      return truncate(args.url ?? "");
    case "kimi_datasource":
      return truncate(`${args.data_source_name ?? ""}/${args.api_name ?? ""}`);
    case "subagent":
      return truncate(args.task ?? args.agent ?? "");
    default:
      return truncate(JSON.stringify(args));
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    process.stderr.write(`(unparsed) ${line.slice(0, 80)}\n`);
    continue;
  }
  switch (evt.type) {
    case "message_start": {
      // No-op; we render actions as they complete.
      break;
    }
    case "message_update": {
      const ame = evt.assistantMessageEvent;
      if (!ame) break;
      if (ame.type === "thinking_start") {
        state.thinkingStartedAt = Date.now();
        state.thinkingCharCount = 0;
      } else if (ame.type === "thinking_delta") {
        state.thinkingCharCount += (ame.delta ?? "").length;
      } else if (ame.type === "thinking_end") {
        const dur = state.thinkingStartedAt ? Date.now() - state.thinkingStartedAt : null;
        process.stdout.write(`${BULLET} ${COLORS.dim("Thought for " + fmtDuration(dur))}\n`);
        state.thinkingStartedAt = null;
        state.thinkingCharCount = 0;
      } else if (ame.type === "toolcall_start") {
        state.toolArgs.set(ame.id, { name: ame.toolName, args: "", full: "" });
      } else if (ame.type === "toolcall_delta") {
        const cur = state.toolArgs.get(ame.id) ?? { name: ame.toolName, args: "" };
        cur.full += ame.delta ?? "";
        // Try to parse incrementally so we have final args when end arrives.
        try {
          cur.args = JSON.parse(cur.full);
        } catch {
          // partial JSON; keep accumulating
        }
        state.toolArgs.set(ame.id, cur);
      } else if (ame.type === "toolcall_end") {
        // tool_execution_end.args is empty {}; the real args are here.
        // Note: toolcall_end has no top-level `id` — only inside `toolCall.id`.
        const id = ame.toolCall?.id ?? ame.id;
        const cur = state.toolArgs.get(id) ?? {
          name: ame.toolCall?.name ?? ame.toolName,
          args: null,
        };
        if (ame.toolCall?.arguments && Object.keys(ame.toolCall.arguments).length > 0) {
          cur.args = ame.toolCall.arguments;
        }
        if (ame.toolCall?.name) cur.name = ame.toolCall.name;
        if (id) state.toolArgs.set(id, cur);
      }
      break;
    }
    case "tool_execution_end": {
      const cur = state.toolArgs.get(evt.toolCallId);
      const name = evt.toolName ?? cur?.name ?? "?";
      // tool_execution_end.args is an empty {} in current pi; the real args
      // landed in toolcall_end.assistantMessageEvent.toolCall.arguments.
      const args = cur?.args && Object.keys(cur.args).length > 0 ? cur.args : evt.args;
      const isError = !!evt.result?.isError;
      emitToolRun(evt.toolCallId, name, args, evt.result, isError);
      // For ptc_run_code / ptc_workflow, surface the program/console output briefly
      if ((name === "ptc_run_code" || name === "ptc_workflow") && !isError) {
        const text = evt.result?.content?.[0]?.text ?? "";
        if (text) {
          for (const ln of String(text).split("\n").slice(0, 8)) {
            if (ln.trim()) process.stdout.write(`  ${COLORS.gray(ln)}\n`);
          }
          const more = String(text).split("\n").length - 8;
          if (more > 0) process.stdout.write(`  ${COLORS.gray(`… +${more} more lines`)}\n`);
        }
      } else if (isError) {
        const text = evt.result?.content?.[0]?.text ?? "";
        if (text) process.stdout.write(`  ${COLORS.red(truncate(text, 200))}\n`);
      }
      state.toolArgs.delete(evt.toolCallId);
      break;
    }
    case "message_end": {
      if (evt.message?.role === "assistant") {
        // If the assistant produced a final text segment with no tool calls,
        // surface a compact preview. Most turns end with tool use so this is
        // usually empty.
        const blocks = evt.message?.content ?? [];
        const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
        const summary = texts.join("\n").trim();
        if (summary) {
          for (const ln of summary.split("\n").slice(0, 12)) {
            if (ln.trim()) process.stdout.write(`  ${COLORS.gray(ln)}\n`);
          }
          const more = summary.split("\n").length - 12;
          if (more > 0) process.stdout.write(`  ${COLORS.gray(`… +${more} more lines`)}\n`);
        }
      }
      break;
    }
    case "turn_end": {
      // Just a marker; lines already emitted above.
      break;
    }
    default:
      // ignore unknown event types
      break;
  }
}
