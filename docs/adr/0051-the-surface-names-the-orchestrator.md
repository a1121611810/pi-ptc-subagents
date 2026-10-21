# 表面值改名与定义：`full_ptc` / `codemode_ptc`，「哪个编排器对模型负责」

status: accepted (2026-10-21). 修订：[ADR-0025](./0025-extension-surface-is-a-setting.md)、
[ADR-0026](./0026-surface-default-is-detected.md)、
[ADR-0027](./0027-codemode-switch-decides-surface.md)、
[ADR-0028](./0028-structured-results-for-codemode.md)、
[ADR-0029](./0029-surface-follows-codemode-activation.md)、
[ADR-0030](./0030-surface-switch-reloads.md)、
[ADR-0032](./0032-child-report.md)、
[ADR-0033](./0033-mcp-auto-enable-evidence.md)、
[ADR-0034](./0034-surface-is-detected-not-set.md)、
[ADR-0035](./0035-ask-pi-for-the-loadout.md)、
[ADR-0040](./0040-bash-is-an-opt-in-binding.md)、
[ADR-0041](./0041-read-only-is-a-call-site-tier.md)、
[ADR-0047](./0047-deepseek-search-is-program-internal.md)、
[ADR-0049](./0049-the-search-lives-in-the-child.md)、
[ADR-0050](./0050-ptc-off-stops-new-dispatch.md)——修订的只有**名字**，决定本身不变（逐篇的指针在各记录正文顶部）。

## Context

「表面」（surface mode）这个概念从 [ADR-0025](./0025-extension-surface-is-a-setting.md) 起，一直有两个值：`subagents` 与 `full`。它们说的是**清单**——本包注册了哪些工具——而不是模型面对的问题。模型面对的问题是：**这一场会话里，谁在编排？**

两个具体的毛病：

1. **说的是清单，不是问题。** 注册表在两个面上其实是同一份东西：`subagents` 那一面**也**注册了 PTC 那一对，只是注册在 `codemode` reach 上、不面向模型（ADR-0025 §3 修订，2026-10-09）。所以「注册了什么」区分不了两个面，「谁在编排」才区分得开：一个是本包的 PTC，一个是 pi 的 `codemode`。
2. **`full` 会被读成「什么都有」，而那不成立。** 在 `full` 那一面上，PTC 那一对是注册了、却**不是模型直面的**。这个名字许诺了一个那一面并不交付的东西。

第三件事实是这次改名**不动**的东西：**检测逻辑三问照旧**——codemode 扩展在不在、pi 会不会加载它、它对模型是不是 active（ADR-0026 / ADR-0027 / ADR-0029）。同一个 pi 仍然落到同一个面上；变的只是那个面的**名字**。

## Decision

**1. 两个表面值改名：`full` → `full_ptc`，`subagents` → `codemode_ptc`。** 声明点只有一处：`src/mode/ptc-mode.ts` 的 `SURFACE_MODES`（现在是 `["full_ptc", "codemode_ptc"]`），`SurfaceMode` 由它派生。`FALLBACK_SURFACE_MODE` 从 `full` 变成 `full_ptc`，因为 ADR-0026 决策 3 的那条方向不变：探针答不出来时落到**本包自己编排**的那一面。

**2. 新定义：表面 = 哪个编排器对模型负责**（本包自己的 PTC，还是 pi 的 codemode）。词表的「表面模式」词条按新定义重写，并记下改名日期与理由。

**3. 检测不变。** 三问、四行判定表、`FALLBACK_SURFACE_MODE` 的方向、以及「同一个 pi 仍然得到同一个面」全部照旧——只是答案的名字换了。判定结果与今天一致，这是验收条件之一。

**4. 不留别名。** 旧值不再出现在任何面向用户的位置：源码、测试、文档、启动提示。**不留别名**是刻意的：留一个别名就是把同一个事实挂在两个名字下，正是本仓一路在避免的那种漂移（与 ADR-0045 对 `observedProvider` / `observedModel` 的处理同一条理由）。旧值作为**历史**只留在三处：被修订的 ADR 正文（历史不改写，只加指针）、本记录、以及词表里那条改名说明。

