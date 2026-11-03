# `.agents/` — ponytail（DSH 项目级 skill）

本目录放**上游第三方 skill**，不是本仓自己的代码。装它是因为 DSH harness 的项目级
skill 根就是 `<projectRoot>/.agents/skills`（另一个是 `<projectRoot>/.dsh/skills`）——
源码见 DSH 自带的 `@deepseek-ai/dsh-skill-filesystem`：

| 根 | 排名 | 说明 |
| --- | --- | --- |
| `<projectRoot>/.dsh/skills` | 100 | DSH 专有根 |
| `<projectRoot>/.agents/skills` | 200 | 跨 agent 通用根（本目录用的这个） |
| `~/.dsh/skills` | 400 | 用户全局（DSH 专有） |
| `~/.agents/skills` | 500 | 用户全局（跨 agent 通用） |

skill 文件格式要求（DSH 的 `parseSkillFile`）：YAML frontmatter 必须有 `name`（kebab-case，
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`）与 `description`（非空字符串）；其余字段
（`argument-hint` / `license` / `whenToUse` / `metadata` …）可选或被忽略。目录形态是
`<root>/<skill-name>/SKILL.md`，`<root>/*.md` 也算扁平 skill。

## 装了什么

上游 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)，MIT 许可
（许可证全文见 `LICENSE-ponytail`）。

| 文件 | 来自上游 | 作用 |
| --- | --- | --- |
| `skills/ponytail/SKILL.md` | `skills/ponytail/SKILL.md` | 惰性资深工程师模式（lite / full / ultra） |
| `skills/ponytail-review/SKILL.md` | `skills/ponytail-review/SKILL.md` | 改动的质量评审 |
| `skills/ponytail-audit/SKILL.md` | `skills/ponytail-audit/SKILL.md` | 全仓质量审计 |
| `skills/ponytail-debt/SKILL.md` | `skills/ponytail-debt/SKILL.md` | `shortcut:` 债台账 |
| `skills/ponytail-gain/SKILL.md` | `skills/ponytail-gain/SKILL.md` | 收益记分板 |
| `skills/ponytail-help/SKILL.md` | `skills/ponytail-help/SKILL.md` | 速查卡 |

文件**逐字复制**，未改写。常驻（always-on）规则集不在这里——它在仓库根的 `AGENTS.md`
「Ponytail 模式」一节（DSH 把项目根 `AGENTS.md` 注入每个会话的首个请求）。

## 上游版本

- 仓库：<https://github.com/DietrichGebert/ponytail>
- commit：`96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`（2026-10-29）
- 装入日期：2026-11-03

## 怎么更新

```sh
git clone --depth 1 https://github.com/DietrichGebert/ponytail.git /tmp/ponytail-src
for s in ponytail ponytail-review ponytail-audit ponytail-debt ponytail-gain ponytail-help; do
  cp "/tmp/ponytail-src/skills/$s/SKILL.md" ".agents/skills/$s/SKILL.md"
done
cp /tmp/ponytail-src/LICENSE .agents/LICENSE-ponytail
# 同步上面的「上游版本」commit 字段
```

更新后无需重启 DSH：skill provider 有文件 watcher（`SkillWatchManager`），目录变了会
自动失效并重新发现（本次安装即已实测：写入后本会话的 skill 目录立刻多出六个 ponytail）。

## 卸载

```sh
rm -rf .agents/skills/ponytail .agents/skills/ponytail-{review,audit,debt,gain,help}
# 再把 AGENTS.md 末尾「## Ponytail 模式」一节删掉
```

## 附注

- 本仓 `skills/` 目录是 **pi 扩展**发布的 skill（`package.json` 的 `pi.skills`），与这里的
  DSH 项目级 skill 根是两套东西——ponytail 只装了 DSH 这一侧，没有进 npm 包。
- ponytail 自带的 Claude Code / Codex hook（`hooks/`、`pi-extension/`、`commands/`）与
  DSH 无关，未安装：DSH 这条路是 **instruction-tier**，没有 `/ponytail lite` 那种跨会话
  持久化等级开关（等级只在单次 skill 调用内生效）。
