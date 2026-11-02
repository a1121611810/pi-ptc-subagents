# typebox 由 pi 提供：产物里不再带它

Status: accepted (2026-11-02)。修订：[ADR-0025](./0025-publish-artifact-minified.md) 的「发布物」数字。

## Context

`packages/entry` 用 typebox 生成 pi 工具的 JSON Schema（`Type.Object` / `Type.String` / `Type.Optional` … 共 **105 处调用，4 个文件**）。typebox 不是 schema 描述器那么简单——`Type.*` 的实现把 **245 个 typebox 模块**拖进依赖图 ⇒ 压缩后的 `dist/index.js` 里仍有约四成是 typebox（101,999 B 里的 ~40 KB）。

## Decision

**1. entry 的 rolldown 把 typebox 列为 external。** 依据不是「装个依赖」，是宿主的事实：**pi 的扩展加载器带一张 alias / virtual-module 表**，其中 `typebox` 指向 **pi 自己那份 typebox 1.3.27**——与本仓用的版本**逐字相同**（pi 的 `package.json` 里 `"typebox": "1.3.27"`，本仓同）。扩展 `import "typebox"` 由 pi 在加载时解析 ⇒ 产物里少 245 个模块，**不新增任何依赖、不多装一个字节**。

**2. Kimi 面不外置。** `packages/kimi-mcp` 的 bundle 里 typebox 来自 MCP SDK 内部，Kimi 插件是**一个目录**（没有 npm 安装步骤，也没有 pi 的 alias 表）⇒ 外置等于运行时解析不到。kimi-mcp 继续把 typebox 打进 bundle。

## Consequences

- **发布物**：`dist/index.js` 101,999 → **61,052 B**；npm 包 JS 合计 115,637 → **74,690 B**（相对压缩前的 268,491 B 是 **−72%**）；tarball 72.2 → **60.2 kB**。发布包**仍然零传递依赖**（根包 manifest 没有任何 `dependencies`）。
- **运行时行为不变**：schema 仍由 typebox 在运行时构造（只是 typebox 从 pi 那儿来而不是打进包里）⇒ pi 的参数校验路径（`ToolDefinition.parameters` 的类型就是 typebox 的 `TSchema`）照旧。
- **边界**：根包的 `"."` 入口（pi 扩展面）在**裸 node** 下 import 会解析不到 typebox——但它本来就 `import "@earendil-works/pi-coding-agent"`（peer dep，不装就没有）⇒ 这个入口本来**只在 pi 里可用**。独立使用面是 `"./ptc"` 子路径（引擎，零依赖，不碰 typebox）✓。

## Verification

- **发布包形态实测**（`npm pack` → 装进空目录 → `node_modules` 里**只有** `pi-ptc-subagents`，没有 typebox）：pi **1.4.0** 与 floor **0.86.0** 都成功加载扩展并派发（`ptc_run_code` 求值 6*7 ⇒ `RUN=42`）⇒ 两端的加载器都解析得了 typebox。
- 仓库内：产物外部 import 门禁（4 处裸 import，全部已声明）+ 四制探针全绿 + 16 版本真机冒烟 16/16。

## See also

- [ADR-0025](./0025-publish-artifact-minified.md) —— 压缩；本篇管「压缩后还剩什么」。
- [ADR-0024](./0024-one-build-multi-entry-artifact.md) —— 发布形态（一次构建、多入口、共享块）。
