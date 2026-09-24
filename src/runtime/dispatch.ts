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
  createULID,
  type ChildExitValue,
  type ChildHandle,
  type ChildProcessLifecycle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "./child-process-lifecycle.ts";
import { DEFAULT_CONFIG } from "./limits.ts";
import {
  DefaultTaskRegistry,
  OUTPUT_PREVIEW_MAX_BYTES,
  type DispatchHandle,
  type RegistryLogger,
  type TaskRegistry,
} from "./task-registry.ts";
import type { OutputStorage } from "./output-storage.ts";
import { InMemoryTaskStorage, type TaskSpawnSource, type ULID } from "./task-storage.ts";

// Re-exports keep existing imports working after BG-03 moved these definitions.
// `tests/dispatch-helpers.test.ts` imports `parseAgentEvent` / `safeKill` from this
// module; rather than churn the test file, we re-export them.
export { parseAgentEvent, safeKill } from "./child-process-lifecycle.ts";

/**
 * Shared lifecycle adapter for the foreground `pi.dispatch` path. BG-03 extracted the
 * spawn / kill / JSONL-parse / exit-wait dance into a typed seam so the background
 * dispatch (ADR-0022) can drive the same handles from a different caller. The foreground
 * path is mocked through `node:child_process` (which `RealChildProcessLifecycle` calls
 * into); the background path can swap the adapter per call through
 * {@link DispatchDeps.lifecycle}.
 */
const DISPATCH_LIFECYCLE: ChildProcessLifecycle = new RealChildProcessLifecycle();

/**
 * Per-run in-flight `pi.dispatch` counter (ADR-0016 §2 + ADR-0022 §9). The dispatcher's
 * foreground gate owns the canonical counter today; this class is the small exported seam
 * ADR-0022 §9 asks for so the background branch can hold a slot for a child's whole
 * lifetime and release it only on the terminal transition — a background task keeps
 * counting against `dispatchConcurrency` after `dispatch()` has already returned. The
 * dispatcher can adopt this type without a behaviour change.
 */
