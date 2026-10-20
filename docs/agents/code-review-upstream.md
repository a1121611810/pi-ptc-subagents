# code-review skill 的上游基线与同步裁决（2026-10-20）

本仓的项目级 skill [`SKILL.md`](../../.agents/skills/code-review/SKILL.md) fork 自开源技能集
`mattpocock/skills` 的 `skills/engineering/code-review/SKILL.md`，并在上面叠加了本仓专属的
OCR 确定性层、CodeGraph 证据层、Q9-D 升级机制与 doc-sync 手工路径。

**上游改了不会自动跟过来。** 本文件是「上游基线 + 逐条裁决」的唯一事实源；`SKILL.md` 只留一行
指向，不抄实体。

## 基线

- **上游**：`mattpocock/skills`（`github.com/mattpocock/skills`），skill 路径
  `skills/engineering/code-review/SKILL.md`（**不在仓根**，`code-review/SKILL.md` 会 404）
- **base-commit**：`3da8c011`（2026-10-07, #1208）——本仓最后一次同步到的上游状态
- **local-fork-of**：`e591684`（2026-09-23，本仓首次加入这个 skill 的提交）
- **last-synced**：2026-10-20

上游自己的文档里写着这条纪律（`docs/engineering/code-review.md`）：

> Keep a note of the commit you forked from so you can re-sync by hand.

只记 SHA 不够——SHA 只让「发现上游动了」变容易；要让「发现不了」变不可能，得靠机械闸
（见下方「机械闸」）。

## 逐条裁决表

上游 #1208（+5/−3）改了 3 处，外加上游文档里记录但**没有进 SKILL.md** 的 1 个已知 bug。
裁决口径：**优先采纳上游的意图，落地时按本仓实况改写，改写处逐条记在这里。**

| #   | 上游变更                                                                                                               | 裁决                    | 本仓理由                                                                                                                                                                                                                                                                                                                                      | 落点                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | standards 来源：从固定示例列表改为「搜仓库，且 `CODING_STANDARDS.md` / `CONTRIBUTING.md` 存在时必须在列」              | **adapt**               | 本仓**没有** `CODING_STANDARDS.md`，但**有** `CONTRIBUTING.md`（2026-10-03 `c1dda59` 引入，**晚于本仓 fork**）。它的 "House style" 三条（文档同步 / 测试可伪证 / `file:line` 只在受检处引）正是可判定的写码规范，而旧版 skill 的清单里**没有它**。上游 #1065 要修的失效形态（从记忆列清单，漏掉唯一带规则那份）在本仓**已经复现过一次**       | `SKILL.md` 第 6 步 + 「Standards 轴」节 |
| 2   | 两个 sub-agent 一起发出、**在前台**、并**消费它们返回的报告**                                                          | **adopt**               | 本仓比上游更危险：本仓自己造了后台派发。`src/tools/subagent.ts` 的 `background` 分支**只返回句柄**（`Started background task <ULID>`），报告须另用 `ptc_task_output` 轮询；`pi.dispatch` 同样有 `background: true`。旧版 skill 只写「并行 spawn」、未钉前台，第 9 步又预设报告已到手 ⇒ **后台化又不轮询 = 两轴永远空转**（上游 #1073 的形态） | `SKILL.md` 第 6 步                      |
| 3   | issue tracker 走「tracker doc」而不是写死 `docs/agents/issue-tracker.md`                                               | **adapt**               | 路径在本仓**恰好固定**（`docs/agents/issue-tracker.md`，AGENTS.md 已指），上游「路径可能不同」这层收益为零。真正脆的是旧版 skill 把 **`gh` 也写死**了 —— 上游 setup 支持 github / gitlab / local 三种 tracker，换轨即错。落点改为「按 AGENTS.md 的 `### Issue tracker` 块指向的 tracker doc，用哪个命令由那份 doc 写明」                      | `SKILL.md` 第 2 步 ①                    |
| 4   | 上游文档记录但**未进 SKILL.md** 的已知 bug：sub-agent 会重新调用 `/code-review` 再派代理（上游记录有人跑到 50+ agent） | **adopt（补上游漏的）** | 本仓同样裸奔。修法上游已给：两个 brief 各加一句禁令                                                                                                                                                                                                                                                                                           | `SKILL.md` 第 6 步                      |

## 本仓刻意偏离上游的地方

以下不是「漏搬」，是**故意不搬**。改动前先读这张表，别把它们当缺口补上。

| 上游做法                                                               | 本仓不搬的理由                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 把 12 条 Fowler smell **全文粘进** sub-agent brief                     | 本仓已把 12 条 + 触发式维度**实体化**在 `.opencodereview/rules/general.md`，由 OCR catch-all 逐文件下发。粘一份 = 制造第二事实源，正是 `SKILL.md` 自己写的「手抄过一次就漏过一次」 |
| `skills/engineering/code-review/agents/openai.yaml`（Codex UI 元数据） | 本仓 `.agents/skills/` 只被 pi 扫，pi 只读 `SKILL.md`；加一个没人读的文件 = 孤儿产物                                                                                               |
| `docs/engineering/code-review.md`（面向用户的使用说明页）              | 本仓 `docs/` 分层是「`docs/agents/` 给 agent、`docs/usage/` 给用户」。这个 skill 是 agent 工具不是产品功能，本仓不需要一层用户说明页                                               |
| spec 来源放宽到 `.scratch/` 与根 `specs/`                              | 本仓无此目录（`.scratch/` 在 `.gitignore` 里，根 `specs/` 不存在）；本仓的 `docs/specs/` + `docs/adr/` 更准                                                                        |
| 「无 spec 就跳过 Spec sub-agent」                                      | 本仓更严：spec 来源都不命中时**询问用户**，且**禁止用实现反推生成 spec**                                                                                                           |
| brief 400 字上限                                                       | 本仓 brief 承载 audit 1/2/3 + 6 条测试硬约束 + 声明—读点对照表，装不下                                                                                                             |
| 英文短 description                                                     | 本仓 description 承载 OCR / CodeGraph / Q9-D 的触发线索，换短的会掉可发现性                                                                                                        |

## 重同步命令

上游自 base-commit 起是否又动过 `code-review`：

```bash
gh api "repos/mattpocock/skills/commits?path=skills/engineering/code-review&since=2026-10-07T00:00:00Z" \
  --jq '.[]|"\(.sha[0:8]) \(.commit.author.date[0:10]) \(.commit.message|split("\n")[0])"'
```

取上游某个版本的文件：

```bash
gh api "repos/mattpocock/skills/contents/skills/engineering/code-review/SKILL.md?ref=<sha>" \
  --jq '.content' | tr -d '\n' | base64 -d
```

## 机械闸

记 SHA 挡不住「上游改了、本仓忘了」——SHA 只让**发现**变容易，让**发现不了**变不可能的是这道脚本：

```bash
pnpm run check:code-review-upstream
```

它读本文件的 `base-commit`，查上游自该 commit 起是否还有动过 `SKILL.md` 的 commit；有则列出未裁决项并以非零退出。

**它不进默认门禁**，理由与 `pnpm run compat:pi` 同理：它要联网，而 PR 门禁必须是离线的。它挂在发布前的手动检查位。改了上游基线记得同步更新本文件的 `base-commit` 与 `last-synced`。
