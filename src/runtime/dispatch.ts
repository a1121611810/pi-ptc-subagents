/**
 * pi.dispatch: the parallel binding that spawns a fresh pi subprocess per call.
 *
 * ADR-0016 (2026-09-23) is the contract, and this file is the whole implementation:
 * agent-markdown discovery (`discoverAgent`, with the agentScope user/project split),
 * the recursion-depth hint appended to the child's system prompt (`appendDepthHint`),
 * the argv the child pi is launched with (`buildArgv`), and `dispatch()` itself —
 * spawn, JSON-line event parsing, usage accumulation, the close-outcome decision
 * (`decideCloseOutcome`), and SIGTERM → SIGKILL signal propagation when the run that
 * issued the dispatch is cancelled.
 *
 * Behaviourally compatible with pi's examples/extensions/subagent/index.ts reference
 * (--mode json, -p, --no-session, --append-system-prompt <tmpfile>), but not cooperative:
 * does not require the user to install pi's subagent extension. See ADR-0016 section 2.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

import {
  RealChildProcessLifecycle,
  type ChildExitValue,
  type ChildHandle,
  type ChildProcessLifecycle,
  type ParsedAgentEvent,
} from "./child-process-lifecycle.ts";

// Re-exports keep existing imports working after BG-03 moved these definitions.
// `tests/dispatch-helpers.test.ts` imports `parseAgentEvent` / `safeKill` from this
// module; rather than churn the test file, we re-export them.
export { parseAgentEvent, safeKill } from "./child-process-lifecycle.ts";

/**
 * Shared lifecycle adapter for the foreground `pi.dispatch` path. BG-03 extracted the
 * spawn / kill / JSONL-parse / exit-wait dance into a typed seam so the background
 * dispatch (ADR-0022) can drive the same handles from a different caller. Tests that
 * need to swap the adapter mock the `node:child_process` module (which is what
 * `RealChildProcessLifecycle` calls into); the seam itself is module-private.
 */
const DISPATCH_LIFECYCLE: ChildProcessLifecycle = new RealChildProcessLifecycle();

/**
 * The CLI command used to invoke a fresh pi subprocess for one dispatch.
 *
 * Always `"pi"` — pi-ptc is a library, not a CLI, and `dispatch` must spawn the
 * separate `pi` binary regardless of how the host process was launched. An
 * earlier copy of this function mirrored pi's own subagent extension and tried
 * to reuse `process.execPath + process.argv[1]`, which works only when the host
 * is `pi` itself; in any other host (test scripts, the dispatcher host process,
 * etc.) the function would spawn the host script in place of `pi`, producing
 * infinite recursion and a stdout pipe that never drains (so `proc.on('close')`
 * never fires). The caller surfaces a missing-binary condition via the child's
 * `error` event — `spawn` itself does not throw synchronously on ENOENT, the
 * async `error` listener does.
 */
const PI_COMMAND = "pi";