export class DispatchSlotCounter {
  readonly limit: number;
  #active: number;
  /**
   * Tokens currently holding a slot. Only keyed acquires are tracked here; the dispatcher's
   * foreground per-call gate keeps using the anonymous form. A token makes acquire/release
   * idempotent PER TASK, which is what stops a late pump release from freeing a different
   * live task's slot after `shutdown` already released the reclaimed task.
   */
  readonly #holders = new Set<string>();

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError(
        `DispatchSlotCounter: limit must be a non-negative integer, got ${String(limit)}`,
      );
    }
    this.limit = limit;
    this.#active = 0;
  }

  /** Number of slots currently held. */
  get active(): number {
    return this.#active;
  }

  /** Reserve one in-flight slot (optionally keyed by a per-task holder token); `false` means the cap is reached (hard reject, no queue). */
  tryAcquire(holder?: string): boolean {
    if (holder !== undefined && this.#holders.has(holder)) return false;
    if (this.#active >= this.limit) return false;
    if (holder !== undefined) this.#holders.add(holder);
    this.#active += 1;
    return true;
  }

  /**
   * Release one slot; per-token idempotent (a late release for the same task is a no-op) and
   * never negative. An anonymous release only frees an anonymous reservation.
   */
  release(holder?: string): void {
    if (holder !== undefined) {
      if (!this.#holders.delete(holder)) return;
      this.#active -= 1;
      return;
    }
    if (this.#active > this.#holders.size) this.#active -= 1;
  }
}

/**
 * Fallback counter for a background dispatch that was not handed the dispatcher's per-run
 * counter. It keeps ADR-0022 §9's cap in force (default `dispatchConcurrency` = 8) instead
 * of silently skipping it; production wires the per-run counter through
 * {@link DispatchDeps.slots}.
 */
const FALLBACK_DISPATCH_SLOTS: DispatchSlotCounter = new DispatchSlotCounter(
  DEFAULT_CONFIG.dispatchConcurrency,
);

/**
 * Injected dependencies for the background branch. The foreground path ignores this object
 * entirely (it uses the module-level {@link DISPATCH_LIFECYCLE}); every field is optional so
 * existing zero-argument call sites keep working. Tests pass an in-memory registry and a
 * mock lifecycle so no real `pi` process is ever spawned.
 */
export interface DispatchDeps {
  /** Session-level TaskRegistry (ADR-0022 §3). Defaults to a lazy in-memory registry. */
  taskRegistry?: TaskRegistry;
  /** Child lifecycle for the background spawn. Defaults to the shared real adapter. */
  lifecycle?: ChildProcessLifecycle;
  /** Per-run in-flight counter shared with the dispatcher's foreground gate (ADR-0022 §9). */
  slots?: DispatchSlotCounter;
  /** Time source for TaskRecord stamps. Defaults to `Date.now`. */
  clock?: () => number;
  /** Logger for the background pump's failure path. Defaults to a `console.warn` logger. */
  logger?: RegistryLogger;
  /**
   * ADR-0022 §3: where the pump persists a task's drained stdout. When present, the terminal
   * transition records `outputRef` / `outputBytes` / `outputPreview` so `ptc_task_output`
   * can dereference the bytes (BG-07).
   */
  outputStorage?: OutputStorage;
}

/**
 * Lazy session-level fallback registry for background dispatches that were not handed one.
 * Production passes the session registry through {@link DispatchDeps.taskRegistry}; the
 * fallback exists so a direct `dispatch(..., { background: true })` call without DI still
 * registers and advances a task instead of dropping it (ADR-0022 §3, "no silent failure").
 */
let fallbackTaskRegistry: DefaultTaskRegistry | undefined;

function resolveTaskRegistry(deps: DispatchDeps, clock: () => number): TaskRegistry {
  if (deps.taskRegistry !== undefined) return deps.taskRegistry;
  fallbackTaskRegistry ??= new DefaultTaskRegistry(new InMemoryTaskStorage(), { clock });
  return fallbackTaskRegistry;
}

/** Default pump logger: surface a background lifecycle failure instead of swallowing it. */
const DEFAULT_DISPATCH_LOGGER: RegistryLogger = {
  info: (): void => undefined,
  warn: (msg: string): void => {
    console.warn("[pi.dispatch] " + msg);
  },
};

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
  /**
   * ADR-0022 §1: long-lived background spawn. When `true`, {@link dispatch} returns a
   * {@link DispatchHandle} immediately and a detached pump drives the child's TaskRecord
   * lifecycle; every other call keeps the ADR-0016 `DispatchResult` semantics.
   */
  background?: boolean;
  /**
   * ADR-0022 §1: human label carried by the handle and the TaskRecord. Defaults to the
   * task text truncated to 64 characters.
   */
  label?: string;
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
  /**
   * ADR-0022 R1: dedicated session directory for background children. When set, the three
   * R1 session flags travel through {@link ChildSpawnOptions}; when absent, the spawn keeps
   * the foreground shape (no session flags).
   */
  sessionDir?: string;
  /**
   * ADR-0022 §5: the TaskRecord owner, which is also the subscription subscriber
   * ("Subscriber == owner"). Defaults to `dispatch:<callId>`.
   */
  callerId?: string;
  /**
   * ADR-0022 §3: parent background task id when this spawn is itself a background child,
   * so the session registry can reconstruct the task tree.
   */
  parentTaskId?: ULID;
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
 * Grace window between SIGTERM and SIGKILL for every kill site (ADR-0022 §8). The foreground
 * abort path introduced the literal 5000ms; the background stop watcher and the background
 * failure-path reap reuse this one constant so there is a single ladder, not a second number.
 */
export const DISPATCH_KILL_GRACE_MS = 5000;

/**
 * Send SIGTERM to `handle`, schedule SIGKILL after {@link DISPATCH_KILL_GRACE_MS}, and return a
 * function that cancels a pending escalation. `isDone` is checked when the escalation fires, so
 * a child that closed in the meantime is never signalled again; `unref` keeps a detached
 * escalation from holding the host process open.
 */
export function killWithEscalation(
  lifecycle: ChildProcessLifecycle,
  handle: ChildHandle,
  options: { isDone?: () => boolean; unref?: boolean } = {},
): () => void {
  lifecycle.kill(handle, "SIGTERM");
  const timer = setTimeout(() => {
    if (options.isDone?.() === true) return;
    lifecycle.kill(handle, "SIGKILL");
  }, DISPATCH_KILL_GRACE_MS);
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Background-specific refusal copy (issue #68 part 4 / wayfinder T4.4): a refused *background*
 * spawn points the model at the management surface, exactly as ADR-0022 §3 expects it to inspect
 * and free in-flight tasks. The shared foreground helpers keep the ADR-0016 wording byte-for-byte.
 */
export const BACKGROUND_DEPTH_LIMIT_MESSAGE =
  "dispatch depth limit reached; next_step: call ptc_task_list to inspect the in-flight background tasks";

export const BACKGROUND_CONCURRENCY_LIMIT_MESSAGE =
  "dispatch concurrency limit reached; next_step: call ptc_task_list to inspect running tasks and ptc_task_stop to free a slot";

/** Background depth refusal: same machine fields as the foreground one, teaching copy added. */
export function backgroundDispatchDepthLimitReached(): DispatchResult {
  return { ...dispatchDepthLimitReached(), errorMessage: BACKGROUND_DEPTH_LIMIT_MESSAGE };
}

/** Background concurrency refusal: same machine fields, teaching copy added. */
export function backgroundDispatchConcurrencyLimitReached(): DispatchResult {
  return {
    ...dispatchConcurrencyLimitReached(),
    errorMessage: BACKGROUND_CONCURRENCY_LIMIT_MESSAGE,
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
 * Extract the assistant text from one child event, mirroring the foreground final-text rule
 * (`message_end` assistant text parts; the last part wins). The detached background pump
 * drains the child's stdout through this so a chatty child cannot back-pressure the spawn
 * turn, keeps the last text, and persists it through OutputStorage on the terminal
 * transition (ADR-0022 §3/§7).
 */
function assistantText(event: ParsedAgentEvent): string | undefined {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
  const content = event.message.content;
  if (!Array.isArray(content)) return undefined;
  let text: string | undefined;
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      text = part.text;
    }
  }
  return text;
}

/**
 * Background branch of {@link dispatch} (ADR-0022 §1/§3/§4/§9). It applies the same depth
 * and concurrency gates as the foreground path, spawns the child, registers a `running`
 * TaskRecord, starts a detached pump driving the terminal transition from the child's close
 * event, and returns the spawn-time {@link DispatchHandle} immediately.
 *
 * Pre-spawn refusals reuse the exact foreground shapes (`dispatchDepthLimitReached` /
 * `dispatchConcurrencyLimitReached` / the unknown-agent result) so the model and the
 * sub-call tree keep one vocabulary (ADR-0021 §6).
 */
async function dispatchBackground(
  input: DispatchInput,
  ctx: DispatchContext,
  deps: DispatchDeps,
): Promise<DispatchHandle | DispatchResult> {
  const childDepth = ctx.depth + 1;
  if (childDepth > ctx.maxDispatchDepth) {
    // Background refusal (issue #68 part 4): teach the model to inspect in-flight tasks.
    return backgroundDispatchDepthLimitReached();
  }
  // ADR-0022 §4/§9: mint the task id BEFORE acquiring its slot so the reservation is keyed by
  // the task that owns it. The pump and `shutdown` both release by this id; the release is
  // idempotent per task, so whichever runs second cannot free another live task's slot.
  const taskId = createULID();
  const slots = deps.slots ?? FALLBACK_DISPATCH_SLOTS;
  if (!slots.tryAcquire(taskId)) {
    return backgroundDispatchConcurrencyLimitReached();
  }

  const clock = deps.clock ?? ((): number => Date.now());
  const logger = deps.logger ?? DEFAULT_DISPATCH_LOGGER;
  const cwd = input.cwd ?? ctx.cwd;
  const agentScope = input.agentScope ?? "user";
  const lifecycle = deps.lifecycle ?? DISPATCH_LIFECYCLE;
  const callerId = ctx.callerId ?? "dispatch:" + String(ctx.callId);
  const registry = resolveTaskRegistry(deps, clock);
  const outputStorage = deps.outputStorage;

  let childHandle: ChildHandle | undefined;
  let tmp: { dir: string; filePath: string } | undefined;
  try {
    const agent = discoverAgent(input.agent, cwd, agentScope);
    if (!agent) {
      slots.release(taskId);
      return {
        text: "",
        status: "rejected",
        started: false,
        agentName: input.agent,
        durationMs: 0,
        exitCode: 1,
        errorMessage:
          "unknown agent: " + input.agent + " (agentScope=" + agentScope + ", cwd=" + cwd + ")",
      };
    }

    // The registry adopts the already-minted id as the TaskRecord id, so the handle the
    // program carries, the persisted record and the slot token all agree at creation.
    const label = input.label ?? input.task.slice(0, 64);
    const fullPrompt = appendDepthHint(agent.systemPrompt, childDepth, ctx.maxDispatchDepth);
    const written = await writePromptToTempFile(agent.name, fullPrompt);
    tmp = written;
    const argv = buildArgv(input, agent, written.filePath);

    const spawnOptions: ChildSpawnOptions = {
      cwd,
      // ADR-0016 Recursive section: the child run's depth baseline travels in the
      // environment so the pi-ptc extension loaded inside the child starts its PTC runs at
      // childDepth instead of at 0.
      // ADR-0016 Recursive section + issue #68 part 2: the child carries its own depth and its
      // own task id, so a nested background dispatch can stamp TaskRecord.parentTaskId.
      env: { ...process.env, PI_PTC_DEPTH: String(childDepth), PI_PTC_TASK_ID: taskId },
      promptFile: written.filePath,
    };
    // R1 session-file flags travel through the lifecycle options. When no sessionDir is
    // available the options keep the foreground shape (none of the three fields set).
    if (ctx.sessionDir !== undefined) {
      spawnOptions.sessionDir = ctx.sessionDir;
      spawnOptions.sessionId = taskId;
      spawnOptions.sessionName = "bgdispatch:" + taskId;
    }

    childHandle = lifecycle.spawn([PI_COMMAND, ...argv], spawnOptions);
    const handle: ChildHandle = childHandle;

    const spawnSource: TaskSpawnSource = { kind: "ptc-program", callerId };
    await registry.transition(
      {
        kind: "spawn",
        handle: { taskId, label, status: "running" },
        record: {
          label,
          agentName: agent.name,
          depth: childDepth,
          startedAt: Math.max(0, Math.floor(clock())),
          finishedAt: undefined,
          durationMs: undefined,
          outputRef: undefined,
          outputBytes: undefined,
          outputPreview: undefined,
          stopReason: undefined,
          errorMessage: undefined,
          exitCode: undefined,
          spawnSource,
          parentTaskId: ctx.parentTaskId,
          // ADR-0022 §3 (v1, R-m12): `sessionFile` is left UNSET. The extension cannot know
          // pi's session-file path, and a fabricated value would be worse than an absent one;
          // a future reader that can learn it may fill the field in.
        },
      },
      { clock, callerId, logger },
    );

    // Stop watcher (ADR-0022 §8, issue #68 §1): the tool only writes running -> stopping; the
    // pump owns the signal. Subscribe right after the spawn is persisted and deliver SIGTERM to
    // the live child, escalating to SIGKILL after the shared grace window.
    let childExited = false;
    let cancelStopEscalation: (() => void) | undefined;
    const unsubscribeStopObserver = registry.onTransition((record, event) => {
      if (record.id !== taskId || event.status !== "stopping") return;
      // A stop that arrives after the child closed is a no-op (no signal, no double kill).
      if (childExited || cancelStopEscalation !== undefined) return;
      cancelStopEscalation = killWithEscalation(lifecycle, handle, {
        isDone: () => childExited,
        unref: true,
      });
    });

    // Detached pump (ADR-0022 §2/§3/§8): drain the child's stdout so it cannot back-pressure,
    // persist it through the OutputStorage seam, then resolve the terminal state from the close
    // event. The terminal decision lives in the registry so a stop that lands between the close
    // and the write still wins (R-M1). It is deliberately not awaited, so the spawn turn returns
    // the handle at once.
    void (async (): Promise<void> => {
      let output = "";
      try {
        for await (const event of lifecycle.events(handle)) {
          const text = assistantText(event);
          if (text !== undefined) output = text;
        }
        // The child has closed: no further signal may be delivered, and a pending escalation is
        // cleared before it can fire against a reaped handle (issue #68 §1).
        childExited = true;
        cancelStopEscalation?.();

        const exitValue: ChildExitValue = await lifecycle.exit(handle);
        const exitCode = exitValue.code ?? -1;

        // ADR-0022 §3/§7: project the drained bytes onto the record and persist the raw text
        // so ptc_task_output can dereference outputRef. The preview is inlined only at or
        // below the 2048-byte Map+preview ceiling (OUTPUT_PREVIEW_MAX_BYTES).
        const outputBytes = Buffer.byteLength(output, "utf8");
        const outputPreview = outputBytes <= OUTPUT_PREVIEW_MAX_BYTES ? output : undefined;
        let outputRef: string | undefined;
        if (outputStorage !== undefined) {
          try {
            await outputStorage.writeOutput(taskId, output);
            outputRef = outputStorage.outputRef(taskId);
          } catch (persistError) {
            // Never let a persistence failure swallow the terminal state (testing-constraints
            // #3): surface it and still write the record.
            const persistMessage =
              persistError instanceof Error ? persistError.message : String(persistError);
            logger.warn(
              "background dispatch output persistence for task " +
                taskId +
                " failed: " +
                persistMessage,
            );
          }
        }

        // ADR-0022 §8 signal layering / R-M1: the registry resolves the terminal state under its
        // write lock — a model stop already at `stopping` wins and resolves `canceled`, while
        // a running child resolves from the exit code. No read-then-write race in the pump.
        await registry.transition(
          { kind: "resolve-exit", taskId, exitCode, outputRef, outputBytes, outputPreview },
          { clock, callerId, logger },
        );
      } catch (err) {
        // A pump failure must not vanish. A task already driven terminal by a model stop
        // lands here on the illegal running -> terminal edge; log it so it is observable.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          "background dispatch pump for task " +
            taskId +
            " failed after " +
            String(output.length) +
            " chars of buffered output: " +
            message,
        );
      } finally {
        unsubscribeStopObserver();
        cancelStopEscalation?.();
        cleanupTmp(written);
        // Release the task's own token; `shutdown` may already have released it (no-op then).
        slots.release(taskId);
      }
    })();

    return { taskId, label, status: "running" };
  } catch (err) {
    // Spawn / registration / IO failure: release the slot, reap a child that did come up,
    // and keep the ADR-0016 "never throws" contract with a rejected DispatchResult.
    const message = err instanceof Error ? err.message : String(err);
    if (childHandle !== undefined) {
      // R-M5: the failure-path reap shares the SIGTERM -> grace -> SIGKILL ladder with the
      // foreground abort and the stop watcher; unref keeps the detached escalation off the
      // host's event loop.
      killWithEscalation(lifecycle, childHandle, { unref: true });
    }
    if (tmp !== undefined) cleanupTmp(tmp);
    slots.release(taskId);
    logger.warn("background dispatch failed for agent " + input.agent + ": " + message);
    return {
      text: "",
      status: "rejected",
      started: childHandle !== undefined,
      agentName: input.agent,
      durationMs: 0,
      exitCode: -1,
      errorMessage: "background dispatch failed: " + message,
    };
  }
}

/**
 * Spawn one pi subprocess for one dispatch.
 *
 * Behavioural contract (ADR-0016 sections 1, 3, 4) for the foreground path, and ADR-0022
 * for the `{ background: true }` path:
 *   - Foreground (`input.background !== true`) resolves with a {@link DispatchResult}:
 *     `fulfilled` when the child exits 0 with assistant text; `rejected` on non-zero
 *     exit, signal kill, spawn failure, unknown agent, or no usable final text.
 *   - Background (`input.background === true`) resolves with a {@link DispatchHandle}
 *     immediately after the child and its `running` TaskRecord are registered; a detached
 *     pump drives the terminal transition. The pre-spawn refusals (depth gate, concurrency
 *     gate, unknown agent) still resolve with the foreground {@link DispatchResult}
 *     rejection shapes, which is why the overload below returns a union.
 *   - Never rejects. The caller can pattern-match on `status` the same way it would
 *     pattern-match a Promise.allSettled record.
 *   - Honours signal with SIGTERM, then SIGKILL after a 5s grace window (foreground).
 *
 * The overloads narrow by `input.background`: a literal `{ background: true }` yields the
 * handle-or-refusal union; every other call keeps the plain `DispatchResult` of ADR-0016.
 */
export function dispatch(
  input: Omit<DispatchInput, "background"> & { background: true },
  ctx: DispatchContext,
  deps?: DispatchDeps,
): Promise<DispatchHandle | DispatchResult>;
export function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
  deps?: DispatchDeps,
): Promise<DispatchResult>;
export async function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
  deps: DispatchDeps = {},
): Promise<DispatchResult | DispatchHandle> {
  // ADR-0022 §1: the background opt switches the binding's tail. Pre-spawn refusals reuse
  // the foreground shapes, so the union stays even for a statically-background call.
  if (input.background === true) {
    return await dispatchBackground(input, ctx, deps);
  }

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
    let cancelKillEscalation: (() => void) | undefined;
    let handle: ChildHandle | undefined;
    let aborted = false;

    const finalize = (
      status: "fulfilled" | "rejected",
      errorMessage?: string,
      started = true,
    ): void => {
      if (resolved) return;
      resolved = true;
      cancelKillEscalation?.();
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
      // ADR-0016 §4: SIGTERM, then SIGKILL after the shared grace window. The lifecycle
      // adapter's kill() absorbs "process already gone" throws via safeKill, so the escalation
      // is safe to schedule unconditionally; `isDone` stops it after finalize clears it.
      cancelKillEscalation = killWithEscalation(DISPATCH_LIFECYCLE, handle, {
        isDone: () => resolved,
      });
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
