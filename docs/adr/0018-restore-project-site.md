# 恢复项目站点为第二个 workspace 成员

Status: accepted (2026-10-27)。issue #291 之后的独立恢复任务，无编号 issue（用户直接指派）。

## Context

干净室重写把旧实现整支归档进 `backup/main-legacy-20261026`，项目站点（`packages/website/`，VitePress，发布 GitHub Pages）随之一并消失。线上 <https://a1121611810.github.io/pi-ptc-subagents/> 仍在 serve 归档前的旧站——`pi.dispatch`、`ptc_subagent` 那套旧产品面——直到恢复部署为止。Pages 环境实测仍在（`build_type: workflow`、`github-pages` environment 都在），恢复零环境搭建。

旧站的治理依据是旧 ADR-0036（排除根门）/ 0037（文档不复制，build 时投影）/ 0038（按 main 不按 tag 部署），全部归档但理由未过期。不适配直接搬回的地方：旧站投影的 4 篇 usage 文档随重写不存在；`check-doc-claims.mjs` 绑的 19 条声称锚在旧单包 `src/` 常量上，全部失效；落地页工具名清单（`pi.dispatch`、`ptc_subagent`）不是本代真实表面。

## Decision

**1. 原样恢复骨架，`packages/website/` 成为 `@pi-ptc/website`**（private，不进 npm 包的根 `files` allowlist）。干净室规则只禁抄旧 `src/**` 扩展实现源码，站点不在此列（用户明示恢复）。VitePress 1.6.4 钉版不变。

**2. 根门排除从「结构上不在链上」改为「过滤器显式排除」。** 旧版根 build 是 `vp pack`，天然不含站点；本代根 build/check 是 `pnpm -r run`，会递归进所有成员。根脚本改为 `pnpm -r --filter=!@pi-ptc/website run build/check`，lint/fmt 配置各加 `packages/website/**` ignore。旧 ADR-0036 的理由原样成立：站点是第二个项目，它的红不该阻塞 npm 发布链。

**3. 投影源换成现存真实文档**（旧 ADR-0037 的「显式清单、无第二份拷贝」纪律不变）：七篇 route 册子（`packages/routes/docs/routes/*.md`，ADR-0013 模型面散文唯一出处，兼作使用文档）+ `docs/pi-version-matrix.md`。两份存活状态全景 HTML（`docs/prototypes/ptc-runtime-status.html`、`dispatch-engine-status.html`）原样拷进 `public/status/`——它们是带自有样式的完整 HTML 页，拷优于投影。`packages/website/docs/` 与 `public/status/` 进 `.gitignore`。

**4. 四道门随骨架恢复，`check-doc-claims.mjs` 有意不恢复。** `internal-links` / `style-scope` 机制原样（只吃构建产物，与代码无耦合）；`projection-coverage` 的读者面定义改为 `docs/*.md` + `packages/routes/docs/routes/*.md`；`landing-tool-names` 扫描根改为 `packages/`，前缀扩为 `ptc_|pi_task_|web_ds_`（`pi_task_ptc` 经 `TASK_BINDING_NAME` 常量声明进入注册集，与 `tests/route-registry-gates.test.mjs` 白名单同处置）。`doc-claims` 等人类向 usage 散文出现再重绑。counterfactual 脚本随门恢复（4 例全绿）。两个元测试（PR/部署同命令、README 表一致）未移植到 node:test，记为站点 README 的约定。

**5. CI 两 workflow 恢复并对齐本代**：`website.yml`（PR 上跑与部署完全相同的命令——#174 的教训原样继承）+ `pages.yml`（push main 部署，build 即门，旧 ADR-0038 理由成立），node 22 → 24，action 钉版与 ci.yml 统一。

## Consequences

- 合并后第一次 push main 即用新站覆盖线上过时旧站；vitepress 依赖树进锁文件（`allowBuilds` 补 `esbuild: false`——postinstall 仅为旧平台下载二进制，现代平台走 optionalDependencies 预置）。
- 反事实脚本的树拷贝/digest 排除 `.codegraph`：目录里有 codegraph 守护进程的 `daemon.sock`，`cpSync` 拷 socket 触发 Node 24 内部错误，且其日志文件运行期间必变会误伤「仓库未被改动」属性。
- 落地页文案重写为双 surface 真实声称（`ptc_run_code`/`ptc_workflow` + `pi_task_ptc`/`pi_task_codemode` 两扇派发门，`ptc_task_*` 任务面），旧站的 pi.dev 对比表与 gaps 节随之退役（README 无此内容，维护两面真实文本已是负担）。
- 缓做（记录在案）：人类向 `docs/usage/*.md` 新写、`doc-claims` 重绑、两个元测试移植。Route 册子是模型面口吻，人类阅读体验一般——拿现成真实内容先上线，二期补人类向文档。
