# 发布物压缩：minify 开，sourcemap 留盘不发布

Status: accepted (2026-11-02)。修订：发布形态那段的「产物即源码可读」。

## Context

用户报告：**构建后的包打开后不会被压缩**。查底（2026-11-02）：

- 干净室重写时，`packages/entry/rolldown.config.mjs` 里**没有 `minify`** ⇒ `dist/index.js` 是 5,733 行 / 245,612 B 的原样源码（能直接读源码注释）。
- 旧分支有一份 ADR-0019《开启压缩 + 从 tarball 排除 source map》，它的触发原话也是「有人报告 `pnpm run build` 没有压缩」——**同一个形状的回归**，重写时那份决策没继承过来。
- 同一形状的另一面：Kimi 面的 `release/kimi/server.js` 是 592,267 B。

## Decision

**1. 压发布物。** `packages/entry` 与 `packages/kimi-mcp` 的 `output.minify: true`——rolldown 自带 oxc 压缩器，**零新依赖**（与旧 ADR-0019 同一个选择，理由不变：换 esbuild/terser 要么重复依赖要么拿已知-good 换未知-good）。workspace 中间产物的 dist 不进 tarball，**不压**（压了只增加 diff 面，不减少发布物）。

**2. sourcemap 留盘、不发布。** `output.sourcemap: true`：map 落在盘上供本地看栈；根包 `files` 白名单只收 `dist/**/*.js` ⇒ **map 不进 tarball**（旧 ADR-0019 §3 的语义切分原样沿用）。Node 对缺失的 map **静默忽略**（实测：带 `//# sourceMappingURL=missing.map` 的文件在 `--enable-source-maps` 下正常报错，无警告）⇒ 悬空引用无害。

**3. 产物形态探针的标记必须是字符串字面量。** 压缩器会改**模块级标识符**的名字：`buildWorkerUrl` 与 `CELL_PREAMBLE` 在压缩产物里双双消失（实测 0 命中）⇒ 用它们当标记的探针直接假红。改用字面量标记（`__PTC_NAMES__`、`PTC worker 缺失：期望 `）——压缩器不碰字符串内容。

**4. 产物外部 import 门禁的锚点从「行首」改成「语句边界」（行首或分号后）。** 压缩产物**整个文件一行**：只认行首 ⇒ 门禁只认得出第一条 import ⇒ **在最该盯的发布产物上静默失效**（实测：压缩前认出 3 处裸 import，压缩后只认出 1 处）。动态 import 不锚语句边界（它总在表达式位置）。

## Consequences

- **发布物**：npm 包 JS 合计 268,491 B → **115,637 B（−56.9%）**；`dist/index.js` 245,612 → 101,999 B、`ptc-engine.js` 14,141 → 7,269 B、`worker.js` 6,332 → 4,667 B。Kimi `release/kimi/server.js` 592,267 → 288,454 B。
- **堆栈里的函数名变短**（sourcemap 能把位置映回源码，函数名本身是压缩后的）——本地调试靠 `node --enable-source-maps`。
- **两处门禁改动都有探针钉住**：`tests/pi/artifact-import-gate.test.mjs` 加两条压缩形态用例（单行里的第二个 import 也要被抓到）；`tests/pi/artifact-shape.test.mjs` 换标记 + `from\s*"`（压缩后 `from"x"` 没有空格）。
- **没做的**：entry 里那 245 个 typebox 模块是**真需要的**（用 `Type.Object` 等生成 pi 工具的 JSON Schema），不是误打包；要再瘦只能换成手写 JSON Schema 对象——一次有行为风险的独立重构，不在本次范围。
- **没做的**：把 typebox / MCP SDK 变成 external（发布物带运行时依赖）——与「装根包零传递依赖」冲突。

## Verification

- 四制探针全绿（pi 153 + output 6 + kimi 25 + standalone 13）+ 产物 import 门禁。
- **门禁负向对照**：撕掉 `packages/entry/package.json` 的 `@earendil-works/pi-tui` 声明 ⇒ 门禁在**压缩产物**上照样红并点名那个包与那个 manifest（恢复后绿）。压缩前后认出的裸 import 数一致（3 处）。
- 真 pi 冒烟：`pi -ne -e packages/entry/dist/index.js -p ...`（1.4.0 与 floor 0.86.0）。

## See also

- [ADR-0024](./0024-one-build-multi-entry-artifact.md) —— 发布形态（一次构建、多入口、共享块）；本篇只管「压不压」。
- 旧 ADR-0019《minify 与 source map 排除》（归档在 `backup/main-legacy-20261026`）—— 本篇是它在干净室重写后的再生。