**5. 每一处分支、每一段启动提示都按新值改。** 注册分支（`detected.surfaceMode === "full_ptc" ? "direct" : "codemode"`）、`<ptc>` 段的选面、`session_start` 的三条通告，全部按新值分支；通告里给用户的句子也从「the detected surface is subagents」改成「the detected surface is codemode_ptc」。改动与新值在**同一个提交**里落地，修订双向可达。

## Evidence

可复核的四条：

1. **两个面的注册表是同一份**（实测，2026-10-09，ADR-0025 §3 修订）：`subagents` 面上 PTC 那一对注册在 `codemode` reach。⇒ 「注册了什么」不区分两个面，「谁在编排」才区分得开。
2. **`full` 这个名字许诺了不存在的东西**：`full` 面上 PTC 那一对注册了但不是 model-facing（`AgentSession._isDeclarable` 只收 `direct` 与 `model-only`，实测 0.99.0–1.1.0）。⇒ 名字与事实对不上。
3. **检测与命名是可分离的**：`detectedSurfaceMode` 的三问与四行表在改名前后逐格相同（ADR-0029 的表 + ADR-0027 的开关轴），只有答案的**名字**变了。⇒ 改名不必也不应该动行为。
4. **旧值没有别名可留**：`surfaceMode` 那个键早在 2026-10-10 就连同 `off` 一起删掉了（ADR-0034），今天没有任何配置面能写进旧值。⇒ 「不留别名」不需要任何兼容层，只是不要把旧名字留在类型、注册分支或提示文案里。

## 代价

- **一次破坏性改名。** `SurfaceMode` 是导出的类型，旧值不再是它的成员；引用旧值的下游代码要改。跟着 ADR-0045 的先例走：不做别名、不做双写，破坏点写进 CHANGELOG（发布面的同步归 #245）。
- **被修订的 ADR 正文里仍写着旧值。** 这是刻意的：历史不改写，只加一行指针（> Amended by ADR-0051）。代价是读者可能先读到旧值——所以每一篇的指针都明说「读它的 `full` / `subagents` 时读作那两个新名字」。
- **词表与 ADR 索引要同步。** 词表条目按新定义重写；ADR 索引表里新增本记录一行，并在「被修订的记录把修订写在记录里」那一段里补一句。
- **本记录不碰 `src/tools/**` 与 `src/runtime/**`**，那两处的注释里还有旧值的残留（`src/tools/common.ts`、`src/tools/subagent.ts`、`src/tools/pi-compat-types.ts`、`src/runtime/dispatch.ts`）。它们是注释，不是行为，也不面向模型；它们归别的票，本记录只在报告里点名。

## Alternatives

- **保留旧值，只改定义**（option 1）：定义改成「谁在编排」，名字不动。代价是名字与新定义对不上——`full` 依然会被读成「什么都有」，而这正是这次要修的东西。否决。
- **留别名**（option 2）：`SurfaceMode` 同时收新旧四个值，旧值映射到新值。代价是同一个事实两个名字，正是本仓一路在避免的漂移；ADR-0045 在字段名上已经拒过同一条。否决。
- **连检测一起重写**（option 3）：既然定义变了，就把三问也改成「哪个编排器在场」的一次判断。代价是三问各自答不同的问题（存在 / 加载 / 可调用），合成一次就要重建 ADR-0026 与 ADR-0029 的论证，而那两条论证本身没有被这次改名推翻。不做。

## Reopen triggers

- **两个面之外的第三种编排器真的出现**（例如 pi 把 `codemode` 之外的东西也接进模型面）：那时「两个值」是假的，要重新审这条而不是给它加第三个别名。
- **本包自己的 PTC 不再是「一个编排器」**（例如它变成 pi 内建能力的一部分）：`full_ptc` 这个名字会开始说谎，与 `full` 当年被否掉的理由是同一条。
