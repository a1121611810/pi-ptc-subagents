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

process.stdout.write(
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "SMOKE-OK prompt-bytes=" + String(Buffer.byteLength(prompt, "utf8")),
        },
      ],
    },
  }) + "\n",
);
process.exit(0);
