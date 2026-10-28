# 发版（release pi-ptc-subagents）

一个 loop 的规格。运行实例 = 一次发版。实现者按本文件执行，不应需要再问任何问题；有就问，问完改本文件。

## 触发

事件：用户说「发版」/「release」并（可选）给出版本号。无 schedule。

## 输入

- 目标版本号 `X.Y.Z`：用户给定，或 agent 按 CHANGELOG 新节内容提议（见「版本号规则」），在唯一 checkpoint 一并确认。
- 待发版的内容：已在 main（合并已完成），或带着未合并的功能分支（见步骤 0）。

## 版本号规则

- 新节含 `### Added`/`### Changed` → minor bump；只有 `### Fixed` → patch bump。
- major 只在用户明说时。

## 步骤

### 0.（可选）合并未并入的功能分支

前提：功能分支在独立 worktree 开发完，四件套 + `pnpm test` + 真 pi 冒烟已过，动语义的已对质 spec/ADR。

```bash
git merge --ff-only feat/xxx
```

- main 动过导致 ff 失败 → **自动 `git rebase main` 功能分支**（本仓线性主分支惯例，直推见 NOTES.md），rebase 后重试 ff；**有冲突才停下来问**。
- 合并后 `git push origin main`，然后 `git worktree remove ../<repo>-<分支后缀> && git branch -d feat/xxx`（先合再收再删）。

### 1. 发版提交

- CHANGELOG.md 顶插新节（**重写仓没有 `[Unreleased]` 段**，直接插最顶）；英文、Keep a Changelog 格式、含实测数字。
- `package.json` version → `X.Y.Z`。
- `kimi.plugin.json` version → 同一 `X.Y.Z`（`build:kimi` 会校验一致性，不一致即拒——一套版本号走到底，Kimi 面不另起版本线）。
- `git commit -m "chore(release): X.Y.Z——<一句话>"` 并 push main。记此 commit 为 R。

### 2. 发版前验证（独立发布 worktree）

```bash
git worktree add --detach ../<repo>-release R   # main 被主工作树占用，必须 --detach
cd ../<repo>-release
pnpm install
pnpm run check && pnpm run build && pnpm test && pnpm run lint && pnpm run fmt:check
scripts/version-smoke.sh                        # 全量：15 个 shim 版本 + PATH ceiling，fails 必须 = 0
pnpm run build:kimi && bash scripts/kimi-smoke.sh  # Kimi 面三腿：布局版本 / bundle 自包含 / 真 spawn 协议探针
npm publish --dry-run                           # 抄下 shasum（后面与 CI 对账的基准）
```

任一红：停下，按「失败分支」处理。

### 3. 唯一 checkpoint（push right 的终点）

此前全部自动完成。给用户三行 brief：

```
版本 X.Y.Z 待发。冒烟 16/16（<一行关键数字>）。
dry-run shasum: <hash>
CHANGELOG: <新节标题行>
确认推 tag vX.Y.Z？[y/N]
```

用户说 y 才继续。

### 4. 发布（CI，不是本地）

```bash
git tag -a vX.Y.Z -m "release X.Y.Z: <一句话>" R
git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes   # Kimi 面更新检测只认 Release 对象（/releases/latest 重定向）；漏了 = 用户永远收不到更新
gh run watch <publish run id> --exit-status
```

`publish.yml`（tags `[v*]` 触发）会：校验 tag ↔ package.json version → 四件套 + 仓库测试 → **trusted publishing**（OIDC 换短期凭证，无 NPM_TOKEN）→ 自动签 SLSA provenance。约 32s。

**本地 `npm publish` 是错路**：本机 token 状态与发布无关（见过 whoami 401 的幻觉排查）。

### 5. 核验（四件 + 一件附加）

1. run 绿 + 日志有 `+ pi-ptc-subagents@X.Y.Z` 行。
2. 等传播（60s–2m30s，**即时查不到 ≠ 没发上**）。
3. `npm view pi-ptc-subagents dist-tags.latest` == X.Y.Z。
4. `npm view pi-ptc-subagents@X.Y.Z dist.shasum` == 步骤 2 抄的 shasum；`dist.attestations` 有 SLSA provenance。
   5.（附加）空目录 `npm init -y && npm i pi-ptc-subagents@X.Y.Z`，`fs.readFileSync(node_modules/pi-ptc-subagents/package.json)` 直读验证（防 bun shim 假成功坑；`require('<pkg>/package.json')` 会被 exports 拒）。

### 6. 收尾

```bash
git worktree remove ../<repo>-release
```

向用户报告：版本号、shasum、provenance 在否、传播用时。

## 失败分支

- **冒烟红腿**：停止，不推 tag；**删掉发布 worktree**（它 detached 在旧 R 上，R 会变），修复走 main 新 commit 后从步骤 1 重走（重建成本 ~6s）。
- **dry-run shasum 与 CI shasum 不一致**：中止并调查——意味着构建不可复现，禁止假装没发生。
- **tag 已推但 publish run 红**：看日志修；修完**重打新 tag**（bump patch 或经用户同意复用版本），**绝不 unpublish**（传播后 unpublish 违反 npm 政策且伤下游）。
- **tag ↔ version 校验拒**：tag 名错了，删本地/远端 tag 重打（未发布时删 tag 无妨）。

## 完成判据

registry 上 `latest=X.Y.Z`、shasum 对账一致、provenance 在、干净目录可装可读；本地无遗留 release worktree 与临时 tag。
