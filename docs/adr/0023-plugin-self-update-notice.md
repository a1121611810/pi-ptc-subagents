# 更新提示由插件自己产出：UserPromptSubmit hook 查 GitHub Release

Status: accepted (2026-11-02)。修订：[ADR-0021](./0021-plugin-marketplace-catalog.md) 的 Consequences（自定义目录不是「推给别人用」的路）。

## Context

ADR-0021 把市场目录定成分发物，理由是更新徽标只认目录条目。2026-11-02 补测出两件把这条路钉死的事：

- **自定义目录是「整目录替换」**：实测默认目录 7 条（3 official + 4 curated），换成自定义的只剩 1 条——官方插件从面板里消失，连它们的「发现更新」通知也失效（通知要求目录来源 == 默认 CDN URL）。**让用户改 env 指向我们的目录，等于拿他们的官方插件更新能力换我们的** ⇒ 不能当成分发路径推给用户。
- **徽标是「面板里被动可见」**：徽标只在用户打开 `/plugins` 时才看得到；桌面端「已安装」那一栏只有版本号、开关和删除，**没有更新按钮**。发布新版后不打开面板 ⇒ 永远不知道。

而需求是明确的（2026-11-02 用户：可接受「检查到更新、用户手动更」，**不能没反应**）。产品侧没有这条通道：`checkGithubUpdate` 没有调用方，插件也没有 notify 权限——**得由插件自己产出这个信号**。

## Decision

**1. 插件自带探测脚本**（`scripts/kimi-version-check.mjs`，装配进 `release/kimi/version-check.mjs`）：读本插件 manifest 的版本，比 GitHub 最新 Release（`/releases/latest` 重定向，不打 api.github.com）。只认 `x.y.z` 纯 semver。

**2. 挂在 `UserPromptSubmit` hook 上。** 这是宿主唯一把 hook 的 stdout 送进模型视线的通道：它的返回值会作为 `<hook_result hook_event="UserPromptSubmit">` 内容块挂到用户消息上（读 Kimi Code 2.4.1 发布物：`renderUserPromptHookResult` → `userPromptHookMessage` 取 `result.stdout` → `userPromptSubmitHookPart`）。`SessionStart` 的 hook 结果被**直接丢弃** ⇒ 不能用（那条路只适合做副作用）。

**3. 模型面散文进 routes（SKILL.md）**：上下文里出现「ptc-tools 有新版本」时，**先告诉用户**当前版本、最新版本与更新命令——用户不会自己知道有新版。

**4. 去重与节流**：15min 缓存（离线时也记时间，不让每条消息都卡一次超时）、同一版本只提醒一次、被无视满 7 天再提一次。**绝不阻塞用户回合**：出错不出声（fail-open）。

**5. `build:kimi` 加闸**：hook 命令里的 `./` 路径必须存在——hook 静默失效＝「有新版」这句话永远不出现，正是本 ADR 要消灭的病。

**6. 市场目录保留但不推**：`plugin-marketplace.json` 仍随包发布（指了目录的人能拿到面板徽标），但**不作为分发路径要求用户改 env**。

## Consequences

- 用户装上 7.7.0 之后：我们发新版 ⇒ **下一次发消息时，模型第一句就说**「ptc-tools 有新版本 7.8.0（当前 7.7.0）」+ 更新命令。不推目录、不改用户任何配置。
- 成本：每条用户消息跑一次 hook（读缓存 <1ms；每 15min 一次网络请求，~200ms，失败不阻塞）。
- 边界：这条链依赖两件事——「hook stdout 进上下文」（宿主实现，读发布物确认）与「模型会照 SKILL.md 说一句」（**模型不保证一定说**）。提示确实在模型输入里，用户也会在上下文里看到那条 `<hook_result>`；但想要「一定会被告知」，还得靠宿主自己的通知通道，插件够不着。
- 探针：`tests/kimi/version-check.test.mjs`（10 例：同版不出声 / 有新版出声且带更新命令 / 同版只提醒一次 / 一周后再提 / 离线静默 / tag 解析 / 无 manifest 静默 / **TTL 窗口内不重复问 GitHub** / **TTL 过期就重新问**）。**它当场抓到一个真 bug**：缓存里存了解析后的数组、后面又按字符串解析一次 ⇒ 静默退出（正是本 ADR 要防的病）。
- **缓存必须拉完就落盘**（7.7.1 修）：第一版只在「要提醒」时写 state ⇒ 已是最新（常态）时 `checkedAt` 永不落盘 ⇒ **当时的 6h TTL 形同虚设，每条消息都重新拉一次 GitHub**。实机证据：装好的 7.7.0 跑一遍后缓存文件是空的。探针加一例钉住（已是最新时也要落缓存）。

## 修订：TTL 6h → 15min（2026-11-02 实测后）

**病**：用户 09:33 装好 7.7.1（那时 7.7.1 正是最新）⇒ hook 查了一次、把 `checkedAt` 落盘 ⇒ **6h 盲区从那一刻起算**。11:25 发 7.8.0、12:23 发 7.9.0，**两次发布都被盲区吞掉**——用户看得见 GitHub 上有新 Release，插件却一声不吭。链上其他环节都是好的：宿主确实给 plugin hook 派了 `cwd=插件根目录` + `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT`（读 2.4.1 发布物确认），脚本读得到 manifest、缓存落在 `~/.kimi-code/cache/`，SKILL.md 里的「有新版先说一句」规则也已在用户的会话里生效。

**药**：TTL 6h → 15min（发布到「用户知道」的上限 = 一个窗口）。探针加两例钉住这个窗口：窗口内不再走网络（用缓存里的 latest 出声）、窗口过期就重新问——把 TTL 改回小时级，第 2 例即红。

**没做**：后台拉取（拉版本不阻塞用户回合）——那是更大的改法；15min 的一次网络请求（~200ms，超时 3s）每 15 分钟只落在一条消息上，先不做。
