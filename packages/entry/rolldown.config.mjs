import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";

// 直接吃各包源码：workspace exports 的 default 指向 dist，单包 filter 构建会把陈旧的
// 兄弟包 dist 静默打进 bundle；alias 到 src 后 entry 构建不再依赖任何兄弟包的 dist
const src = (pkg) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  input: {
    index: "src/index.ts",
    // worker 与 index 同目录出包：pi 加载的是 dist/index.js，而 worker 线程按
    // buildWorkerUrl(import.meta.url) 找同目录的 worker.js——worker 不在 index 旁边就起不来
    worker: "../ptc/src/worker-entry.ts",
  },
  platform: "node",
  // 发布形态：根包只发一份自包含产物——workspace 包（@pi-ptc/*）打进 bundle，只外置 pi 本身
  external: [/^@earendil-works\//],
  resolve: {
    alias: {
      "@pi-ptc/dispatch": src("dispatch"),
      "@pi-ptc/ptc": src("ptc"),
      "@pi-ptc/routes": src("routes"),
      "@pi-ptc/search": src("search"),
      "@pi-ptc/task": src("task"),
      "@pi-ptc/tui": src("tui"),
    },
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
