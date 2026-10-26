import { isTerminal, type TaskRecord } from "@pi-ptc/dispatch";

// ADR-0053 决策 4：ptc_task_list 默认只列在飞的 + 最近的已完成
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

// ADR-0053：lifecycle face 的可见性 = 有没有记录（不是独立的开关规则）
export function taskFaceVisible(records: readonly TaskRecord[]): boolean {
  return records.length > 0;
}