/** Per-call input. Mirrors pi's subagent extension's parameters (single-mode only). */
export interface DispatchInput {
  agent: string;
  task: string;
  cwd?: string;
  agentScope?: "user" | "project" | "both";
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Token usage accumulated from the child's message_end events. Optional. */
export interface DispatchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** Structured return value of pi.dispatch(...). Shape mirrors Promise.allSettled records. */
export interface DispatchResult {
  text: string;
  status: "fulfilled" | "rejected";
  /**
   * Whether the child pi process was actually brought up.
   *
   * `status: "rejected"` covers two very different things — the harness declining to start
   * (depth gate, concurrency gate, unknown agent, a spawn that never happened) and a child that
   * ran and failed. The sub-call
   * tree colours the first `rejected` (the harness said no) and the second `error` (the work
   * failed), so it needs the distinction rather than inferring it from `status` alone.
   */
  started: boolean;
  agentName: string;
  durationMs: number;
  exitCode: number;
  usage?: DispatchUsage;
  stderr?: string;
  errorMessage?: string;
}

/** Discovery of an agent by name; mirrors pi's subagent extension AgentConfig shape. */
export interface AgentConfigLike {
  readonly name: string;
  readonly source: "user" | "project" | "unknown";
  readonly model?: string;
  readonly systemPrompt: string;
  readonly tools?: readonly string[];
}

/** Per-run context handed to a dispatch binding; same shape as BindingContext. */
export interface DispatchContext {
  signal?: AbortSignal;
  callId: number;
  /** Run cwd (F4); default for `DispatchInput.cwd` when not overridden. */
  cwd: string;
  /** Depth of the calling PTC run: 0 for the parent turn, 1+ for a child of `pi.dispatch`. */
  depth: number;
  /** Maximum allowed depth for any run reachable from this dispatch (ADR-0016 Recursive section). */
  maxDispatchDepth: number;
}

/**
 * Compose the system prompt handed to the child subprocess.
 *
 * The agent's own markdown body is the user-supplied content; pi-ptc appends a
 * `<pi-ptc-context depth="N" max-depth="M">...</pi-ptc-context>` hint so the child
 * agent can see how much recursion room it has. The shape mirrors DSH's existing
 * subagent-context injection so the field recognises it.
 */
export function appendDepthHint(systemPrompt: string, depth: number, maxDepth: number): string {
  const hint = [
    '<pi-ptc-context depth="' + depth + '" max-depth="' + maxDepth + '">',
    "You are a PTC run at depth " +
      depth +
      " (root is depth 0). You may write PTC programs and you may",
    "call pi.dispatch(...) to spawn further children, but each level costs a fresh pi subprocess.",
    "The remaining depth budget is " +
      maxDepth +
      " - " +
      depth +
      ". Beyond it, pi.dispatch rejects with",
    '{ status: "rejected", errorMessage: "dispatch depth limit reached" }.',
    "</pi-ptc-context>",
  ].join("\n");
  return systemPrompt.length === 0 ? hint : systemPrompt + "\n\n" + hint;
}

/** Result returned when the depth limit is exceeded. */
export function dispatchDepthLimitReached(): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    // Verbatim: the hint block appendDepthHint appends to the child's system
    // prompt promises the program exactly this errorMessage.
    errorMessage: "dispatch depth limit reached",
  };
}

/**
 * Verbatim ADR-0016 §2 message for the per-run dispatch concurrency cap. Exported as a
 * named constant so the contract string has one definition and cannot drift (tests pin
 * it character for character).
 */
export const DISPATCH_CONCURRENCY_LIMIT_MESSAGE = "dispatch concurrency limit reached";

/** Result returned when the per-run dispatch concurrency cap is exceeded (ADR-0016 §2). */
export function dispatchConcurrencyLimitReached(): DispatchResult {
  return {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    errorMessage: DISPATCH_CONCURRENCY_LIMIT_MESSAGE,
  };
}

/**
 * Inputs to {@link decideCloseOutcome}: the shape the child's `close` event
 * hands the host, distilled to the fields that drive the resolve decision.
 */
export interface CloseOutcomeInput {
  /** `code ?? -1` from the child's close event. `-1` covers signal kill and no-code exit. */
  exitCode: number;
  /** Accumulated text from the last assistant message_end event. */
  finalText: string;
  /** `true` when `ctx.signal` aborted before this close fired. */
  aborted: boolean;
}

/** Result of {@link decideCloseOutcome} — what the dispatcher commits to. */
export interface CloseOutcome {
  status: "fulfilled" | "rejected";
  errorMessage?: string;
}

/**
 * Decide the outcome of one `dispatch(...)` based on the child's `close` event.
 *
 * Cancellation has priority over every other branch: when the host's signal
 * aborted the run, the child exited because we asked it to, and the contract
 * (ADR-0016 §4) is to surface "dispatch cancelled" rather than leave the
 * caller guessing why an aborted run came back `rejected`.
 *
 * Non-cancellation cases follow the original close-handler ladder:
 *   - exit 0 with final text → fulfilled
 *   - exit 0 without final text → rejected (the model never answered)
 *   - any other exit code → rejected, no errorMessage (spawn-error path labels
 *     its own failures with `failed to spawn pi: ...`)
 */
