import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TaskEngine,
  TaskRegistry,
  type DispatchInput,
  type DispatchOutcome,
  type EngineContext,
  type EngineOptions,
  type Gate,
  type TaskHandle,
  type TaskRejection,
} from "@pi-ptc/dispatch";
import {
  faceVisible,
  taskListSnapshot,
  type TaskListQuery,
  type TaskListSnapshot,
} from "@pi-ptc/task";

export type { DispatchOutcome, EngineContext, Gate, TaskHandle, TaskRejection };

// HTML 第六节：handle（后台，不等）或拒绝；wait 路径拿 DispatchResult——撞闸永远走 status 不抛
export type CreateTaskResult = DispatchOutcome;

export interface PtcSession {
  /** 文档第一节：两链唯一的交点——门经它建记录，lifecycle face 经它读/停 */
  registry: TaskRegistry;
  engine: TaskEngine;
  createTask(
    task: string,
    options?: Omit<DispatchInput, "task" | "signal">,
  ): Promise<CreateTaskResult>;
  /** 任务面列表（模型面形状：精简条目 + 候选总数 + 字节预算） */
  taskListSnapshot(query?: TaskListQuery): TaskListSnapshot;
  stopTask(taskId: string, reason: string): Promise<void>;
  faceVisible(): boolean;
  shutdown(): Promise<void>;
  /** 任务链读产出正文（output.log 的内容；未落盘/不存在 = undefined） */
  readOutput(taskId: string): Promise<string | undefined>;
  /** 产出字节数（不读全文） */
  outputSize(taskId: string): Promise<number | undefined>;
  /** 只读产出尾部（方案 A：内存保险） */
  readOutputTail(taskId: string, maxBytes: number): Promise<string | undefined>;
  /** 决策 29：回落读者——精确 id 从压缩归档拉回（30 天窗口内可解）；miss = undefined */
  readArchivedRecord(taskId: string): Promise<(TaskRecord & { archived: true }) | undefined>;
  /** 归档区的全部记录（scope=all 时一次列出） */
  readArchivedRecords(): Promise<(TaskRecord & { archived: true })[]>;
  /** 宿主会话 id（只做标签：告诉父「这条是哪个会话的」） */
  readonly sessionId?: string;
}

import type { TaskRecord } from "@pi-ptc/dispatch";

export interface PtcSessionOptions {
  /** sub 的闸门（同步）；六道默认闸在 entry 组装，可追加 */
  gates?: Gate[];
  onTransition?: (record: unknown) => void;
  /** 旧 ADR-0043：whyEnabled 支持值或谓词——传谓词才能热生效（/ptc why 会话覆盖） */
  whyEnabled?: boolean | (() => boolean);
  /** 注入引擎依赖（探针传假 spawn；生产缺省真 pi） */
  engine?: Omit<EngineOptions, "registry" | "gates" | "whyEnabled">;
  /** 引擎运行时上下文（depth/sessionModel/piVersion）——entry 从宿主解析后经此透传 */
  context?: EngineContext;
}

// 装配入口的角色（HTML 决策 27）：sub 持状态，task/ptc 是它的调用方，entry 把它们接到同一个 registry 上
export function assemblePtcSession(options: PtcSessionOptions = {}): PtcSession {
  const registry = new TaskRegistry(options.onTransition);
  const engine = new TaskEngine({
    registry,
    gates: options.gates,
    whyEnabled: options.whyEnabled,
    context: options.context,
    ...options.engine,
  });
  return {
    registry,
    engine,
    createTask: (task, opts) => engine.dispatch({ ...opts, task }),
    taskListSnapshot: (query) => taskListSnapshot(registry, query),
    stopTask: (taskId, reason) => engine.stop(taskId, reason),
    faceVisible: () => faceVisible(registry),
    shutdown: () => engine.shutdown(),
    readOutput: (taskId) => engine.readOutput(taskId),
    outputSize: (taskId) => engine.outputSize(taskId),
    readOutputTail: (taskId, maxBytes) => engine.readOutputTail(taskId, maxBytes),
    readArchivedRecord: (taskId) => engine.readArchivedRecord(taskId),
    readArchivedRecords: () => engine.readArchivedRecords(),
    get sessionId() {
      return options.context?.sessionId;
    },
  };
}

/**
 * 引擎运行时上下文：孩子的模型默认继承父会话的当前模型。
 * 优先级（旧 ADR-0044）：调用参数 → agent 定义 → 会话模型（缺省继承）。
 * sessionModel 是活 getter——派发那一刻才读，用户中途换模型也跟着换；
 * floor 0.86 也有 ctx.model（实测 0.86.0 的 ExtensionContext.model 同为活 getter，provider/id 同形）→ 无版本门；
 * 会话没有模型 → undefined → 不发 --model；扩展被卸载后 ctx 的 getter 会抛（pi 的 assertActive）→ 吞掉退回旧行为。
 */
export function buildEngineContext(ctx: ExtensionContext, piVersion?: string): EngineContext {
  return {
    depth: 0,
    piVersion,
    get sessionModel(): string | undefined {
      try {
        const model = ctx.model;
        return model ? `${model.provider}/${model.id}` : undefined;
      } catch {
        return undefined;
      }
    },
    // 会话 id 只做标签（告诉父「这条是哪个会话的」）：floor 0.86 的
    // sessionManager.getSessionId() 同样在（真机实测）→ 无版本门；
    // 扩展被卸载后 getter 会抛（pi 的 assertActive）→ 吞掉退回旧行为（记录无此字段）。
    get sessionId(): string | undefined {
      try {
        return ctx.sessionManager.getSessionId();
      } catch {
        return undefined;
      }
    },
  };
}
