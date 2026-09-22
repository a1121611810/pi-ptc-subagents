/**
 * pi.dispatch: a parallel binding that spawns a fresh pi subprocess per call.
 *
 * ADR-0016 (2026-09-23) is the contract. This file is the type surface and the spawn
 * skeleton; the actual subprocess plumbing (agent-md resolution, JSON-line parser,
 * usage accumulator, signal propagation across worker_threads / child_process) is a
 * follow-up. The stubs here are typed against the contract so call sites can land
 * before the spawn path is finalised, and so a wrong shape is a compile error rather
 * than a runtime one.
 *
 * Behaviourally compatible with pi's examples/extensions/subagent/index.ts reference
 * (--mode json, -p, --no-session, --append-system-prompt <tmpfile>), but not cooperative:
 * does not require the user to install pi's subagent extension. See ADR-0016 section 2.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * The CLI command used to invoke a fresh pi subprocess for one dispatch.
 *
 * Always `"pi"` — pi-ptc is a library, not a CLI, and `dispatch` must spawn the
 * separate `pi` binary regardless of how the host process was launched. An earlier
 * copy of this function mirrored pi's own subagent extension and tried to reuse
 * `process.execPath + process.argv[1]`, which works only when the host is `pi`
 * itself; in any other host (test scripts, the dispatcher host process, etc.) the
 * function would spawn the host script in place of `pi`, producing infinite
 * recursion and a stdout pipe that never drains (so `proc.on('close')` never
 * fires). Resolved via direct `"pi"`; surfacing the `ENOENT` from `spawn` is the
 * caller's signal that pi is not on PATH.
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
  maxDepth: number;
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

/** Default error returned when the depth limit is exceeded. */
export function dispatchDepthLimitReached(currentDepth: number): DispatchResult {
  return {
    text: "",
    status: "rejected",
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    errorMessage:
      "dispatch depth limit reached (current depth " + currentDepth + ", max-depth exceeded)",
  };
}
/**
 * Resolve how to invoke `pi`.
 *
 * Always returns `{ command: "pi", args }`. Kept as a function for symmetry with
 * the upstream `runSingleAgent` reference and so the spawn site reads as
 * "invoke pi with these args" rather than "spawn command 'pi'".
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  return { command: PI_COMMAND, args };
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
  // Default to --thinking off: a dispatched child is a tool call, not a long-form reasoning

  // task. Thinking blocks the model from emitting text for many seconds; the parent

  // turn keeps its own thinking settings, the child inherits only what the parent's

  // DispatchInput.thinkingLevel says (and defaults to "off" otherwise).

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
 * One line of the child's stdout, parsed as JSON. The child emits the events described
 * in examples/extensions/subagent/index.ts (message_end, tool_result_end, error).
 * Anything unparseable is dropped: the line is one event the host cannot interpret, and
 * the run continues.
 */
interface ParsedAgentEvent {
  type: string;
  message?: {
    role?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  message_text?: string;
}

export function parseAgentEvent(line: string): ParsedAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as ParsedAgentEvent;
  } catch {
    return null;
  }
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
  if (childDepth > ctx.maxDepth) {
    return dispatchDepthLimitReached(ctx.depth);
  }

  const cwd = input.cwd ?? ctx.cwd;
  const agentScope = input.agentScope ?? "user";
  const start = Date.now();

  const agent = discoverAgent(input.agent, cwd, agentScope);
  if (!agent) {
    return {
      text: "",
      status: "rejected",
      agentName: input.agent,
      durationMs: Date.now() - start,
      exitCode: 1,
      errorMessage:
        "unknown agent: " + input.agent + " (agentScope=" + agentScope + ", cwd=" + cwd + ")",
    };
  }

  const fullPrompt = appendDepthHint(agent.systemPrompt, childDepth, ctx.maxDepth);
  const tmp = await writePromptToTempFile(agent.name, fullPrompt);

  const argv = buildArgv(input, agent, tmp.filePath);
  const invocation = getPiInvocation(argv);

  return await new Promise<DispatchResult>((resolve) => {
    let stdoutBuffer = "";
    let stderrBuf = "";
    let finalText = "";
    let usage: DispatchUsage | undefined;
    let exitCode = -1;
    let resolved = false;
    let killTimer: NodeJS.Timeout | undefined;
    let proc: ReturnType<typeof spawn> | undefined;

    const finalize = (status: "fulfilled" | "rejected", errorMessage?: string): void => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      cleanupTmp(tmp);
      const out: DispatchResult = {
        text: finalText,
        status,
        agentName: agent.name,
        durationMs: Date.now() - start,
        exitCode,
      };
      if (usage) out.usage = usage;
      if (stderrBuf.length > 0) out.stderr = stderrBuf;
      if (errorMessage) out.errorMessage = errorMessage;
      resolve(out);
    };

    const onAbort = (): void => {
      if (!proc || proc.killed || resolved) return;
      try {
        if (proc.pid !== undefined) proc.kill("SIGTERM");
      } catch {
        /* ignore: group already gone */
      }
      killTimer = setTimeout(() => {
        if (proc && !proc.killed) {
          try {
            if (proc.pid !== undefined) proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    };

    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finalize("rejected", "failed to spawn pi: " + message);
      return;
    }

    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    const stdout = proc.stdout;
    if (!stdout) return;
    stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf-8");
      let nl = stdoutBuffer.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        const ev = parseAgentEvent(line);
        if (!ev) {
          nl = stdoutBuffer.indexOf("\n");
          continue;
        }
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
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    const stderrStream = proc.stderr;
    if (!stderrStream) return;
    stderrStream.on("data", (data: Buffer) => {
      stderrBuf += data.toString("utf-8");
    });

    proc.on("close", (code) => {
      exitCode = code ?? -1;
      if (exitCode === 0 && finalText.length > 0) {
        finalize("fulfilled");
      } else if (exitCode === 0) {
        finalize("rejected", "dispatch produced no final text");
      } else {
        finalize("rejected");
      }
    });

    proc.on("error", (err) => {
      stderrBuf += "[spawn-error] " + err.message + "\n";
      finalize("rejected", "failed to spawn pi: " + err.message);
    });
  });
}
