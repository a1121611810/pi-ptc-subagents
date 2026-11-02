# 插件更新徽标来自市场目录条目：分发物带一份市场 JSON

Status: accepted (2026-11-01)。修订：[ADR-0020](./0020-kimi-mcp-face.md) §5 的**理由句**与 Consequences 的「marketplace JSON（不上）」。

## Context

ADR-0020 §5 定的**发布物形态**是对的（每版 `gh release create`、`release/kimi/` 入库、裸仓库 URL 装），但它给的理由是错的：

> Kimi 的插件更新检测只认 `source = github` 的安装（`manager.ts checkUpdates` 过滤）

`checkGithubUpdate`（Kimi Code 的 `packages/agent-core-v2/src/app/plugin/manager.ts`）确实按 `source === "github"` 过滤，**但它没有调用方**。2026-11-01 在 Kimi Code 2.4.1 的发布物上实读（CLI 二进制 + 桌面端 bundle）：

- CLI 里 `checkUpdates` 只出现 4 处——manager 定义、service 包装、RPC 契约、类型导出。**没有调度器，没有启动时自动应用。**
- 桌面端渲染包里 `checkUpdates` 出现 **0 次**。
- TUI 的 `/plugins` 面板与桌面端设置页的更新徽标，来源都是**市场目录条目**：`computeUpdateStatus(entry.version, installed.version)`。目录里查不到这个 id ⇒ 不出徽标 ⇒ `Enter` 只出详情，没有更新。

实测对照：本仓插件 2026-10-28 装的是 v7.1.0，到 2026-11-01 已发布 v7.2.0–v7.5.0，**面板从头到尾没有任何更新提示**，用户手动重装才发现版本落后了四个版本。

Kimi Code 的市场目录默认由服务端下发（`GET /plugins/marketplace` → Kimi CDN 的 `…/plugins/marketplace.json`），**没有自助发布入口**；官方文档给了另一条自助路：`/plugins marketplace <json 路径或 URL>` 与 `KIMI_CODE_PLUGIN_MARKETPLACE_URL`——自己供一份目录 JSON 即可（`{"version":"2","plugins":[{"id","source",…}]}`）。

## Decision

**1. 分发物带一份市场 JSON（`plugin-marketplace.json`，仓库根，入库）。** 一条条目：`id` 必须等于 manifest 的 `name`（目录靠 id 匹配已装插件才出徽标），`source` 用**裸仓库 URL**——钉 tag / 钉 sha 的 URL 被 `checkGithubUpdate` 判为「显式钉版本 ⇒ 永不更新」，装出来也不会跟随新 release。

**2. 条目不写 `version`。** Kimi Code 载入目录时会对没有 `version` 的条目自己去 GitHub 查 latest release tag（去 `v` 前缀）补上（`withLatestVersions`）——目录永不过期，不用跟着发版手改。版本必须是**纯 semver**：`computeUpdateStatus` 用 `semver.gt` 比，`"v7.5.0"` 会被判成永远是最新。

**3. `build:kimi` 加一条自检：市场条目 id 与 manifest `name` 一致。** 与既有的「manifest version 必须与根 package.json 同号」同一道闸——id 不符的后果是静默的（装得上、没有徽标），所以在发版机上钉住。

**4. 条目不写 `tier`。** 解析器的白名单只有 `official` / `curated`（`PLUGIN_MARKETPLACE_TIERS`）——写 `third-party` 会让**整份目录**加载失败（官方条目一起消失），不是只坏一条：不写 tier 时条目落在第三方标签页（UI 按 `tier === "official"` 分流），也不冒充 Kimi 的「curated 伙伴插件」。`build:kimi` 把这条钉住：条目写了 tier 就报错。官方市场（Kimi CDN 那份）仍需 Kimi 收录、无自助入口——本 JSON 是**自助市场**，用户显式指一次（或设 env 常驻）即可。

> ⚠️ 2026-11-02 实测订正：本条最初写的是「条目标 `tier: "third-party"`」——那是照着**响应 schema** 的枚举（`pluginMarketplaceEntrySchema`，输出契约、宽松）推的，**没核对解析器的白名单**（输入契约、严格）。真发出去后客户端报 `Plugin marketplace entry ptc-tools "tier" must be one of: official, curated.`。**响应 schema 宽 ≠ 解析器宽**：目录是自己喂进去的输入，只能按解析器算。

**5. 更新仍是一次按键，不是自动。** Kimi Code 没有自动下载路径（无调度器）。市场 JSON 解决的是「徽标 + `Enter` 一键更新」，不是「自动更新」——别把两者混为一谈。

## Consequences

- 消费者指了这份目录之后：`/plugins` 面板 Installed 标签页出 `update 7.1.0 → 7.5.0`，`Enter` 重装（走裸仓库 URL ⇒ 重新解析 latest release）。桌面端设置页的第三方标签页同样出「更新」按钮。
- 自定义目录是**整体替换**默认目录，不是追加——官方条目会消失，用户想保留得自己列进去（或只临时用 `/plugins marketplace <url>` 不设 env）。
- 自定义目录**没有**「发现更新」通知：通知要求目录来源 == 默认 CDN URL（`pluginMarketplaceIsDefault`），且只对装自 Kimi CDN 官方路径的插件发。
- 本 ADR 修订 ADR-0020 §5 的理由句与其 Consequences 的「marketplace JSON（不上）」；§5 的**发布物形态**（每版 `gh release create`、`release/kimi/` 入库）不变，仍然成立。
