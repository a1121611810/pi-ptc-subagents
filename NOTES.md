# NOTES.md — 工具事实（本机/跨项目，发版 loop 直接消费）

原始笔记，未经整理的口径也记这里；规格只引用，不复制。

## npm 发布（pi-ptc-subagents）

- 发版走 **GitHub Actions trusted publishing**（`.github/workflows/publish.yml`，`tags: [v*]` 触发，OIDC 换短期凭证，仓库无 NPM_TOKEN secret）。本地 `npm publish` 是错路；本机 `~/.npmrc` token 已失效（whoami 401，PUT 404），与发布无关，哪天本地发包再重登。
- workflow 第一步校验 tag 与 package.json version 一致。
- 发布物核验四件：run 绿 + `+ pkg@ver` 日志行 / dist-tags.latest / shasum 对账（CI vs 本地 dry-run）/ SLSA provenance。registry 传播 60s–2m30s，即时查不到正常。
- 「空目录 npm install 假成功」坑：无 package.json 的目录里 bun-shim npm 可能显示 changed 1 package 但 node_modules 为空；干净安装核验必须 `npm init -y` 再装 + fs 直读 package.json（exports 字段挡 `require('<pkg>/package.json')`）。
- npm 包 `pi`（registry 现网）无 1.3.x/1.4.x——version-smoke 的 shim 自愈对 ceiling 版本不可用。

## pi 版本素材（冒烟/验证用）

- shim 装在本机 `/tmp`：`/tmp/pi086`（0.86.0/0.86.1）、`/tmp/pi-<ver>`（0.87.0 … 1.3.0）。ceiling 1.4.0 走 PATH（本机全局 bun 装的 @earendil-works/pi-coding-agent 1.4.0）。
- `scripts/version-smoke.sh`：默认 15 版全量；`SMOKE_VERSIONS="x.y.z"` 单版快查；四腿契约（run_code / 程序内 tools.read【0.99 分水岭】/ ptc_workflow parallel / wait:false + 任务面）；shim 缺了自动 `npm install pi@<ver>` 到 `$SHIM_ROOT`（默认 /tmp）。
- CLI 旗标版本考古（2026-10-28 实测）：`--no-extensions`/`--no-skills` floor 0.86 就有；`--no-mcp` **1.1.0 才出现**（0.86–1.0 无）。

## MiniMax CN（孩子的 provider）

- 认证头 **大小写敏感**：`X-Api-Key` 精确大小写（node fetch 小写一律 401）；`Authorization: Bearer` 也 401。取真实 key：`pi auth print-api-key --provider <id>`（models.json 里是 `!jq` 加密存储）。
- base URL `https://api.minimaxi.com/anthropic`；官方文档现推 `api.minimax.cn`（域名叫什么随时间漂，以实测 200 为准）。
- 自动前缀缓存：≥512 token，顺序「工具表→system→历史」；**命中率由前缀温度决定**（冷 ~24%，捶热 92–100%）；命中 0.1x 计价是彩蛋非依赖。
- pi 1.4.0 usage 带 `cacheRead`/`cacheWrite`/`cacheWrite1h`；`ANTHROPIC_LOG=debug` 可看真实请求形状（pi 请求带 `?beta=true`，与缓存命中无关）。

## GitHub

- 仓库 `a1121611810/pi-ptc-subagents`，owner 登录 `a1121611810`（手打易错成 a1121811810，GitHub 对 owner 笔误一律回 404 像「没权限」）。
- main 有保护规则但 owner 直推显示 "Bypassed rule violations"（推送成功）；PR 检查 `check` 在 PR 场景必需。
- 历史 release 实录：`notes/release-6.1.0-20261027.md`、`notes/release-6.2.0-20261028.md`（本目录外，ai-memory 项目笔记）；通用规程在 scratch 项目 `procedures/npm-release-and-verify.md`。

## 本机 agent 环境

- kimi-code 后台任务默认 600s 超时，长实验要 `disable_timeout`；`node --test` 吃 glob 不吃目录（`tests/*.test.mjs`）；execFileSync 默认 maxBuffer 1MB，灌 JSONL 流要开大。
- 判分器铁律（跨项目）：truth 定义是头号误差源（wc -l vs split、正则 multiline、includes 部分匹配、等价代码形式、答案区提取）——表面差异先归因再下结论。
