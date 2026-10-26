import type { TaskRegistry } from "./registry.ts";

// ADR-0022：后台任务完成 → 通知回到会话。事件源 = registry 的终态变迁；
// 注：批渲染（模型面文案）按散文单源纪律归 routes（renderTaskNotifications），本包只持队列与形状；
// 前台（wait）调用的任务由调用方直接拿结果，不再通知（ADR-0053）；批渲染成 <bg-task-notifications>
export interface TaskNotification {
  taskId: string;
  label?: string;
  status: string;
  stopReason?: string;
  at: number;
}

export const NOTIFICATION_BATCH_MAX_BYTES = 100 * 1024;

// 订阅即注册表：待投递队列。drain 不推进状态——取走即清（ack 语义的 v1 简化，shortcut 见下）
export class NotificationCenter {
  readonly #pending: TaskNotification[] = [];
  readonly #awaited = new Set<string>();
  #attached = false;

  /** 挂到 registry：终态变迁进待投递队列（awaited 的前台任务除外） */
  attach(registry: TaskRegistry): void {
    if (this.#attached) return;
    this.#attached = true;
    registry.subscribe((next, prev) => {
      if (prev?.status === next.status) return;
      if (!isTerminalStatus(next.status)) return;
      if (this.#awaited.has(next.id)) return;
      this.#pending.push({
        taskId: next.id,
        label: next.label,
        status: next.status,
        stopReason: next.stopReason,
        at: next.finishedAt ?? Date.now(),
      });
    });
  }

  /** 决策 8/ADR-0053：wait 路径的调用方自己拿结果——记 awaited，终态时跳过通知 */
  markAwaited(taskId: string): void {
    this.#awaited.add(taskId);
  }

  pendingCount(): number {
    return this.#pending.length;
  }

  /** 取走全部待投递（交付方负责发送）；空 = 无事发生 */
  drain(): TaskNotification[][] {
    const batches: TaskNotification[][] = [];
    let current: TaskNotification[] = [];
    let bytes = 0;
    for (const item of this.#pending.splice(0)) {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (current.length > 0 && bytes + size > NOTIFICATION_BATCH_MAX_BYTES) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(item);
      bytes += size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "canceled" || status === "lost"
  );
}
