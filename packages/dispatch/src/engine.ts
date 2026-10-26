import { spawnChild as defaultSpawn, buildPiArgv } from "./child-process.ts";
import { extractReportFromText, type ChildReport, type ReportChannel } from "./report.ts";
import { parseChildStream } from "./jsonl.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isTerminal as isTerminalRecord, type TaskRecord } from "./task-record.ts";
import type { AgentDefinition } from "./agent-discovery.ts";
import type { DispatchInput, Gate, TaskRejection } from "./gates.ts";
import { rejection } from "./gates.ts";
import type { OutputStorage } from "./output-storage.ts";
import { InMemoryOutputStorage } from "./output-storage.ts";
import type { TaskRegistry } from "./registry.ts";
import { DispatchSlotCounter } from "./slots.ts";
import { createTaskId } from "./task-id.ts";

export type TaskHandle = {
  taskId: string;
  label?: string;
  status: "queued" | "running";
  whySuppressed?: boolean;
};

// HTML 第七节字段表对齐：status/text/started/agentName/durationMs/exitCode/usage/report/observed*/errorMessage/readOnlyTier/whySuppressed/taskId/label
export type DispatchResult = {
  status: "fulfilled" | "rejected" | "canceled";
  taskId: string;
  label?: string;
  text: string;
  exitCode: number;
  /** 孩子到底有没有被起起来（取消/拒绝时是 false） */
  started: boolean;
  /** 实际用的 agent；通用孩子 = "generalist" */
  agentName: string;
  /** finishedAt - startedAt（ms）；未起或缺时间戳时 0 */
  durationMs: number;
  /** 孩子自报或宿主观测的用量（观测值兜底） */
  usage?: ChildReport["usage"];
  /** ADR-0045：流里实测到的孩子模型/provider */
  observedModel?: string;
  observedProvider?: string;
  /** status != fulfilled 时给出原因 */
  errorMessage?: string;
  /** 实际生效的只读档位（未指定 = "lenient" 语义：不收窄） */
  readOnlyTier: "strict" | "lenient";
  outputPath: string;
  whySuppressed?: boolean;
  /** ADR-0032：报告与通道；没交报告时缺省、channel = none（散文照交，不静默） */
  report?: ChildReport;
  reportChannel: ReportChannel;
};

export type DispatchOutcome = TaskHandle | TaskRejection | DispatchResult;
export type CreateTaskResult = DispatchOutcome;

export type ChildHandle = {
  pid: number;
  onOutput(callback: (chunk: string) => void): void;
  onExit(callback: (exitCode: number, stderr: string) => void): void;
  kill(signal: NodeJS.Signals): void;
};

export type SpawnChild = (argv: string[], env: NodeJS.ProcessEnv) => ChildHandle;

interface RunExtras {
  childReport: boolean;
  agentTools?: string[];
  agentModel?: string;
  agentThinkingLevel?: string;
}

export type BuildArgvInput = DispatchInput & {
  taskId: string;
  childReport?: boolean;
  agentTools?: string[];
  searchEnabled?: boolean;
  agentModel?: string;
  agentThinkingLevel?: string;
};

export interface EngineOptions {
  registry: TaskRegistry;
  slots?: DispatchSlotCounter;
  output?: OutputStorage;
  spawnChild?: SpawnChild;
  gates?: Gate[];
  buildArgv?: (input: BuildArgvInput, context: EngineContext) => string[];
  stopGraceMs?: number;
  /** ADR-0039：agent 发现（缺省：不存在任何定义——只认省略） */
  resolveAgent?: (name: string, scope?: "user" | "project" | "both") => AgentDefinition | null;
  /** 让子代理进程加载本扩展（-e 路径），工具通道的前提 */
  childExtensionPath?: string;
  /** ADR-0049：搜索开关——strict 白名单据此保留 web_ds_search */
  searchEnabled?: boolean;
  /** BG-01：TaskRecord 落盘目录（<cwd>/.pi/ptc-tasks）；设了才有重启恢复 */
  storageDir?: string;
  /** ADR-0022/0053：通知中心——wait 路径记 awaited，终态不重复通知 */
  notifications?: { markAwaited(taskId: string): void };
  /** ADR-0043：whyEnabled 默认开；关掉时丢弃 why 并记 whySuppressed——剥夺类开关 fail-open（坏值视为开）。
   * 谓词非值：/ptc why 的会话级覆盖要热生效，值会在装配时被冻住（同 ADR-0065 sessionEnding 的教训） */
  whyEnabled?: boolean | (() => boolean);
}

