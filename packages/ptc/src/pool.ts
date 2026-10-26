import type { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS } from "./limits.ts";

// warm 复用的最小功能集：固定容量、acquire 超时、drain 退役（旧 ADR-0017 的池语义，不照搬 §10 十条）
export class WorkerPool {
  readonly #spawn: () => Worker;
  readonly #capacity: number;
  readonly #idle: Worker[] = [];
  readonly #waiters: { resolve: (worker: Worker) => void; timer: NodeJS.Timeout }[] = [];
  readonly #retired = new WeakSet<Worker>();
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
      return Promise.resolve(this.#track(this.#spawn()));
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
      this.#retire(worker);
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

  /** 被杀/卡死/崩溃的 worker：收回名额并摘出空闲表（terminate 幂等） */
  discard(worker: Worker): void {
    this.#retire(worker);
    const index = this.#idle.indexOf(worker);
    if (index >= 0) this.#idle.splice(index, 1);
    void worker.terminate();
  }

  // 退役：空闲的立即杀；在跑的等其自然 settle（dispatcher 的 timeout 兜着），release 时再杀
  drain(): void {
    this.#draining = true;
    for (const worker of this.#idle.splice(0)) {
      this.#retire(worker);
      void worker.terminate();
    }
  }

  #track(worker: Worker): Worker {
    // 死亡（OOM/异常）不会走 release：exit 时自己交还名额，否则池慢慢枯竭
    worker.once("exit", () => {
      this.#retire(worker);
      const index = this.#idle.indexOf(worker);
      if (index >= 0) this.#idle.splice(index, 1);
    });
    return worker;
  }

  #retire(worker: Worker): void {
    if (this.#retired.has(worker)) return;
    this.#retired.add(worker);
    this.#spawned = Math.max(0, this.#spawned - 1);
  }
}
