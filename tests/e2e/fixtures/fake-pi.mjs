#!/usr/bin/env node
/**
 * The fake `pi` the T5 smoke test dispatches to.
 *
 * A REAL subprocess, so the parts that actually break are the ones under test: the process
 * spawns, `--append-system-prompt <file>` resolves, the system prompt is materialised, stdout is
 * parsed as JSON lines, and the exit code decides the outcome. A stubbed lifecycle would have
 * skipped every one of those, which is exactly the layer this ticket exists to cover.
 *
 * It answers the `--mode json -p` contract: one result object on stdout, exit 0. What it echoes
 * back is what the test asserts on, so the assertion is about the child's real output rather
 * than about a value the test handed to a mock.
 */

import { readFileSync } from "node:fs";

const promptFlag = process.argv.indexOf("--append-system-prompt");
const promptPath = promptFlag === -1 ? undefined : process.argv[promptFlag + 1];
const prompt = promptPath ? readFileSync(promptPath, "utf8") : "";

/*
 * `--tools` is echoed because it is the flag that decides how much child the parent gets. No
 * flag means pi's own full toolset stays in place; a value means the child was narrowed to that
 * list. A test can only assert which of those happened if the child reports what it was handed,
 * and reporting it from inside a real process is what makes the assertion about the spawn rather
 * than about a string the test itself built.
 */
const toolsFlag = process.argv.indexOf("--tools");
const tools = toolsFlag === -1 ? "none" : process.argv[toolsFlag + 1];

process.stdout.write(
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "SMOKE-OK prompt-bytes=" +
            String(Buffer.byteLength(prompt, "utf8")) +
            " tools=" +
            tools +
            // The prompt itself, folded to one line so a test can assert what the child was
            // actually handed rather than only how big it was. `prompt-bytes` alone proves a file
            // was passed; it cannot tell a prompt carrying the dispatch context from one that is
            // missing it, and #186's acceptance criterion is about the content.
            " prompt=" +
            prompt.replace(/\s+/g, " ").trim(),
        },
      ],
    },
  }) + "\n",
);
process.exit(0);
