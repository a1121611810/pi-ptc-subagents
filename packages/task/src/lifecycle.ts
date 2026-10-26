import type { TaskRecord, TaskRegistry } from "@pi-ptc/dispatch";
import { selectVisibleTasks, taskFaceVisible } from "./list-tasks.ts";

export function listTasks(registry: TaskRegistry, recentCompletedLimit?: number): TaskRecord[] {
  return selectVisibleTasks(registry.list(), recentCompletedLimit);
}

export function faceVisible(registry: TaskRegistry): boolean {
  return taskFaceVisible(registry.list());
}
