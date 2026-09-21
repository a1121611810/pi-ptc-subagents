/**
 * `ptc_run_code` — the unstructured PTC surface.
 *
 * The model writes the body of an async function; inside it, pi's built-in tools are reachable as
 * `tools.<name>(args)` (all seven: read, bash, edit, write, grep, find, ls — ADR-0005's set), and
 * the program's return value plus `console.log` output are what come back. There are no helpers
 * on this surface: `log` / `phase` / `parallel` / `pipeline` belong to `ptc_workflow` (G1 #13 →
 * decision B; a call to a helper that does not exist is a plain `ReferenceError` through the
 * normal code-run error path).
 *
 * Scope notes, so this stays a faithful subset of DSH's `run_code`:
 * - DSH's `sandbox_permissions` / `justification` are deliberately absent — they exist to request
 *   a wider sandbox from an approval pipeline this package does not have (ADR-0007 ships no OS
 *   sandbox, and the map decision on #8 dropped the approval path).
 * - `timeoutMs: 0` does not disable the deadline; it falls back to `DEFAULT_CONFIG.timeoutMs`,
 *   exactly as DSH's resolver does (R1 §3). The description names the default and the ceiling.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBuiltinBindings } from "../runtime/bindings.ts";
import { runPtcProgram } from "../runtime/dispatcher.ts";
import { DEFAULT_CONFIG } from "../runtime/limits.ts";
import {
  codeRunFailedError,
  renderToolResult,
  resolveBindingNames,
  resolveToolCwd,
} from "./common.ts";
import type { PtcToolOptions } from "./common.ts";

const DESCRIPTION = [
  "Run a TypeScript program that composes pi's tools in one shot. Required arguments: `code` —",
  "the body of an async function (top-level `return` and `await` work; type annotations are",
  "advisory, the code runs type-stripped) — and `description`, a 5-10 word summary of what the",
  "program does.",
  "",
  "Inside the program, call this session's enabled built-in tools as `tools.<name>(args)` — e.g.",
  '`await tools.read({ path: "src/index.ts" })` or `await tools.bash({ command: "npm test" })`.',
  "The bound names mirror the session's active tools (a default session has `read`, `bash`, `edit`,",
  "`write`); calling a name that is not bound rejects with an error the program can catch, and",
  "independent calls may overlap under `Promise.all`.",
  "",
  "Only the program's return value and its `console.log` output come back. This surface has no",
  "helpers: `log` / `phase` / `parallel` / `pipeline` exist only in `ptc_workflow`.",
].join("\n");

const PARAMETERS = Type.Object({
  code: Type.String({
    description: "The program: the body of an async TypeScript function.",
  }),
  description: Type.String({
    description:
      "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI).",
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        `Elapsed deadline in milliseconds for the whole run, including tool calls. ` +
        `Omit it (or pass 0) for the default of ${DEFAULT_CONFIG.timeoutMs / 1000} s; ` +
        `anything above ${DEFAULT_CONFIG.maxTimeoutMs / 1000} s is capped.`,
    }),
  ),
});

/**
 * Build the `ptc_run_code` tool definition.
 *
 * Called once by the extension factory. Every run gets a fresh worker and a fresh binding table
 * built against the run's own cwd, so two concurrent calls cannot share state.
 */
export function createPtcRunCodeTool(options: PtcToolOptions = {}) {
  return defineTool({
    name: "ptc_run_code",
    label: "PTC Run Code",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolveToolCwd(ctx);
      const names = resolveBindingNames(options.getActiveToolNames?.());
      const startedAt = Date.now();
      const outcome = await runPtcProgram({
        code: params.code,
        surface: "run_code",
        cwd,
        bindings: createBuiltinBindings({ cwd, names }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        ...(options.config === undefined ? {} : { config: options.config }),
      });
      if (outcome.error !== undefined) throw codeRunFailedError(outcome);
      return renderToolResult({ outcome, surface: "run_code", durationMs: Date.now() - startedAt });
    },
  });
}
