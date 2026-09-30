# ocr 项目规则(rule.json)作者手册

本仓的项目评审规则只有一份事实源:**仓库根的 `.opencodereview/rule.json`**(不是 `.ocr/rule.json`)。
规则正文在 `.opencodereview/rules/*.md`,是喂给 LLM reviewer 的 per-file checklist。
`rule.json` 是纯 JSON,**没有头部注释**,所以语义都写在这份手册里。

**何时到达本文件**:给一类新文件加锚点;调 `merge_system_rule`;某条规则「配了却没生效」要排查;
新增一个 `.opencodereview/rules/*.md`。命令的完整 flag 列表以 `ocr <cmd> --help` 为准,本文只记
本仓会踩到的非显然语义。

## 1. Schema

```json
{
  "rules": [
    {
      "path": "src/runtime/protocol.ts",
      "rule": ".opencodereview/rules/ptc-protocol-pair-correctness.md",
      "merge_system_rule": false
    }
  ]
}
```

- `ProjectRule` 的形状是 `rules: [{path, rule, merge_system_rule}]`,**不是**系统规则那种
  `default_rule + path_rule_map`。
- `path` 是 gitignore 风格 pattern,相对仓库根。
- `rule` 是相对**该 rule.json 所在目录**的路径(本仓即仓库根)。实证:把 rule.json 复制到别处而不
  复刻 `.opencodereview/rules/` 布局,ocr 会刷一串 `WARNING: rule file not found: .opencodereview/rules/*.md`,
  并且所有条目静默失效、全部落到兜底。

## 2. first-match-wins:数组顺序就是优先级

数组里**第一条 path 匹配上的规则生效**,后面的同类 pattern 被静默遮蔽——没有告警。两个可复现实验
(用副本跑 `ocr rules check --rule <副本> <file>`,不碰真实 rule.json):

| 变体 | 改动                                                             | 结果                                                                                                                                                |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 把 catch-all `**` 挪到数组**最前**                               | `src/runtime/protocol.ts` / `tests/dispatch-helpers.test.ts` / `docs/adr/0022-background-dispatch.md` 的 `Pattern` 全部变成 `**`,专用规则被整片吃掉 |
| B    | 把 `tests/dispatch-*.test.ts` 挪到 `tests/**/*.test.ts` **之后** | `tests/dispatch-helpers.test.ts` 命中 `tests/**/*.test.ts`(test-discipline.md),更严的 test-discipline-oracle.md 被遮蔽                              |

由此两条硬纪律:

1. **catch-all `**` 永远放数组最后一条。**
2. **更具体的 pattern 排在更宽的 pattern 之前**:`tests/dispatch-*.test.ts` 在
   `tests/**/*.test.ts` 之前,`src/runtime/worker-*.ts` 在 `**` 之前,`docs/**` 也在 `**` 之前。
   排新条目时,先确认没有更宽的 pattern 排在它前面。

## 3. merge_system_rule 取舍

- `true` = 项目规则**与**通用系统检查并存。合并后的文本带两段标题:`## System-Specific Rules
(Mandatory)` 与 `## User-Specific Rules (Mandatory)`。
- `false` = 只用项目规则,输出里**完全没有** `System-Specific` 段。

实测(`ocr delegate rule --format json <file>` 的 `groups[].rule` 文本):`general.md` 本体 25 行;
`README.md` 命中 `**` + `true`,解析出 54 行,两段都在;`src/runtime/protocol.ts` 是 `false`,
解析出 33 行且没有系统段。行数随 ocr 版本变,两段/一段的差别不会变。

**默认用 `true`。** 只有「这个文件的检查必须 100% 由项目规则定义,通用检查会给出噪音或误导」时才用
`false`——本仓只有契约层(protocol / worker / bgdispatch / render)用 `false`。文件被移走或重命名时
锚点会静默失配,整条审计退化成通用 checklist,`true` 至少还留着通用兜底。

catch-all 兜底层固定是数组末尾这一条:

```json
{ "path": "**", "rule": ".opencodereview/rules/general.md", "merge_system_rule": true }
```

## 4. 文件类型覆盖(最容易踩的坑)

