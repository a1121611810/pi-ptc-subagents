import { defineConfig } from "vitest/config";

// 七个面各是一个 project：面内探针互不过河（原来靠目录约定，现在是配置强制）。
// 重资产面（website / bench / live）不在 `pnpm test` 的快腿里，各自一条命令单独触发。
const faces = [
  { name: "pi", include: ["tests/pi/**/*.test.ts"] },
  { name: "output", include: ["tests/output/**/*.test.ts"] },
  { name: "kimi", include: ["tests/kimi/**/*.test.ts"] },
  { name: "standalone", include: ["tests/standalone/**/*.test.ts"] },
  // 站点面要 spawn 反事实 harness（它把工作树整棵拷到临时目录再改）。
  // 2026-11-15 实测：拷贝剪掉 bench/ab（3 GB 无人读的数据）后，5 条 case 合计 5.25s，
  // 站点面 9 条用例 13.7s ⇒ 超时给 5 分钟足够（原 25 分钟是按拷贝 8 份工作树估的）。
  {
    name: "website",
    include: ["tests/website/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
  // bench 面要 uv run python 跑判分器自检（正例 + 负例各跑一遍）——uv 首次拉依赖可能很慢
  {
    name: "bench",
    include: ["tests/bench/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
  // live 面是真机冒烟（真 pi + 真模型 + 真凭据）
  {
    name: "live",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 1_900_000,
    hookTimeout: 1_900_000,
  },
] as const;

export default defineConfig({
  test: {
    // forks：真 spawn / 真子进程 / 真 env 开关的测试形态（假 pi harness 是进程级替身）
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: faces.map((face) => ({
      test: {
        name: face.name,
        include: [...face.include],
        ...(face.testTimeout ? { testTimeout: face.testTimeout } : {}),
        ...(face.hookTimeout ? { hookTimeout: face.hookTimeout } : {}),
      },
    })),
  },
});
