import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";

// 直接吃各包源码：workspace exports 的 default 指向 dist，单包 filter 构建会把陈旧的
// 兄弟包 dist 静默打进 bundle——build:kimi 不重建 ptc，陈旧代码会进 release/kimi
const src = (pkg) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  input: {
    index: "src/index.ts",
    server: "src/server.ts",
    // worker 必须与 server 同目录产出：buildWorkerUrl 以 server chunk 的 import.meta.url 相对解析
    worker: "../ptc/src/worker-entry.ts",
  },
  platform: "node",
  resolve: {
    alias: {
      "@pi-ptc/output": src("output"),
      "@pi-ptc/ptc": src("ptc"),
      "@pi-ptc/routes": src("routes"),
      "@pi-ptc/search": src("search"),
      "@pi-ptc/tui": src("tui"),
    },
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
    // 发布物压缩（旧 ADR-0019 的形状，2026-11-02 补回）：零新依赖，rolldown 自带 oxc 压缩器
    minify: true,
    sourcemap: true,
  },
});
