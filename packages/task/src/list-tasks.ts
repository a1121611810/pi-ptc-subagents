import { isTerminal, type TaskRecord, type TaskStatus } from "@pi-ptc/dispatch";
import { truncateLine } from "@pi-ptc/tui";

// ADR-0007 决策 4：ptc_task_list 默认只列在飞的 + 最近的已完成
export function selectVisibleTasks(
  records: readonly TaskRecord[],
  recentCompletedLimit = 10,
): TaskRecord[] {
  const inFlight = records.filter((record) => !isTerminal(record.status));
  const recentCompleted = records
    .filter((record) => isTerminal(record.status))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, recentCompletedLimit);
  return [...inFlight, ...recentCompleted];
}

// ADR-0007：lifecycle face 的可见性 = 有没有记录（不是独立的开关规则）
export function taskFaceVisible(records: readonly TaskRecord[]): boolean {
  return records.length > 0;
}

// 模型面看到的条目：字段各自封顶 ⇒ 单条有界（一条巨型 task 文本就能撑爆上下文）
const TASK_TEXT_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 100;
const LABEL_MAX_CHARS = 120;

// 列表响应的字节预算（贴近 pi 的截断契约 50KB，给外层字段留余量）
export const LIST_MAX_BYTES = 48 * 1024;

export type TaskListEntry = {
  id: string;
  status: TaskStatus;
  label?: string;
  finishedAt?: number;
  /** 任务文本（截顶） */
  task?: string;
  /** 孩子报告的结论（截顶） */
  summary?: string;
  /** 命中的是压缩归档里的记录（不在热存） */
  archived?: boolean;
  /** 宿主会话 id（只在按会话筛时给——它只做标签，不是归属键） */
  sessionId?: string;
};

export function projectTaskEntry(
  record: TaskRecord,
  options: { archived?: boolean; withSession?: boolean } = {},
): TaskListEntry {
  return {
    id: record.id,
    status: record.status,
    ...(record.label ? { label: truncateLine(record.label, LABEL_MAX_CHARS) } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.task ? { task: truncateLine(record.task, TASK_TEXT_MAX_CHARS) } : {}),
    ...(record.report?.summary
      ? { summary: truncateLine(record.report.summary, SUMMARY_MAX_CHARS) }
      : {}),
    ...(options.archived ? { archived: true } : {}),
    ...(options.withSession && record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

// 逐条累加字节，超预算就停——JSON 保持合法（文本级截断会把 JSON 砍成半截，模型读不了）
export function fitTaskEntries(entries: readonly TaskListEntry[], limit: number): TaskListEntry[] {
  const picked: TaskListEntry[] = [];
  let bytes = 2; // []
  for (const entry of entries) {
    if (picked.length >= limit) break;
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + size > LIST_MAX_BYTES) break;
    picked.push(entry);
    bytes += size;
  }
  return picked;
}