「解析层收什么」和「选择层收什么」是两件事,混起来会得出错误结论。

| 扩展名           | `ocr delegate preview` / `ocr review` | `ocr scan`                                                    | `ocr rules check` / `ocr delegate rule` |
| ---------------- | ------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `.ts`            | 收(src/ 收;`tests/**` 除外,见下)      | 收                                                            | 收                                      |
| `.json`          | 收                                    | 收                                                            | 收                                      |
| `.mjs`           | 收                                    | 收                                                            | 收                                      |
| `.yml` / `.yaml` | **不收**                              | 收(`pnpm-lock.yaml` 除外,`default_path`)                      | 收                                      |
| `.md`            | **不收**(`unsupported_ext`)           | 列在 `files` 里但 `will_review: false`,同样 `unsupported_ext` | **收**                                  |

实测数字(2026-09-30,工作树 174 个文件):

- `ocr scan --preview --format json`:`reviewable_count = 57`、`excluded_count = 117`。70 个 `.md`
  **全部** `exclude_reason: unsupported_ext`;4 个 CI workflow `.yml` + 5 个 `.mjs`
  (`scripts/*.mjs` 与 `docs/research/prototype-*/`)全部 `will_review: true`;46 个 `tests/` 下的
  `.ts` 是 `default_path`。
- `ocr delegate preview --commit 5b54601`(ADR-0023 + 账本 + 词表同步,9 个文件):
  `reviewable_count = 1`,唯一可审的是 `.opencodereview/rule.json`;其余 8 个全是 `.md`、
  `unsupported_ext`。纯文档 commit `67136a9`(4 个文件)直接 `reviewable_count = 0`。
- `ocr delegate rule --format json $(git ls-files)`:**172/172 全部解析出 group**,`.md` 也在内。

结论:

- **给 `.md` 加锚点不会让 OCR 去审 `.md`。** `docs/**` 锚在 `ocr scan` 里同样只解析、不审。
  这条锚点的实际用途是:自己枚举文档路径显式传给 `ocr delegate rule` 取 checklist。
- **`tests/**` 的 oracle 规则同理**:`ocr delegate preview --commit 467c1ac` 显示 25 个文件里
  reviewable 9、excluded 16,16 个全是 `default_path`。要审测试,自己从 diff 里枚举测试文件,
  显式传 `ocr delegate rule --format json <那些路径>`。
- **CI workflow / 脚本走 `ocr scan`**:`ocr scan --path .github/workflows` 会真的审 `.yml`;
  它们在规则侧命中 `**`(general.md),因为没有更具体的锚。

## 5. 验证命令

```bash
# 单文件:看 Source 是 Project 还是 System built-in
ocr rules check src/runtime/protocol.ts
ocr rules check docs/adr/0022-background-dispatch.md

# 批量覆盖:groups[].source != "project" 的文件就是裸奔在 system built-in 上的
ocr delegate rule --format json $(git ls-files 'src/*.ts') \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('SYSTEM-ONLY:',[f for g in d['groups'] if g['source']!='project' for f in g['files']])"
#   tests/ 同理,把文件列表换成 $(git ls-files 'tests/*.test.ts' 'tests/**/*.test.ts')

# 改完 rule.json 的回归口径:SYSTEM-ONLY 必须为空
ocr delegate rule --format json $(git ls-files 'src/*.ts')
```

当前状态(2026-09-30):`src/*.ts` 33 个文件、`tests/**` 5 个 pattern(`tests/dispatch-*.test.ts` /
`tests/unit/dispatch-*.test.ts` / `tests/e2e/**/*.test.ts` / `tests/integration/**` /
`tests/**/*.test.ts`),SYSTEM-ONLY 都是空。

`ocr rules check` 只验一个文件,发现不了漏网;批量那条是唯一的漏网门禁
(`.agents/skills/code-review/SKILL.md` 第 3 步的 health gate 就是它在 `src/` 上的实例)。

## 6. 孤儿规则与悬空引用