export interface EngineContext {
  depth: number;
  sessionModel?: string;
}

const DEFAULT_STOP_GRACE_MS = 5_000;

// 决策 17：AbortSignal → Promise（已 abort 立即兑现）
function aborts(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// ADR-0023：kill(pid, 0) 探活——ESRCH 死、EPERM 活（别人进程但存在）
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 任务引擎：闸 → 建记录 → 槽 → spawn → pump → resolve-exit。不等路径 fire-and-forget，wait 路径等终态
export class TaskEngine {
  readonly #registry: TaskRegistry;
  readonly #slots: DispatchSlotCounter;
  readonly #output: OutputStorage;
  readonly #spawn: SpawnChild;
  readonly #gates: Gate[];
  readonly #buildArgv: NonNullable<EngineOptions["buildArgv"]>;
  readonly #resolveAgent: (
    name: string,
    scope?: "user" | "project" | "both",
  ) => AgentDefinition | null;
  readonly #childExtensionPath?: string;
  readonly #searchEnabled: boolean;
  readonly #ready: Promise<void>;
  readonly #owner: { pid: number; bootMs: number };
  readonly #stopGraceMs: number;
  readonly #whyEnabled: () => boolean;
  readonly #notifications?: { markAwaited(taskId: string): void };
  readonly #context: EngineContext;
  readonly #children = new Map<string, ChildHandle>();
  #ending = false;
  #teardown = false;

  constructor(options: EngineOptions & { context?: EngineContext }) {
    this.#registry = options.registry;
    this.#slots = options.slots ?? new DispatchSlotCounter();
    this.#output = options.output ?? new InMemoryOutputStorage();
    this.#spawn = options.spawnChild ?? ((argv) => defaultSpawn(argv));
    this.#gates = options.gates ?? [];
    this.#buildArgv = options.buildArgv ?? ((input, context) => buildPiArgv(input, context));
    this.#resolveAgent = options.resolveAgent ?? (() => null);
    this.#childExtensionPath = options.childExtensionPath;
    this.#searchEnabled = options.searchEnabled ?? false;
    this.#owner = { pid: process.pid, bootMs: Date.now() };
    this.#ready = options.storageDir ? this.#restore(options.storageDir) : Promise.resolve();
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const whyOpt = options.whyEnabled;
    this.#whyEnabled =
      typeof whyOpt === "function" ? whyOpt : whyOpt === false ? () => false : () => true;
    this.#notifications = options.notifications;
    this.#context = options.context ?? { depth: 0 };
  }

  dispatch(rawInput: DispatchInput): Promise<DispatchOutcome> {
    return this.#ready.then(() => this.#dispatchReady(rawInput));
  }

  async #dispatchReady(rawInput: DispatchInput): Promise<DispatchOutcome> {
    if (this.#teardown) return rejection("session is ending：拆卸中不再收新的派发");
    for (const gate of this.#gates) {
      const rejected = gate(rawInput);
      if (rejected) return Promise.resolve(rejected); // 闸在铸 id 前：不留记录不占槽
    }
    // ADR-0043：开关关掉时在这里丢 why——record/handle/result 都带 whySuppressed，argv 里不再出现
    const whyEnabled = this.#whyEnabled();
    const whySuppressed = !whyEnabled && rawInput.why !== undefined;
    const input: DispatchInput = { ...rawInput, why: whyEnabled ? rawInput.why : undefined };
    // ADR-0032/0039：给了名字必须解析得出（闸门 5 已守）；frontmatter childReport:false → 契约缺席
    const agent =
      input.agent === undefined ? null : this.#resolveAgent(input.agent, input.agentScope);
    const extras = {
      childReport: agent?.childReport ?? true,
      agentTools: agent?.tools,
      agentModel: agent?.model,
      agentThinkingLevel: agent?.thinkingLevel,
    };
    const taskId = createTaskId();
    return this.#registry
      .submit({
        kind: "spawn",
        record: {
          id: taskId,
          status: "queued",
          task: input.task,
          label: input.label,
          whySuppressed,
          // ADR-0023 归属：记录盖 owner 戳，重启恢复按它判定「还在不在飞」
          ownerPid: this.#owner.pid,
          ownerBootMs: this.#owner.bootMs,
        },
      })
      .then(async () => {
        if (input.wait) {
          // ADR-0053：前台调用方等结果——终态不投递通知
          this.#notifications?.markAwaited(taskId);
          const acquired = this.#slots.acquire(taskId);
          // 决策 17：调用方 abort → 抽掉排队中的等待（已 granted 的不动，uv_cancel 的 EBUSY 语义）
          const outcome = input.signal
            ? await Promise.race([acquired, aborts(input.signal).then(() => "aborted" as const)])
            : await acquired;
          if (outcome === "aborted") {
            this.#slots.cancelQueued(taskId); // 等待者的 acquire 以 withdrawn resolve，无人消费
            await this.#registry.submit({
              kind: "cancel-queued",
              id: taskId,
              reason: "caller aborted",
            });
            return rejection("任务在排队中被调用方撤回（前台 abort，决策 17）");
          }
          if (outcome === "withdrawn") {
            await this.#registry.submit({
              kind: "cancel-queued",
              id: taskId,
              reason: "withdrawn while waiting",
            });
            return rejection("任务在排队中被抽掉");
          }
          return this.#runToTerminal(taskId, input, whySuppressed, extras);
        }
        // ADR-0055：不等槽——立刻返回 handle，granted 时才真起
        void this.#beginAfterAdmission(taskId, input, whySuppressed, extras);
        return { taskId, label: input.label, status: "queued" as const, whySuppressed };
      });
  }

  async #beginAfterAdmission(
    taskId: string,
    input: DispatchInput,
    whySuppressed = false,
    extras: RunExtras = { childReport: true },
  ): Promise<void> {
    const outcome = await this.#slots.acquire(taskId);
    if (outcome === "withdrawn") {
      await this.#registry.submit({ kind: "cancel-queued", id: taskId, reason: "withdrawn" });
      return;
    }
    void this.#runToTerminal(taskId, input, whySuppressed, extras);
  }

  async #runToTerminal(
    taskId: string,
    input: DispatchInput,
    whySuppressed = false,
    extras: RunExtras = { childReport: true },
  ): Promise<DispatchResult> {
    await this.#registry.submit({ kind: "transition", id: taskId, to: "running" });
    const argv = this.#buildArgv(
      { ...input, taskId, searchEnabled: this.#searchEnabled, ...extras },
      this.#context,
    );
    if (this.#childExtensionPath) argv.push("-e", this.#childExtensionPath);
    // R1 血缘：孩子知道自己 depth 与父任务 id（子代理进程内扩展行为的开关）
    const env = {
      ...process.env,
      PI_PTC_DEPTH: String(this.#context.depth + 1),
      PI_PTC_TASK_ID: taskId,
    };
    const child = this.#spawn(argv, env);
    this.#children.set(taskId, child);
    let text = "";
    child.onOutput((chunk) => {
      text += chunk;
    });
    const exitCode = await new Promise<number>((resolveExit) => {
      child.onExit((code) => resolveExit(code));
    });
    this.#children.delete(taskId);
    const outputPath = await this.#output.write(taskId, text);
    // ADR-0032：工具通道（--mode json 的 toolResult）优先；退 prompt 通道；opted-out 明说
    const parsed = parseChildStream(text);
    const finalText = parsed.text || text;
    let report: ChildReport | undefined;
    let channel: ReportChannel;
    if (!extras.childReport) {
      channel = "opted-out";
    } else if (parsed.toolReport) {
      report = parsed.toolReport;
      channel = "tool";
    } else {
      const extracted = extractReportFromText(finalText);
      report = extracted.report ?? undefined;
      channel = extracted.channel;
    }
    if (report && !report.usage && parsed.observedUsage)
      report = { ...report, usage: parsed.observedUsage };
    await this.#registry.submit({ kind: "attach-report", id: taskId, report, channel });
    // 产出路径挂回记录：lifecycle face 的 output 工具经此读正文
    await this.#registry.submit({ kind: "attach-output", id: taskId, outputPath });
    const result = await this.#registry.submit({ kind: "resolve-exit", id: taskId, exitCode });
    // 终态落库后才还槽。正常时释放即提拔最老等待者；拆卸中（ADR-0063）还槽不提拔——
    // 提拔起来的孩子会话已关没人收，是孤儿
    if (this.#teardown) this.#slots.releaseWithoutPromotion(taskId);
    else this.#slots.release(taskId);
    const status =
      result.record.status === "succeeded"
        ? "fulfilled"
        : result.record.status === "canceled"
          ? "canceled"
          : "rejected";
    const startedAt = result.record.startedAt ?? 0;
    const finishedAt = result.record.finishedAt ?? 0;
    return {
      status,
      taskId,
      label: input.label,
      text: finalText,
      exitCode,
      started: true,
      agentName: input.agent ?? "generalist",
      durationMs: startedAt && finishedAt ? finishedAt - startedAt : 0,
      usage: report?.usage ?? parsed.observedUsage ?? undefined,
      observedModel: parsed.observedModel ?? undefined,
      observedProvider: parsed.observedProvider ?? undefined,
      errorMessage:
        status === "fulfilled" ? undefined : (result.record.stopReason ?? `exit code ${exitCode}`),
      readOnlyTier: input.readOnly ?? "lenient",
      outputPath,
      whySuppressed,
      report: report ?? undefined,
      reportChannel: channel,
    };
  }

  // ADR-0057：先写终态记录、后抽队列（反序会留「槽空出时抽任务仍启动」的窗口）
  async stop(taskId: string, reason: string): Promise<void> {
    const canceled = await this.#registry.submit({ kind: "cancel-queued", id: taskId, reason });
    if (canceled.changed) {
      this.#slots.cancelQueued(taskId);
      return;
    }
    if (canceled.record.status !== "running") return;
    await this.#registry.submit({ kind: "stop", id: taskId, reason });
    const child = this.#children.get(taskId);
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.#children.has(taskId)) child.kill("SIGKILL");
    }, this.#stopGraceMs).unref();
  }

  isEnding(): boolean {
    return this.#ending;
  }

  /** 任务链读产出正文（lifecycle face 的 output 工具用） */
  readOutput(taskId: string): Promise<string | undefined> {
    return this.#output.read(taskId);
  }

  /** 产出字节数（不读全文——超长产出引导模型先读报告，真要读再 readOutput） */
  outputSize(taskId: string): Promise<number | undefined> {
    return this.#output.size(taskId);
  }

  /** 方案 A：只读尾部至多 maxBytes 字节（ADR-0015 偏尾语义；模型坚持要全文时的内存保险） */
  readOutputTail(taskId: string, maxBytes: number): Promise<string | undefined> {
    return this.#output.readTail(taskId, maxBytes);
  }

  // BG-01/ADR-0023：落盘（写穿）+ 重启恢复（装载 → owner 已死者 reconcile-lost）
  async #restore(storageDir: string): Promise<void> {
    const dir = join(storageDir, "records");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as TaskRecord;
          if (record && typeof record.id === "string") {
            await this.#registry.submit({ kind: "spawn", record }).catch(() => undefined); // 同 id 冲突跳过
          }
        } catch {
          // 单条坏记录不拖垮启动
        }
      }
    }
    this.#registry.subscribe((record) => this.#persist(storageDir, record));
    for (const record of this.#registry.list()) {
      if (isTerminalRecord(record.status)) continue;
      // 非终态记录：owner 已死（或无主）→ 上次会话没来得及收，标 lost
      if (record.ownerPid === undefined || !isPidAlive(record.ownerPid)) {
        await this.#registry
          .submit({ kind: "reconcile-lost", id: record.id, reason: "lost_on_session_restart" })
          .catch(() => undefined);
      }
      // owner 还活着 = 同机会话重叠，按 ADR-0023 只收自己 owner 的，别人的不动
    }
  }

  async #persist(storageDir: string, record: TaskRecord): Promise<void> {
    try {
      const dir = join(storageDir, "records");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${record.id}.json`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
      renameSync(tmp, path);
    } catch {
      // 落盘失败不阻塞任务流——记录仍在内存
    }
  }

  // ADR-0065/0063：会话结束——拒新（gate 读 isEnding）、抽干等待者、SIGTERM 在跑的孩子
  async shutdown(): Promise<void> {
    this.#ending = true;
    this.#teardown = true; // ADR-0063：拆卸后所有还槽不提拔；dispatch 拒绝新的
    const drained = this.#slots.drainWaiters();
    for (const taskId of drained) {
      await this.#registry.submit({
        kind: "cancel-queued",
        id: taskId,
        reason: "session shutdown",
      });
    }
    for (const [taskId, child] of this.#children) {
      await this.#registry.submit({ kind: "stop", id: taskId, reason: "session ended" });
      child.kill("SIGTERM");
    }
  }
}
