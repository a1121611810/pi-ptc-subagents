import { existsSync } from "node:fs";

// 旧 ADR-0017 W-4：生产用打包出的 dist/worker.js（V8 code cache 跨进程存活）；源码直跑（vitest 等）回退到 src 入口
// shortcut: .ts 回退依赖 Node ≥24 的原生类型剥离；Node 22 下限上只有 dist 路径可用
export function buildWorkerUrl(from: string | URL): URL {
  const built = new URL("./worker.js", from);
  if (existsSync(built)) return built;
  return new URL("../src/worker-entry.ts", from);
}