export function decideCloseOutcome(input: CloseOutcomeInput): CloseOutcome {
  if (input.aborted) {
    return { status: "rejected", errorMessage: "dispatch cancelled" };
  }
  if (input.exitCode === 0 && input.finalText.length > 0) {
    return { status: "fulfilled" };
  }
  if (input.exitCode === 0) {
    return { status: "rejected", errorMessage: "dispatch produced no final text" };
  }
  return { status: "rejected" };
}

/**
 * Minimal YAML frontmatter scalar parser. Returns the trimmed value, with surrounding
 * double or single quotes stripped when both are present.
 */
function extractYamlString(yaml: string, key: string): string | undefined {
  const m = yaml.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return undefined;
  let v = (m[1] ?? "").trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1);
    }
  }
  return v.length === 0 ? undefined : v;
}

/**
 * Minimal YAML list parser: accepts inline `[a, b, c]` and bare `a, b, c`.
 */
function extractYamlList(yaml: string, key: string): string[] | undefined {
  const m = yaml.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return undefined;
  const raw = (m[1] ?? "").trim();
  let inner = raw;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  const parts = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

/**
 * Parse an agent markdown file: YAML frontmatter (name / description / model / tools)
 * plus the body, returned as the system prompt. Tolerates a missing or partial
 * frontmatter; the caller falls back to defaults when this returns null.
 */
export function parseAgentMarkdown(content: string): {
  name: string;
  description?: string;
  model?: string;
  tools?: readonly string[];
  systemPrompt: string;
} | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";
  const name = extractYamlString(frontmatter, "name");
  if (!name) return null;
  const description = extractYamlString(frontmatter, "description") ?? "";
  const model = extractYamlString(frontmatter, "model") ?? "";
  const tools = extractYamlList(frontmatter, "tools");
  const out: {
    name: string;
    description?: string;
    model?: string;
    tools?: readonly string[];
    systemPrompt: string;
  } = {
    name,
    systemPrompt: body.trim(),
  };
  if (description !== undefined) out.description = description;
  if (model !== undefined) out.model = model;
  if (tools !== undefined) out.tools = tools;
  return out;
}

/**
 * Discover an agent by name. Mirrors pi's subagent extension agentScope behaviour:
 * user-level (`~/.pi/agent/agents/`) is loaded by default; project-level
 * (`<cwd>/.pi/agents/`) is loaded only when agentScope includes it.
 */
export function discoverAgent(
  name: string,
  cwd: string,
  agentScope: "user" | "project" | "both",
): AgentConfigLike | null {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  type Candidate = { path: string; source: "user" | "project" };
  const candidates: Candidate[] = [];
  if (agentScope === "user" || agentScope === "both") {
    candidates.push({ path: path.join(userDir, name + ".md"), source: "user" });
  }
  if (agentScope === "project" || agentScope === "both") {
    candidates.push({ path: path.join(projectDir, name + ".md"), source: "project" });
  }
  for (const c of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(c.path, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseAgentMarkdown(raw);
    if (parsed && parsed.name === name) {
      const out: AgentConfigLike = {
        name: parsed.name,
        source: c.source,
        systemPrompt: parsed.systemPrompt,
      };
      if (parsed.model !== undefined) (out as { model?: string }).model = parsed.model;
      if (parsed.tools !== undefined) (out as { tools?: readonly string[] }).tools = parsed.tools;
      return out;
    }
  }
  return null;
}

/**
 * Build the argv handed to the child pi subprocess. Model / thinking / tools / agentScope
 * precedence: dispatch input (call site) > agent markdown frontmatter > nothing.
 * The agent's system prompt (with the depth hint appended) is materialised to a tmpfile
 * and passed via --append-system-prompt, exactly as the subagent extension does.
 */
export function buildArgv(
  input: DispatchInput,
  agent: AgentConfigLike,
  promptFilePath: string,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const model = input.model ?? agent.model;
  if (model) args.push("--model", model);
  /*
   * Default to --thinking off: a dispatched child is a tool call, not a long-form reasoning
   * task. Thinking blocks the model from emitting text for many seconds; the parent turn keeps
   * its own thinking settings, the child inherits only what the parent's DispatchInput.
   * thinkingLevel says (and defaults to "off" otherwise).
   */
  const thinking = input.thinkingLevel ?? "off";

  args.push("--thinking", thinking);
  // Note: agentScope is honoured at our layer via discoverAgent(); pi itself does not
  // accept an --agent-scope flag (the subagent extension does not pass one either), and
  // in --no-session mode pi loads user-scope agents from ~/.pi/agent/agents by default.
  // Project agents would need a different mechanism (e.g. PI_CODING_AGENT_DIR override).
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }
  args.push("--append-system-prompt", promptFilePath);
  args.push("Task: " + input.task);
  return args;
}

