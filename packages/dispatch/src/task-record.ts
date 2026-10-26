export type TaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled"
  | "lost";

// ADR-0065（258 线的单源化修复）：终态清单只留这一份
export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "lost",
] as const satisfies readonly TaskStatus[];

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ADR-0023：记录归属创建它的 runtime 实例，回收按 owner 作用域
export interface TaskOwner {
  pid: number;
  bootMs: number;
}

// 记录本体：字段随 pump / 通知 / 报告落地再长（ADR-0022 的 25 字段是演进结果，不是起点）
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  task: string;
  label?: string;
  ownerPid?: number;
  ownerBootMs?: number;
  startedAt?: number;
  finishedAt?: number;
  stopReason?: string;
  /** ADR-0043：理由被开关丢弃的事实——记事件不记内容 */
  whySuppressed?: boolean;
  /** ADR-0032：孩子交回的结构化报告与到达通道（prompt-json / none；tool 通道落地后加 tool） */
  report?: import("./report.ts").ChildReport;
  reportChannel?: import("./report.ts").ReportChannel;
  /** 产出落盘位置（pump 写 output.log 后挂回；任务链的「产出」经此可读） */
  outputPath?: string;
}