- **孤儿规则**:`.opencodereview/rules/` 下任何没被 `rule.json` 引用的 `.md` 都是死规则,OCR 永远不会发出去。
- **悬空引用**:`rule.json` 指向的 `.md` 不存在时,ocr 只刷 `WARNING: rule file not found`,该条目
  **静默失效**,匹配的文件掉到下一条 pattern(通常就是 `**`)。

两个方向用同一条命令查:

```bash
python3 - <<'PY'
import json, pathlib
d = json.load(open('.opencodereview/rule.json'))
refs = {r['rule'].split('/')[-1] for r in d['rules']}
files = {p.name for p in pathlib.Path('.opencodereview/rules').glob('*.md')}
print('孤儿规则(OCR 永远不会发):', sorted(files - refs))
print('悬空引用(rule.json 指向不存在的 .md):', sorted(refs - files))
PY
```

两条输出都必须是空。**这条命令不能被 `ocr delegate rule` 的 JSON 替代**:`groups[]` 给的是
`pattern` / `source` / `files` / 解析后的**规则正文**,没有「这份正文来自哪个 .md」这一列,
从正文反推文件名不可靠。

锚点是否还活着,用 `ocr rules check <file>` 看 `Pattern:` 那行(或第 5 步的批量命令),别自己用
fnmatch 模拟 glob——ocr 的 `**/` 语义与 Python `fnmatch` 不同:`tests/e2e/**/*.test.ts` 在 ocr 里匹配
`tests/e2e/bgdispatch.test.ts`,在 `fnmatch` 里不匹配,照着 fnmatch 写检查会得到假的悬空报告。

## 7. 写新规则文件的模板

```markdown
# <名字> (audit <x>, 阻塞级)

适用文件:<具体文件列表>。规则解析层收什么 / 文件选择层收什么,见本文第 4 节。

## 风险

<为什么这类缺陷是 silent failure,或引用一次真实教训>

## 必查

1. <reviewer 可以逐条执行的动作,点名具体文件 / 常量 / 命令>
2. ...

## 阻塞触发

- <条件> → PR 阻塞。

## 严重性升级(Q9-D)

<升级并给理由(silent failure:precision 补不了 recall 缺口),或不升级并给理由(visual contract 之类)>
```

写作纪律(与 `.opencodereview/rules/` 现有 9 份文件一致):

- 必查项写动作,不写「注意质量」这类空话;每条点名具体文件、常量名或可复制的命令。
- 严重性升级一节必须给出**理由**,不能只写「升级」。
- 规则正文里的路径、pattern、行号同样是会被 review 的对象,写错等于给下一个评审埋雷
  (`ptc-worker-lifecycle.md` 曾把不存在的 `src/runtime/worker-state.ts` 写进「适用文件」行)。

## 8. 命令速查

`ocr --help` / `ocr <cmd> --help` 是完整 flag 的唯一事实源(本节只列本仓流程会用的):

| 命令                   | 本仓用到的 flag                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocr delegate preview` | `--from <ref> --to <ref>` 或 `--commit <sha>`、`-f json`、`-B <spec.md>`、`--exclude '<gitignore 风格>'`                                      |
| `ocr delegate rule`    | `--format json <paths...>`(路径要自己给,preview 列表不够用)                                                                                   |
| `ocr rules check`      | `<file>`、`--rule <json>`(试规则变体时用,不动真实 rule.json)                                                                                  |
| `ocr review`           | `--effort low/medium/high`、`--max-tools <n>`、`--no-filter`、`--audience agent`、`--resume <session-id>`、`--rule .opencodereview/rule.json` |
| `ocr scan`             | `--path <dirs,逗号分隔>`、`--no-plan`、`--preview`、`--resume <session-id>`                                                                   |
| `ocr session`          | `list` / `show` / `compare`(跨轮 finding 差异机械对比,不要靠记忆)                                                                             |

`--no-filter` 值得单独记:后置过滤正是 recall 的杀手,阻塞级 finding 恰是被它滤掉的那类。

ocr 版本:2026-09-30 实测 `open-code-review v1.12.10 (579b931) darwin/arm64`,本文所有行为断言都在
这个版本上测过。换版本后先跑第 4 节的 `ocr scan --preview --format json` 与第 5 节的批量命令复核。
