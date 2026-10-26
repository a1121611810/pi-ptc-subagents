import { defineConfig } from "rolldown";

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
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
