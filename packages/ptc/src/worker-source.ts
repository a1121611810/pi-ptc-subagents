import { existsSync } from "node:fs";

// 旧 ADR-0017 W-4：生产用打包出的 dist/worker.js（V8 code cache 跨进程存活）；源码直跑（vitest 等）回退到 src 入口
// shortcut: .ts 回退依赖 Node ≥24 的原生类型剥离；Node 22 下限上只有 dist 路径可用
export function buildWorkerUrl(from: string | URL): URL {
  const built = new URL("./worker.js", from);
  if (existsSync(built)) return built;
  // 只在源码直跑时兜底：构建产物里没有 src/，退回去只会报一个从没存在过的路径
  const source = new URL("../src/worker-entry.ts", from);
  if (existsSync(source)) return source;
  throw new Error(`PTC worker 缺失：期望 ${built.pathname}`);
}
