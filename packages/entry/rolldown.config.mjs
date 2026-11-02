import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";

// 直接吃各包源码：workspace exports 的 default 指向 dist，单包 filter 构建会把陈旧的
// 兄弟包 dist 静默打进 bundle；alias 到 src 后 entry 构建不再依赖任何兄弟包的 dist
const src = (pkg) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));
// 子路径入口：必须排在同包的短 alias 之前——rolldown 的 alias 是前缀匹配，短 alias 会捕获子路径并解析失败
const sub = (pkg, rel) => fileURLToPath(new URL(`../${pkg}/src/${rel}/index.ts`, import.meta.url));

export default defineConfig({
  input: {
    index: "src/index.ts",
    // worker 与 index 同目录出包：pi 加载的是 dist/index.js，而 worker 线程按
    // buildWorkerUrl(import.meta.url) 找同目录的 worker.js——worker 不在 index 旁边就起不来
    worker: "../ptc/src/worker-entry.ts",
    // 独立引擎面 + ptc 命令行：与 index 同一次构建出包（ADR-0024）——
    // 此前 ptc 包单建一次、prepack 再把两份 dist 拼起来 ⇒ 发布物里引擎本体与 worker 各有两份
    "ptc/index": "../ptc/src/index.ts",
    "ptc/cli": "../ptc/src/cli.ts",
  },
  platform: "node",
  // 发布形态：根包只发一次构建的产物——workspace 包（@pi-ptc/*）打进 bundle，只外置 pi 本身
  external: [/^@earendil-works\//],
  resolve: {
    alias: {
      "@pi-ptc/dispatch": src("dispatch"),
      "@pi-ptc/output": src("output"),
      "@pi-ptc/ptc": src("ptc"),
      "@pi-ptc/routes": src("routes"),
      "@pi-ptc/search": src("search"),
      "@pi-ptc/task": src("task"),
      "@pi-ptc/tui/pi": sub("tui", "pi"),
      "@pi-ptc/tui": src("tui"),
    },
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    // 共享块留在输出根（不能进 chunks/ 子目录）：worker 线程按 buildWorkerUrl(import.meta.url)
    // 找同目录的 worker.js，而 buildWorkerUrl 在共享块里 ⇒ 共享块挪进子目录就找不到 worker
    chunkFileNames: "[name].js",
    format: "esm",
    // 发布物压缩（旧 ADR-0019 的形状，2026-11-02 补回）：minify 走 rolldown 自带的 oxc 压缩器，零新依赖。
    // sourcemap 留在盘上供本地看栈——tarball 的 files 白名单只收 *.js，map 不发布（Node 缺 map 静默忽略）
    minify: true,
    sourcemap: true,
    // 引擎本体归到一个具名共享块：index.js 与 ptc/index.js 指向同一份引擎（ADR-0024）
    codeSplitting: {
      groups: [
        {
          name: "ptc-engine",
          // 正面名单：只收引擎的运行时模块。新增引擎文件忘了加进来 ⇒ 它落到自己的自动块（无害）；
          // 用「排除名单」的话，将来的入口模块会被扫进共享块——入口模块有顶层副作用，
          // 后果是「只要 import entry 就执行它」（rolldown 文档：manual chunking 会改副作用时机）
          test: /packages\/ptc\/src\/(dispatcher|pool|limits|sub-calls|fs-bindings|worker-source)\.ts$/,
        },
      ],
    },
  },
});
