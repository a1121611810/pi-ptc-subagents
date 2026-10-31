import { isTerminal, type TaskRecord, type TaskStatus } from "./task-record.ts";

// ADR-0010/0057：queued 入队即存在；终态没有出边
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "canceled", "lost"],
  running: ["stopping", "succeeded", "failed", "lost"],
  stopping: ["canceled", "failed", "lost"],
  succeeded: [],
  failed: [],
  canceled: [],
  lost: [],
};

export type TaskCommand =
  | { kind: "spawn"; record: TaskRecord }
  | { kind: "transition"; id: string; to: TaskStatus }
  | { kind: "stop"; id: string; reason: string }
  | { kind: "cancel-queued"; id: string; reason: string }
  | { kind: "resolve-exit"; id: string; exitCode: number }
  | { kind: "reconcile-lost"; id: string; reason: string }
  | {
      kind: "attach-report";
      id: string;
      report: TaskRecord["report"];
      channel: TaskRecord["reportChannel"];
      /** 孩子的真实交付轨迹——与报告同批挂上（引擎抽的，不是模型自述） */
      delivery?: TaskRecord["delivery"];
    }
  | {
      kind: "attach-output";
      id: string;
      outputPath: string;
      /** 审计 F2：stdout 超尾部上限被截断的事实，随产出路径一起挂记录 */
      truncated?: boolean;
    };

export interface CommandResult {
  record: TaskRecord;
  /** null = 无写入（spawn 插入）；非 null 但 changed=false = 判定拒绝写入（旧 ADR-0064 的竞态常态） */
  fromStatus: TaskStatus | null;
  changed: boolean;
}

// 旧 ADR-0022 §8 + 旧 ADR-0064：registry 是记录的唯一合法写入者，判定在写锁内做，命令不点名目标终态
export class TaskRegistry {
  readonly #records = new Map<string, TaskRecord>();
  #writeTail: Promise<unknown> = Promise.resolve();
  readonly #listeners: Array<(next: TaskRecord, prev: TaskRecord | null) => void>;

  constructor(listener?: (next: TaskRecord, prev: TaskRecord | null) => void) {
    this.#listeners = listener ? [listener] : [];
  }

  subscribe(listener: (next: TaskRecord, prev: TaskRecord | null) => void): void {
    this.#listeners.push(listener);
  }

  #emit(next: TaskRecord, prev: TaskRecord | null): void {
    for (const listener of this.#listeners) listener(next, prev);
  }

  get(id: string): TaskRecord | undefined {
    return this.#records.get(id);
  }

  list(): TaskRecord[] {
    return [...this.#records.values()];
  }

  /** 决策 29：终态痕迹容量边界——按 (finishedAt, taskId) 最老先出挤掉，返回被挤掉的 id；纯内存操作，删文件归引擎 */
  evictTerminal(keep: number): string[] {
    const terminal: TaskRecord[] = [];
    for (const record of this.#records.values()) {
      if (isTerminal(record.status)) terminal.push(record);
    }
    terminal.sort(
      (a, b) =>
        (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const evicted = terminal.slice(0, Math.max(0, terminal.length - keep));
    for (const record of evicted) this.#records.delete(record.id);
    return evicted.map((record) => record.id);
  }

  submit(command: TaskCommand): Promise<CommandResult> {
    const result: Promise<CommandResult> = this.#writeTail.then(() => this.#apply(command));
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #apply(command: TaskCommand): CommandResult {
    switch (command.kind) {
      case "spawn": {
        if (this.#records.has(command.record.id))
          throw new Error(`duplicate task id ${command.record.id}`);
        this.#records.set(command.record.id, command.record);
        this.#emit(command.record, null);
        return { record: command.record, fromStatus: null, changed: true };
      }
      case "transition":
        return this.#move(command.id, command.to, {});
      case "stop":
        return this.#move(command.id, "stopping", { stopReason: command.reason });
      case "cancel-queued": {
        // 旧 ADR-0064：写入器读当前状态——还是 queued 才 canceled，不是则原样返回、不写、不报错
        const current = this.#require(command.id);
        if (current.status !== "queued")
          return { record: current, fromStatus: current.status, changed: false };
        return this.#move(command.id, "canceled", { stopReason: command.reason });
      }
      case "resolve-exit": {
        const current = this.#require(command.id);
        if (current.status === "stopping") return this.#move(command.id, "canceled", {});
        if (current.status === "running") {
          return this.#move(command.id, command.exitCode === 0 ? "succeeded" : "failed", {});
        }
        return { record: current, fromStatus: current.status, changed: false };
      }
      case "reconcile-lost":
        return this.#move(command.id, "lost", { stopReason: command.reason });
      case "attach-report": {
        // 旧 ADR-0032 故事 15/16：报告随记录存活；终态上的迟到报告静默丢弃（竞态常态）
        const current = this.#require(command.id);
        if (isTerminal(current.status))
          return { record: current, fromStatus: current.status, changed: false };
        const next: TaskRecord = {
          ...current,
          report: command.report,
          reportChannel: command.channel,
          delivery: command.delivery ?? current.delivery,
        };
        this.#records.set(command.id, next);
        this.#emit(next, current);
        return { record: next, fromStatus: current.status, changed: true };
      }
      case "attach-output": {
        // 产出路径挂记录：任务链的「产出」锚点；终态上的迟到写入静默丢弃（同 attach-report）
        const current = this.#require(command.id);
        if (isTerminal(current.status))
          return { record: current, fromStatus: current.status, changed: false };
        const next: TaskRecord = {
          ...current,
          outputPath: command.outputPath,
          outputTruncated: command.truncated ?? false,
        };
        this.#records.set(command.id, next);
        this.#emit(next, current);
        return { record: next, fromStatus: current.status, changed: true };
      }
    }
  }

  #require(id: string): TaskRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`unknown task id ${id}`);
    return record;
  }

  #move(id: string, to: TaskStatus, patch: Partial<TaskRecord>): CommandResult {
    const current = this.#require(id);
    if (isTerminal(current.status))
      return { record: current, fromStatus: current.status, changed: false };
    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new Error(`illegal transition ${current.status} → ${to}`);
    }
    const next: TaskRecord = {
      ...current,
      ...patch,
      status: to,
      // ADR-0010 决定 4：出队转 running 的那一刻盖 startedAt，durationMs 量孩子跑起来之后的时间
      startedAt: to === "running" ? Date.now() : current.startedAt,
      finishedAt: isTerminal(to) ? Date.now() : current.finishedAt,
    };
    this.#records.set(id, next);
    this.#emit(next, current);
    return { record: next, fromStatus: current.status, changed: true };
  }
}
