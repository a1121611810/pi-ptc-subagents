import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    server: "src/server.ts",
    // worker 必须与 server 同目录产出：buildWorkerUrl 以 server chunk 的 import.meta.url 相对解析
    worker: "../ptc/src/worker-entry.ts",
  },
  platform: "node",
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
