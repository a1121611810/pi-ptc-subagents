import {
  TaskEngine,
  TaskRegistry,
  type DispatchInput,
  type DispatchOutcome,
  type EngineOptions,
  type Gate,
  type TaskHandle,
  type TaskRejection,
} from "@pi-ptc/dispatch";
import { faceVisible, listTasks } from "@pi-ptc/task";

export type { DispatchOutcome, Gate, TaskHandle, TaskRejection };

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
  listTasks(recentCompletedLimit?: number): TaskRecord[];
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
}

// 装配入口的角色（HTML 决策 27）：sub 持状态，task/ptc 是它的调用方，entry 把它们接到同一个 registry 上
export function assemblePtcSession(options: PtcSessionOptions = {}): PtcSession {
  const registry = new TaskRegistry(options.onTransition);
  const engine = new TaskEngine({
    registry,
    gates: options.gates,
    whyEnabled: options.whyEnabled,
    ...options.engine,
  });
  return {
    registry,
    engine,
    createTask: (task, opts) => engine.dispatch({ ...opts, task }),
    listTasks: (recentCompletedLimit) => listTasks(registry, recentCompletedLimit),
    stopTask: (taskId, reason) => engine.stop(taskId, reason),
    faceVisible: () => faceVisible(registry),
    shutdown: () => engine.shutdown(),
    readOutput: (taskId) => engine.readOutput(taskId),
    outputSize: (taskId) => engine.outputSize(taskId),
    readOutputTail: (taskId, maxBytes) => engine.readOutputTail(taskId, maxBytes),
    readArchivedRecord: (taskId) => engine.readArchivedRecord(taskId),
  };
}
