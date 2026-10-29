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

## 网站（@pi-ptc/website）

- `vitepress preview`（sirv）**启动时缓存 dist 文件清单**：`vitepress build` 重建后（chunk 带新 content hash），正在跑的 preview 会给新 chunk 回 404——index.html 是新的、JS 全死，页面看似渲染正常但没有任何交互。改了代码必须重启 preview 再验（2026-10-29 实测，排障花了十轮：点击无效、水合假象）。
- 内置浏览器 `tab.reload` 在这个预览上常 15s 超时，但导航其实提交了——报错后 `tab.get_state` 看 generation 确认，别直接重试。
- **VitePress 客户端路由会吃掉 `public/*.html` 的站内点击**（真根因，与 cleanUrls 无关）：router 的 click 拦截器对同源 `.html` 链接一律 `preventDefault` 走客户端导航，而 public 文件不在路由 manifest → 渲染 404 页（URL 不变，极具迷惑性；sirv fallback 又让 curl 状态码恒 200）。绕行三开关（源码 router.js）：`.vp-raw` 祖先类 / 任意 `target` 属性 / `download`。规矩：站内链 public 原始文件必带其一——落地页用 `class="vp-raw"`（同页整载），config 导航用 `target:"_blank"`（无类钩子）。cleanUrls 已顺手关回 false（2026-10-29）。
- vitepress preview 的 sirv 带 SPA fallback：**任何**未命中路径都回 200 + 404 文档体——`curl -w %{http_code}` 验不出死链，必须看 body/title（`curl -s URL | grep '<title>'`）或真点一次。上次「Status 修好」的假象就是这么来的。
- 门禁盲区（已补）：check-internal-links 只查「文件在不在」，查不出客户端路由拦截——第五道门 `check-router-links.mjs`（hashmap 感知：同源可拦截链接必须命中 VP 路由或带绕行属性）现在盯这一类，反事实已验证。

## GitHub

- 仓库 `a1121611810/pi-ptc-subagents`，owner 登录 `a1121611810`（手打易错成 a1121811810，GitHub 对 owner 笔误一律回 404 像「没权限」）。
- main 有保护规则但 owner 直推显示 "Bypassed rule violations"（推送成功）；PR 检查 `check` 在 PR 场景必需。
- 历史 release 实录：`notes/release-6.1.0-20261027.md`、`notes/release-6.2.0-20261028.md`（本目录外，ai-memory 项目笔记）；通用规程在 scratch 项目 `procedures/npm-release-and-verify.md`。

## 本机 agent 环境

- kimi-code 后台任务默认 600s 超时，长实验要 `disable_timeout`；`node --test` 吃 glob 不吃目录（`tests/*.test.mjs`）；execFileSync 默认 maxBuffer 1MB，灌 JSONL 流要开大。
- 判分器铁律（跨项目）：truth 定义是头号误差源（wc -l vs split、正则 multiline、includes 部分匹配、等价代码形式、答案区提取）——表面差异先归因再下结论。
