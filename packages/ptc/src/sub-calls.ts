// 旧 ADR-0021：程序内 binding 调用的活树——run 期间记录 start/end，settle 时随结果交出去（显示层消费）
// args 为结构化原值（非截断预览）：程序型子代理的 delivery 轨迹从它推导（dispatch 的 program-carrier）
export interface SubCallRecord {
  callId: number;
  name: string;
  argsPreview: string;
  args?: unknown;
  status: "running" | "ok" | "error" | "rejected";
  startedAt: number;
  durationMs?: number;
}

const PREVIEW_MAX_CHARS = 60;

export class SubCallTracker {
  readonly #records = new Map<number, SubCallRecord>();
  readonly #order: number[] = [];

  start(callId: number, name: string, args: unknown): void {
    let preview = "";
    try {
      preview = JSON.stringify(args) ?? "";
    } catch {
      // BigInt/循环引用是 structured clone 的合法值但 JSON.stringify 会抛——预览不许影响主链路
      preview = String(args);
    }
    this.#records.set(callId, {
      callId,
      name,
      argsPreview: preview.slice(0, PREVIEW_MAX_CHARS),
      args,
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
