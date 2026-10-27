// 旧 ADR-0003/0004/0017：全部数字的唯一出处——测试与代码一律引用这里，不写字面量
export const DEFAULT_LIMITS = {
  timeoutMs: 120_000, // 程序默认 2 分钟（旧 ADR-0017）
  maxTimeoutMs: 600_000, // 调用方可上调的上限
  graceMs: 3_000,
  maxOutputBytes: 67_108_864, // 64 MiB：logs + completion value 的序列化联合预算（旧 ADR-0003，DSH 现值）
  maxPendingCalls: 128, // worker→host 在途调用上限（旧 ADR-0004，DSH 现值，取代旧实现无证据的 32）
  maxParallelSubCalls: 10, // 同时执行的绑定调用上限（DSH 2026-07-26）
  poolSize: 4, // warm 池（落地后启用）
  poolAcquireTimeoutMs: 30_000,
  // 旧 ADR-0017 的有界 drain（等在飞 worker 自我释放，上限 drainGraceMs）未移植：新 pool 靠 dispatcher 的 timeout 兜底
} as const;

// 调用方请求的超时只能往下调，不能突破上限
export function effectiveTimeoutMs(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_LIMITS.timeoutMs;
  return Math.min(Math.max(requested, 1_000), DEFAULT_LIMITS.maxTimeoutMs);
}
