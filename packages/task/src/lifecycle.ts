import type { CommandResult, TaskRecord, TaskRegistry } from "@pi-ptc/dispatch";
import { selectVisibleTasks, taskFaceVisible } from "./list-tasks.ts";

export function listTasks(registry: TaskRegistry, recentCompletedLimit?: number): TaskRecord[] {
  return selectVisibleTasks(registry.list(), recentCompletedLimit);
}

export function faceVisible(registry: TaskRegistry): boolean {
  return taskFaceVisible(registry.list());
}

// ADR-0057：取消只对还没起进程的有效；已起的走 stop（信号阶梯随 dispatch 落地接上）
export async function stopTask(
  registry: TaskRegistry,
  id: string,
  reason: string,
): Promise<CommandResult> {
  const canceled = await registry.submit({ kind: "cancel-queued", id, reason });
  if (canceled.changed || canceled.record.status !== "running") return canceled;
  return registry.submit({ kind: "stop", id, reason });
}
