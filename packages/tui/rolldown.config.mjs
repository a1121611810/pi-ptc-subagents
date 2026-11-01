import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    // 根入口 = 共享文本零件（零运行时依赖；output/search/task 四个消费方靠它）
    index: "src/index.ts",
    // pi 画面层单独一个入口（ADR-0022）——根入口不得 re-export 它，否则 Kimi 产物会带进 pi 宿主代码
    pi: "src/pi/index.ts",
  },
  platform: "node",
  external: [/^@earendil-works\//],
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
