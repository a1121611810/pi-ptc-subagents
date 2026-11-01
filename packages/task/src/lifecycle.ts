import { isTerminal, type TaskRecord, type TaskRegistry, type TaskStatus } from "@pi-ptc/dispatch";
import { renderCompactedTaskReminder } from "@pi-ptc/routes";
import {
  fitTaskEntries,
  projectTaskEntry,
  selectVisibleTasks,
  taskFaceVisible,
  type TaskListEntry,
} from "./list-tasks.ts";

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export type TaskListQuery = {
  /** recent = 只热存；all = 含压缩归档 */
  scope?: "recent" | "all";
  /** 取多少条（默认 50，上限 200） */
  limit?: number;
  /** 只看某个状态 */
  status?: TaskStatus;
  /** 按会话筛（会话 id 是标签不是归属键：老记录没这个字段，不匹配任何会话） */
  session?: string;
};

export type TaskListSnapshot = {
  scope: "recent" | "all";
  /** 候选总数（返回条数之外还有多少） */
  total: number;
  tasks: TaskListEntry[];
};

// 任务面列表：在飞的 + 最近完成的任务；精简字段 + 字节预算 ⇒ 响应有界
export function taskListSnapshot(
  registry: TaskRegistry,
  query: TaskListQuery = {},
  archived: readonly TaskRecord[] = [],
): TaskListSnapshot {
  const scope = query.scope === "all" ? "all" : "recent";
  const limit = Math.min(Math.max(query.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const records = scope === "all" ? [...registry.list(), ...archived] : registry.list();
  const candidates = records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.session && record.sessionId !== query.session) return false;
    return true;
  });
  const visible = selectVisibleTasks(candidates, limit);
  const withSession = query.session !== undefined;
  return {
    scope,
    total: candidates.length,
    tasks: fitTaskEntries(
      visible.map((record) =>
        projectTaskEntry(record, {
          archived: "archived" in record,
          withSession,
        }),
      ),
      limit,
    ),
  };
}

export function faceVisible(registry: TaskRegistry): boolean {
  return taskFaceVisible(registry.list());
}

/**
 * 压缩后重注入的清单：在飞任务 + 最近完成的 5 条。
 * 没有任务就不注入（空清单只是噪音）。
 */
export function compactedTaskReminder(registry: TaskRegistry): string | undefined {
  const records = registry.list();
  const inFlight = records.filter((record) => !isTerminal(record.status));
  const recentCompleted = records
    .filter((record) => isTerminal(record.status))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 5);
  if (inFlight.length === 0 && recentCompleted.length === 0) return undefined;
  return renderCompactedTaskReminder(
    [...inFlight, ...recentCompleted].map((record) => ({
      id: record.id,
      status: record.status,
      label: record.label,
    })),
  );
}
