// ADR-0010：libuv 线程池形状——固定槽、满了 FIFO 排队、从不拒绝；按 task id 键记账与释放
export const DEFAULT_DISPATCH_CONCURRENCY = 8;

export type AcquireOutcome = "granted" | "queued" | "withdrawn";

export interface Waiter {
  taskId: string;
  resolve: (outcome: "granted" | "withdrawn") => void;
}

export class DispatchSlotCounter {
  readonly #capacity: number;
  readonly #holders = new Set<string>();
  readonly #waiters: Waiter[] = [];

  constructor(capacity: number = DEFAULT_DISPATCH_CONCURRENCY) {
    this.#capacity = capacity;
  }

  get queuedCount(): number {
    return this.#waiters.length;
  }

  /** granted 立即占槽；queued 进 FIFO；withdrawn 已被取消/抽干（记录侧负责转 canceled） */
  acquire(taskId: string): Promise<AcquireOutcome> {
    if (this.#holders.has(taskId)) return Promise.resolve("granted");
    if (this.#holders.size < this.#capacity) {
      this.#holders.add(taskId);
      return Promise.resolve("granted");
    }
    return new Promise((resolve) => {
      this.#waiters.push({ taskId, resolve });
    });
  }

  /** 带提拔的释放：槽递给最老等待者并返回它的 taskId（调用方负责启动它） */
  release(taskId: string): string | null {
    this.#holders.delete(taskId);
    const waiter = this.#waiters.shift();
    if (!waiter) return null;
    this.#holders.add(waiter.taskId);
    waiter.resolve("granted");
    return waiter.taskId;
  }

  /** 旧 ADR-0063：拆卸还槽不提拔——被抽任务占着槽却永不启动的洞，用它还 */
  releaseWithoutPromotion(taskId: string): void {
    this.#holders.delete(taskId);
  }

  holders(): string[] {
    return [...this.#holders];
  }

  /** ADR-0011：抽掉一个还在排队的；已起的返回 false（uv_cancel 的 EBUSY） */
  cancelQueued(taskId: string): boolean {
    const index = this.#waiters.findIndex((w) => w.taskId === taskId);
    if (index < 0) return false;
    const [waiter] = this.#waiters.splice(index, 1);
    waiter!.resolve("withdrawn");
    return true;
  }

  /** 旧 ADR-0063：抽干全部等待者（shutdown 清扫） */
  drainWaiters(): string[] {
    const drained = this.#waiters.splice(0);
    for (const waiter of drained) waiter.resolve("withdrawn");
    return drained.map((w) => w.taskId);
  }
}
