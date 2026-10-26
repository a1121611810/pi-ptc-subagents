import type { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS } from "./limits.ts";

// warm 复用的最小功能集：固定容量、acquire 超时、drain 退役（ADR-0017 的池语义，不照搬 §10 十条）
export class WorkerPool {
  readonly #spawn: () => Worker;
  readonly #capacity: number;
  readonly #idle: Worker[] = [];
  readonly #waiters: { resolve: (worker: Worker) => void; timer: NodeJS.Timeout }[] = [];
  #spawned = 0;
  #draining = false;

  constructor(spawn: () => Worker, capacity: number = DEFAULT_LIMITS.poolSize) {
    this.#spawn = spawn;
    this.#capacity = capacity;
  }

  acquire(timeoutMs: number = DEFAULT_LIMITS.poolAcquireTimeoutMs): Promise<Worker> {
    const idle = this.#idle.pop();
    if (idle) return Promise.resolve(idle);
    // drain 只退役「当代」worker，不封池：下一次 acquire 起新的一代（否则 turn_end 之后再也无法取到 worker）
    if (this.#spawned < this.#capacity) {
      this.#draining = false;
      this.#spawned++;
      return Promise.resolve(this.#spawn());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`worker acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#waiters.push({ resolve, timer });
    });
  }

  release(worker: Worker): void {
    if (this.#draining) {
      this.#spawned = Math.max(0, this.#spawned - 1);
      void worker.terminate();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(worker);
      return;
    }
    this.#idle.push(worker);
  }

  // 退役：空闲的立即杀；在跑的等其自然 settle（dispatcher 的 timeout 兜着），release 时再杀
  drain(): void {
    this.#draining = true;
    for (const worker of this.#idle.splice(0)) {
      this.#spawned = Math.max(0, this.#spawned - 1);
      void worker.terminate();
    }
  }
}
