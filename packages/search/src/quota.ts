// ADR-0001：每进程配额——只计成功调用（与 DeepSeek 计费一致），失败不占额；0 = 不限
export interface SearchQuota {
  tryAcquire(): boolean;
  /** 完成一次调用：success=false（搜索无结果等官方不计费的形态）不耗额 */
  release(success?: boolean): void;
  remaining(): number;
}

export function createSearchQuota(maxCallsPerSession: number): SearchQuota {
  let inFlight = 0;
  let used = 0;
  const unlimited = maxCallsPerSession <= 0;
  return {
    tryAcquire() {
      if (unlimited) return true;
      if (used + inFlight >= maxCallsPerSession) return false;
      inFlight++;
      return true;
    },
    release(success = true) {
      if (unlimited) return;
      inFlight = Math.max(0, inFlight - 1);
      if (success) used++;
    },
    remaining() {
      return unlimited ? Infinity : Math.max(0, maxCallsPerSession - used - inFlight);
    },
  };
}
