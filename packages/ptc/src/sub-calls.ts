// ADR-0021：程序内 binding 调用的活树——run 期间记录 start/end，settle 时随结果交出去（显示层消费）
export interface SubCallRecord {
  callId: number;
  name: string;
  argsPreview: string;
  status: "running" | "ok" | "error" | "rejected";
  startedAt: number;
  durationMs?: number;
}

const PREVIEW_MAX_CHARS = 60;

export class SubCallTracker {
  readonly #records = new Map<number, SubCallRecord>();
  readonly #order: number[] = [];

  start(callId: number, name: string, args: unknown): void {
    const preview = JSON.stringify(args);
    this.#records.set(callId, {
      callId,
      name,
      argsPreview: preview ? preview.slice(0, PREVIEW_MAX_CHARS) : "",
      status: "running",
      startedAt: performance.now(),
    });
    this.#order.push(callId);
  }

  end(callId: number, status: "ok" | "error" | "rejected"): void {
    const record = this.#records.get(callId);
    if (!record) return;
    record.status = status;
    record.durationMs = Math.round(performance.now() - record.startedAt);
  }

  snapshot(): SubCallRecord[] {
    return this.#order.map((callId) => this.#records.get(callId)!);
  }
}