/**
 * Write the system prompt (with depth hint appended) to a tmpfile. The caller is
 * responsible for cleanup; we use mkdtemp + 0o600 to keep the prompt private, then
 * best-effort cleanup in the dispatch() Promise.
 */
async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dispatch-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, "prompt-" + safeName + ".md");
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

/**
 * Best-effort cleanup of the tmpfile + dir used for the system prompt. Errors are
 * deliberately swallowed: leaving a tmpfile around is preferable to crashing the run.
 */
function cleanupTmp(tmp: { dir: string; filePath: string }): void {
  try {
    fs.unlinkSync(tmp.filePath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(tmp.dir);
  } catch {
    /* ignore */
  }
}

/**
 * Spawn one pi subprocess for one dispatch and resolve with a DispatchResult.
 *
 * Behavioural contract (ADR-0016 sections 1, 3, 4):
 *   - Resolves with status: fulfilled when the child exits 0 and emits at least one
 *     assistant message whose text is non-empty.
 *   - Resolves with status: rejected on non-zero exit, signal kill, spawn failure,
 *     unknown agent, or no usable final text.
 *   - Never rejects. The caller can pattern-match on outcome.status the same way
 *     it would pattern-match a Promise.allSettled record.
 *   - Honours signal with SIGTERM, then SIGKILL after a 5s grace window.
 */
export async function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  // ADR-0016 Recursive dispatch: bound recursion explicitly.
  const childDepth = ctx.depth + 1;
  if (childDepth > ctx.maxDispatchDepth) {
    return dispatchDepthLimitReached();
  }

  const cwd = input.cwd ?? ctx.cwd;
  const agentScope = input.agentScope ?? "user";
  const start = Date.now();

  const agent = discoverAgent(input.agent, cwd, agentScope);
  if (!agent) {
    return {
      text: "",
      status: "rejected",
      started: false,
      agentName: input.agent,
      durationMs: Date.now() - start,
      exitCode: 1,
      errorMessage:
        "unknown agent: " + input.agent + " (agentScope=" + agentScope + ", cwd=" + cwd + ")",
    };
  }

  const fullPrompt = appendDepthHint(agent.systemPrompt, childDepth, ctx.maxDispatchDepth);
  const tmp = await writePromptToTempFile(agent.name, fullPrompt);

  const argv = buildArgv(input, agent, tmp.filePath);

  return await new Promise<DispatchResult>((resolve) => {
    let finalText = "";
    let usage: DispatchUsage | undefined;
    let exitCode = -1;
    let stderrText = "";
    let resolved = false;
    let killTimer: NodeJS.Timeout | undefined;
    let handle: ChildHandle | undefined;
    let aborted = false;

    const finalize = (
      status: "fulfilled" | "rejected",
      errorMessage?: string,
      started = true,
    ): void => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      cleanupTmp(tmp);
      const out: DispatchResult = {
        text: finalText,
        status,
        started,
        agentName: agent.name,
        durationMs: Date.now() - start,
        exitCode,
      };
      if (usage) out.usage = usage;
      if (stderrText.length > 0) out.stderr = stderrText;
      if (errorMessage) out.errorMessage = errorMessage;
      resolve(out);
    };

    const onAbort = (): void => {
      if (!handle || resolved) return;
      aborted = true;
      DISPATCH_LIFECYCLE.kill(handle, "SIGTERM");
      killTimer = setTimeout(() => {
        // The lifecycle adapter's kill() absorbs "process already gone" throws via
        // safeKill, so we don't need to gate on `proc.killed` here any more — the
        // adapter does the right thing either way.
        if (handle && !resolved) DISPATCH_LIFECYCLE.kill(handle, "SIGKILL");
      }, 5000);
    };

    // Hand the spawn to the lifecycle adapter (BG-03). The adapter wires stdout /
    // stderr pipes, JSONL parsing, and the close / error event handlers; this function
    // is left to accumulate usage / finalText and decide the close outcome.
    try {
      handle = DISPATCH_LIFECYCLE.spawn(
        // argv[0] is the command per the ChildProcessLifecycle contract; the rest are
        // forwarded verbatim. PI_COMMAND stays "pi" — see the constant's doc for why
        // we don't reuse process.execPath.
        [PI_COMMAND, ...argv],
        {
          cwd,
          // ADR-0016 Recursive section: the child run's depth baseline travels in the
          // environment so the pi-ptc extension loaded inside the child starts its PTC
          // runs at childDepth instead of at 0; the rest of the environment is inherited
          // from the host (the child needs the same PATH and provider config as pi itself).
          env: { ...process.env, PI_PTC_DEPTH: String(childDepth) },
          promptFile: tmp.filePath,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finalize("rejected", "failed to spawn pi: " + message, false);
      return;
    }

    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Drain the adapter's event stream and finalize the result. We run this async
    // work inside the Promise body so `resolve` (and therefore `finalize`) can fire
    // synchronously on the abort path while the iterator is still parked.
    void (async () => {
      if (!handle) return;
      const h = handle;
      try {
        for await (const ev of DISPATCH_LIFECYCLE.events(h)) {
          if (ev.type === "message_end" && ev.message && ev.message.role === "assistant") {
            const m = ev.message;
            if (m.usage) {
              const cur: DispatchUsage = usage ?? {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                turns: 0,
              };
              cur.input += m.usage.input ?? 0;
              cur.output += m.usage.output ?? 0;
              cur.cacheRead += m.usage.cacheRead ?? 0;
              cur.cacheWrite += m.usage.cacheWrite ?? 0;
              cur.cost += m.usage.cost?.total ?? 0;
              cur.turns += 1;
              usage = cur;
            }
            if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part && part.type === "text" && typeof part.text === "string") {
                  finalText = part.text;
                }
              }
            }
          }
        }

        // Events iterator ended — child has closed.
        const exitVal: ChildExitValue = await DISPATCH_LIFECYCLE.exit(h);
        exitCode = exitVal.code ?? -1;
        stderrText = await DISPATCH_LIFECYCLE.stderr(h);

        // A failed spawn (ENOENT and friends) never brought a child up, so it is a
        // refusal like the depth and concurrency gates — `started: false` is what
        // keeps it out of the sub-call tree's `error` bucket. The adapter marks the
        // stderr with `[spawn-error] <message>` (same convention as the pre-BG-03
        // dispatch code).
        const spawnErrMatch = stderrText.match(/^\[spawn-error\] (.+)$/m);
        if (spawnErrMatch && exitVal.code === null && exitVal.signal === null) {
          finalize("rejected", "failed to spawn pi: " + spawnErrMatch[1], false);
          return;
        }

        const { status, errorMessage } = decideCloseOutcome({ exitCode, finalText, aborted });
        finalize(status, errorMessage);
      } catch (err) {
        // The lifecycle adapter's events() / exit() / stderr() do not throw under
        // normal operation; if something unexpected happens, surface it as a rejected
        // result rather than hanging the dispatch Promise.
        const message = err instanceof Error ? err.message : String(err);
        finalize("rejected", "dispatch internal error: " + message);
      }
    })();
  });
}
