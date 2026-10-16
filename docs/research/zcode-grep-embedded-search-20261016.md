# ZCode 增强版 grep 调研：embedded search branch 与 ripgrep WASM 双轨

> 调研日期: 2026-10-16。回答「开源版 ZCode 里增强版的 grep 跟普通 grep 有什么不一样」。
> 方法: 一手源码精读，无二手描述。所有引文为 zai-org/ZCode 仓库内相对路径 + 行号。
> 复核命令: `git clone --depth 1 https://github.com/zai-org/ZCode /tmp/zcode-research`
>
> HEAD 快照: zai-org/ZCode `aac4755666d09fdcd70272fcf063c077a639015f` (2026-10-10, v3.15.1)

## 0. 结论对照表（增强版 vs 普通 grep）

ZCode 的「增强 grep」是**两条互补的线**，默认同时生效：

- **A. embedded search branch（默认开）**: 模型面隐藏 direct `Grep`/`Glob` 工具，Bash 里的
  `grep` 命令被启动 prelude 注入的 shell function 劫持，转发到随包分发的 `ugrep`；
  `find` 同理劫持到 `bfs`，系统无 `rg` 时补齐随包 `rg`。
- **B. direct `Grep` 工具升级（fallback 分支）**: 工具底层从「TS 文件遍历 + JS 正则」换成
  worker 线程里跑的 ripgrep WASM（`ripgrep@0.3.1` npm 包），失败时降级 JS fallback。

| 维度                      | 普通 grep（系统 GNU grep）    | ZCode 增强版                                                                                                                                                                                                                                                      | 证据                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型面入口                | Bash `grep` 或工具            | embedded 分支：provider 看不到 Grep/Glob，一律走 Bash `grep`；direct 分支才有 Grep 工具                                                                                                                                                                           | `apps/zcode-cli/packages/core/src/embedded-search/capability.ts:4`（默认开）；`apps/zcode-cli/packages/core/src/tool/handlers/index.ts:217-223`（跳过注册）；`apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts:21-26,47-53`（unregister + provider-visible 过滤） |
| 执行引擎                  | 系统 grep（BRE/ERE）          | 随包 `ugrep 7.8.4`（桌面/SEA/remote 固定 SHA-256 构建；rg 用 Microsoft `ripgrep-prebuilt 14.1.1`）                                                                                                                                                                | `scripts/native-search-tools-config.mjs:40-44`；`docs/runtime-tools/embedded-search-native-build.md:61-68`                                                                                                                                                                                  |
| 默认参数                  | 无                            | `ugrep -G --ignore-files --hidden -I --exclude-dir={.git,.svn,.hg,.bzr,.jj,.sl}`：即默认 BRE 语法、遵守 .gitignore 类 ignore 文件、搜隐藏文件、跳过二进制、排除 VCS 目录                                                                                          | `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts:21-32`；参数顺序合同 `docs/runtime-tools/embedded-search-native-build.md:226`                                                                                                                                         |
| 正则引擎                  | POSIX BRE/ERE                 | ugrep：DFA（带复杂度上限的 state/edge 与 position-set，防 ReDoS 式内存耗尽），`-P` 用 PCRE2（Linux/Windows 为 pcre2jit）；用户 `-E`/`-F`/`-P` 可覆盖默认 `-G`                                                                                                     | `docs/runtime-tools/embedded-search-native-build.md:63-67`（7.5.0→7.8.4 是有意的安全偏离）；E2E 覆盖 `embedded-search-native-build.md:298`                                                                                                                                                  |
| 压缩文件/archive 内搜索   | 不支持（要 zgrep 等）         | `-z` 系留给系统 grep 兼容，embedded grep 用 `--decompress` 搜 gzip/bzip2/zstd/Brotli/zip/tar                                                                                                                                                                      | `docs/runtime-tools/embedded-search-native-build.md:109,228,304`                                                                                                                                                                                                                            |
| .gitignore 语义           | 无（要 --exclude-dir 手工配） | `--ignore-files` 默认开（ugrep 读 .gitignore/.ignore 等）                                                                                                                                                                                                         | `embedded-search-prelude.ts:23`                                                                                                                                                                                                                                                             |
| 特殊参数兼容              | 全量                          | **bypass 列表**：遇到 `-*-filter*`、`-*-pager*`、`-*-view*`、`-*-format-open*`、`-*-config*`、`---*`、`-@*`、`-*-save-config*`、`-[Zz]*`、`-[!-]*[Zz]*`、`--null`、`--null-data` 自动绕回系统 `grep "$@"`（保 GNU null-data/短选项语义、避开 ugrep 压缩选项歧义） | `embedded-search-prelude.ts:16-17,201-208`；`docs/runtime-tools/embedded-search-native-build.md:227-228`                                                                                                                                                                                    |
| 工具面语义（direct 分支） | —                             | ripgrep 语义：full regex、glob/type 过滤、multiline（`-U --multiline-dotall`）、-A/-B/-C 上下文、`-o`、head_limit/offset 分页、三输出模式（content/files_with_matches/count）                                                                                     | `apps/zcode-cli/docs/design/v2/tool/09-grep.md:31-57`；`apps/zcode-cli/packages/adapters/src/fs/index.ts:924-979`（`--no-config --hidden --max-columns 500`、VCS glob 排除、`-e pattern`）                                                                                                  |
| 输出治理                  | 无（模型自己 head）           | 三层硬顶：工具侧 20KB 模型字节 + 默认 head_limit 250（0=显式无限但仍吃 resultBudget，超限落盘 artifact）+ 30s 超时；结果按 mtime 新近优先排序                                                                                                                     | `apps/zcode-cli/packages/core/src/tool/handlers/grep.ts:23-24,170-187`；`fs/index.ts:52-53,562,1815-1830`；`docs/design/v2/tool/09-grep.md:88-90`                                                                                                                                           |
| 取消契约                  | Ctrl-C 杀进程                 | WASM 搜索跑在 worker 线程，abort/30s 超时可 `terminate()` 整个执行单元（注释：主线程跑 WASI 会卡死 event loop，session/stop 无法被处理）；port 错误码 `cancelled` → 工具契约 `grep_cancelled`/handler 映射 `tool_cancelled`，用户取消不误报成 I/O 失败            | `fs/index.ts:79-109,1047-1098`；`grep.ts:92-104`；`apps/zcode-cli/packages/contracts/src/tools/grep.ts:173-180`；`docs/design/v2/tool/09-grep.md:92-99`                                                                                                                                     |
| read-state 联动           | 无                            | Bash `grep`/`egrep`/`fgrep` exit 0 且输出未截断时，runtime 保守识别并把文件回填进 readFileState → Edit/Write 的 read-before-write guard 认可「已读」                                                                                                              | `docs/runtime-tools/bash-read-file-state.md:9,24-26`；`apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-sources.ts:224-263`                                                                                                                                                    |
| 权限/审批                 | 同 Bash                       | embedded 分支 grep 走 Bash（needsApproval 随 Bash）；direct Grep 工具 readOnly、needsApproval:false、无副作用                                                                                                                                                     | `apps/zcode-cli/docs/design/v2/tool/09-grep.md:74-82`；`grep.ts:160-169`                                                                                                                                                                                                                    |
| 失败可见性                | exit code                     | 结构化错误码：`grep_invalid_pattern / grep_invalid_path / grep_permission_denied / grep_too_large / grep_cancelled / grep_io_error`；ripgrep exit 1（无匹配）视为正常空结果，exit 2 才映射错误                                                                    | `apps/zcode-cli/packages/contracts/src/tools/grep.ts:173-180`；`fs/index.ts:547-556`；`docs/design/v2/tool/11-ripgrep-wasm-packaging.md:60-64`                                                                                                                                              |

## 1. Embedded search branch：Bash grep 被「偷换」的全链路

### 1.1 分支判定与模型面

- 全局开关硬编码默认开：`ENABLE_EMBEDDED_SEARCH_BRANCH = true`，可经
  `embeddedSearchBranchEnabled` 覆盖；唯一硬条件是 **Bash 工具可用**
  （allowlist 含 Bash 且不在 disallowlist）——与 shell 方言无关，CMD 下也隐藏
  Glob/Grep（provider-visible 面与 runtime prelude 注入是两条独立决策）。
  `apps/zcode-cli/packages/core/src/embedded-search/capability.ts:4,21-44`，
  `apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts:11-19`。
- embedded 开启时：注册表跳过 `Glob`/`Grep`（`handlers/index.ts:217-223`）；
  Bash 工具 description 的 avoid list 从 ``find`,`grep`,`cat`…`` 缩到
  ``cat`,`head`,`tail`,`sed`,`awk`,`echo``（`tool/handlers/bash-prompt.ts:6-8`）；
  Explore 子代理 prompt 从 "Use Glob/Grep" 换成 "Use `find`/`grep` via Bash"
  （`core/src/subagent/explore.ts:21-32`）；EnterPlanMode 描述同步换分支
  （`handlers/index.ts:284-293`、`tool/handlers/plan-mode.ts:141-160`）。
- Bash 请求只有在 `embeddedSearch.enabled === true`、backend 存在、且 shell selection
  是 posix/git-bash 时才携带 `bashPrelude`：
  `core/src/tool/handlers/bash.ts:440-452`；prelude 注入总开关
  `shouldInjectEmbeddedSearchBashPrelude()` 同样硬编码 true，shell 支持判定
  `dialect === "posix" || "git-bash"`：`core/src/embedded-search/shell.ts:4,11-15`。
- `embeddedSearch` 上下文由 call-runner 组装：backend 来自 runtime config，
  `findAndGrepEnabled: false` 来自桌面设置 `nativeSearchEnhancementsEnabled`（默认启用，
  只控制 prelude 是否映射 find/grep，不控制工具隐藏）：
  `core/src/tool/executor/call-runner.ts:428-432`；
  `docs/runtime-tools/embedded-search-native-build.md:26-36`。

### 1.2 prelude 注入与 shell function

- adapter 侧把 prelude 物化成 per-session 脚本（0600 权限、内容 hash 命名），拼成
  `. '<script>'\n<command>` 再执行；只支持 posix/git-bash：
  `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts:39-78,95-108,125-127`。
- 生成的 shell function（`embedded-search-prelude.ts`）：
  - 先 `unalias find/grep`，再定义 `find()`/`grep()`；Windows Git Bash **不劫持 find**
    （无 bfs 分发），保留系统 find：`embedded-search-prelude.ts:51-61,105-126`。
  - `grep()` 体内先做 bypass 扫描（任一参数命中 `GREP_BYPASS_CASE_PATTERN` 即
    `command grep "$@"` 直出），再检查 backend binary 可执行
    （`command -v <backend> || { command grep "$@"; return; }` —— 缺失即回退系统 grep），
    最后才以默认参数 + `"$@"` 调随包 binary：`embedded-search-prelude.ts:180-208`。
  - `rg` 是**缺失补齐**而非强制 shadow：只有 `unalias rg; command -v rg` 都找不到时
    才定义 rg function；internal-cli backend 无原生 rg 直接不补；
    `native-binaries` 且 `rgCommand === "rg"`（即随包的就是 PATH 上那个）也不重复定义。
    补的 rg 不加任何默认 flags，`"$@"` 原样透传：`embedded-search-prelude.ts:151-178`；
    `docs/runtime-tools/embedded-search-native-build.md:153,229`。
  - Git Bash 下所有 Windows 绝对路径参数转成 `/c/...` 形式：
    `embedded-search-prelude.ts:73-103`。

### 1.3 backend 解析与随包二进制

- 三类 backend 的 union 合同：`internal-cli`（命令转发，含
  `ZCODE_EMBEDDED_SEARCH_COMMAND` 覆盖路径，`__internal-search` 入口）、
  `argv0-dispatch`（单 binary 按 ARGV0 分发，contract 保留）、
  `native-binaries`（find/grep/rg 三个独立路径）：
  `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts:67-106`。
- **当前代码默认 `native-binaries`**：从 `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` /
  `ZCODE_RG_BINARY` 读绝对路径，缺省回退裸 `bfs`/`ugrep`/`rg`（PATH 查找）：
  `apps/zcode-cli/packages/bootstrap/src/app/embedded-search-backend.ts:7-28`，
  装配于 `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:133-137`。
- env var 名与随包目录声明：`packages/shared/src/runtime-tool-runtime.ts:23-39`
  （remote 版本表 `:41-61`：Linux bfs v4.1.1-2 / ugrep v7.8.4-1 / rg v14.1.1-1，
  Darwin remote 仍 rg13 v13.0.0-10）。
- host/server 启动时 login shell PATH 回放 → 工具目录 append 到 PATH（保留用户命令优先级）
  → 注入三个 env var：`packages/services/src/runtime-tools/runtimeCommandEnv.ts:155-211`；
  解析顺序 env var → 随包资源目录 → PATH：`runtime-tools/runtimeToolResolver.ts:101-161`。
- 版本与安全基线：bfs 4.1.1（`--enable-release --with-oniguruma`）、ugrep 7.8.4
  （从早期 7.5.0 有意升级，拿 DFA state/edge 与 position-set 复杂度上限，防恶意正则在
  编译阶段耗尽内存——安全偏离，不得表述为沿用旧版）、rg 固定 Microsoft
  `ripgrep-prebuilt v14.1.1-1`（全平台固定 SHA-256，producer 不得重打包）：
  `scripts/native-search-tools-config.mjs:31-50`；
  `docs/runtime-tools/embedded-search-native-build.md:57-70`。
- 平台启用面：macOS/Linux 桌面与 remote 带 bfs+ugrep+rg；Windows 只带
  ugrep+rg（find 回退 Git Bash/system，不伪移植 bfs）：
  `scripts/native-search-tools-config.mjs:111-124`；
  `docs/runtime-tools/embedded-search-native-build.md:11-19`。
- legacy：`scripts/download-ripgrep.mjs` 现在只是 Darwin remote 的 rg13 兼容下载器
  （`LEGACY_REMOTE_RIPGREP_VERSION`，`:13-16` import），desktop/SEA 不再走它。

## 2. Direct Grep 工具：ripgrep WASM 化

embedded 分支关闭（或 Bash 不可用）时的 direct `Grep`，以及 Explore 之外的任何回退面：

- core handler 只依赖 `FileSystemPort.searchText`，core 不碰 fs/child_process/WASI：
  `apps/zcode-cli/packages/core/src/tool/handlers/grep.ts:32-105`；
  合同边界 `docs/design/v2/tool/09-grep.md:82-86`。
- Node adapter 默认 ripgrep WASM（`ripgrep@0.3.1`，ESM、WASM 字节码随包嵌入、不依赖
  平台原生二进制、不经 shell）：`docs/design/v2/tool/11-ripgrep-wasm-packaging.md:24-32`。
  WASM 在 **worker 线程** 内 `import("ripgrep")` 执行（`nodeWasi:false` + preopens），
  abort/30s 超时 `terminate()`；主线程直接跑会卡死 event loop、用户 stop 无法处理：
  `apps/zcode-cli/packages/adapters/src/fs/index.ts:79-109,1047-1058`。
- 参数映射：`--no-config --hidden --color never --max-columns 500`、VCS 目录
  `--glob '!x' --glob '!**/x/**'`、multiline=`-U --multiline-dotall`、content 模式
  `--json`（`-o`/`-A/-B/-C`）、files/count 模式 `-c`、glob/type 转 `--glob`、
  pattern 一律 `-e <pattern>`（防 `-` 开头 pattern 被当 flag）、`--` 分隔：
  `fs/index.ts:924-1027`。
- 降级链：WASM 初始化/运行失败抛 `RipgrepRuntimeFailure` → JS fallback（TS 遍历 + 正则，
  遍历/读文件间持续查取消）；`textSearchEngine: "javascript"` 可强制：
  `fs/index.ts:452-471,576-640`；`docs/design/v2/tool/11-ripgrep-wasm-packaging.md:63-64`。
- 语义细节：ripgrep exit 1 = 无匹配（空结果，非错误）、exit 2 = 映射
  `invalid_pattern`/`not_found`/`permission_denied`/`io_error`；零长 match 保留空串
  entry、multiline match 按 `rg -n -o` 展开成多条递增 lineNumber 的非空行：
  `fs/index.ts:547-556`；`docs/design/v2/tool/09-grep.md:51-57,92-99`。
- 输出治理：工具 20KB 模型上限（超限走 artifact 落盘、session 保留）、默认
  head_limit 250 / offset 分页、30s 超时（default=max，不允许调用方覆盖）、
  文件列表按 mtime 新近优先：
  `grep.ts:23-24,170-187`；`fs/index.ts:52-53,562,1240-1270,1815-1830`。

## 3. 回退矩阵（什么时候退化回「普通 grep」）

| 条件                                       | 行为                                                                                    | 证据                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| backend binary 缺失/不可执行               | shell function 体内 `command grep "$@"` / 系统 find 直出                                | `embedded-search-prelude.ts:188-191`                                                                                        |
| grep 参数命中 bypass 列表                  | 同上，绕开 ugrep                                                                        | `embedded-search-prelude.ts:201-208`                                                                                        |
| Windows CMD / legacy shell                 | 不注入 POSIX function；若 Bash 不可用则整个 embedded branch 关闭、direct Glob/Grep 暴露 | `embedded-search-prelude.ts:67-71`；`capability.ts:33-38`；`docs/plan/trajectory/embedded-search-provider-visible.md:43-44` |
| Windows Git Bash                           | 只劫持 grep（→ugrep），find 留系统；路径转 `/c/...`                                     | `embedded-search-prelude.ts:51-52,97-103`                                                                                   |
| 设置页关掉 nativeSearchEnhancementsEnabled | 不定义 find/grep function，只保留 rg fallback；**不影响** Glob/Grep 隐藏                | `execution.port.ts:104-106`；`call-runner.ts:428-432`；`embedded-search-native-build.md:28`                                 |
| 系统已有 rg                                | 随包 rg 不 shadow，用户版本优先                                                         | `embedded-search-prelude.ts:172-177`；`docs/runtime-tools/ripgrep-runtime.md:14-15`                                         |
| WASM 不可用（direct 分支）                 | JS fallback；再失败按原始错误归类                                                       | `fs/index.ts:463-470`                                                                                                       |
| Darwin remote                              | 仍部署历史 rg13，不迁 native-search 链                                                  | `packages/shared/src/runtime-tool-runtime.ts:48-54`                                                                         |

## 4. 文档 ↔ 代码漂移记录

- `docs/plan/trajectory/embedded-search-provider-visible.md` 是计划快照：说「第一版默认
  `internal-cli` backend」「`argv0-dispatch` 保留、当前默认仍是 internal-cli」
  （:33,38,49,71）。**代码已前进**：默认 backend 已是 `native-binaries`
  （`embedded-search-backend.ts:23-28`），native-build spec 明说「Bash prelude 不再通过
  `__internal-search` 启动 Node 转发层」（`embedded-search-native-build.md:224`）。
  以 `docs/runtime-tools/ripgrep-runtime.md` 与 `embedded-search-native-build.md` 为准。
- 上游简报里的 "ugrep 7.5.0 multicall" 不成立于 HEAD：7.5.0 是显式被替换的早期基线，
  当前 pin 7.8.4-1；且三个工具是独立二进制（native-binaries），multicall/argv0-dispatch
  仍只是合同里的保留形态，无默认构造点。
- 各文档间一致的部分：默认参数列表、bypass 列表、rg 缺失补齐策略、Windows 平台面，
  trajectory 文档与 prelude 代码逐项吻合（`:14-17` vs `embedded-search-prelude.ts:16-32`）。

## 5. 未能验证 / 边界

- 未实际构建或运行 ZCode 的 native search E2E（`pnpm test:native-search:e2e` 需要完整
  toolchain 与内网依赖源）；ugrep/bfs/rg 的行为结论来自源码参数合同与 spec 中的
  E2E 契约清单（`embedded-search-native-build.md:282-306`），非本机实测。
- `argv0-dispatch` multicall binary 的实现在本仓库中未找到（无构建/打包入口），
  只有 contract 与 prelude 的双侧支持；不能确认其是否存在于未开源的内部构建链。
- `--ignore-files` 具体读取哪些 ignore 文件（.gitignore/.ignore/.rgignore 等）是 ugrep
  上游语义，本仓库只固定了开关与 E2E 断言「ignore 文件被排除」，未逐文件类型验证。
- direct `Grep` 的 `GrepErrorCode` 常量表（`contracts/src/tools/grep.ts:173-180`）与
  handler 实际抛出的 `CoreErrorType.ToolCancelled`（`grep.ts:92-104`）之间的
  错误码上墙映射在 provider-facing 序列化层，本次未追到最终 wire 形态。

## 6. 追问（2026-10-16 当轮）：「这样真的能增强吗？有真实的报告吗」——证据强度评估

「增强」要拆成三层，三层的证据强度完全不同：

### 6.1 仓库内部：没有任何性能数字 / 对照实验

本次在 HEAD 快照上检索确认：`09-grep.md`、`11-ripgrep-wasm-packaging.md`、
`docs/runtime-tools/ripgrep-runtime.md`、`2026-06-26-bundled-bfs-ugrep-runtime.md`
四份一手文档中**零基准表、零耗时数字、零 agent 成功率对照**。增强论证全部是
定性一句话，最强的一句是 11 号文对旧实现的评价：「能满足基础契约，但在大型
仓库中性能、glob/type 语义和 multiline/context 行为都容易偏离成熟的
ripgrep」——这是工程判断，不是测量结论。仓库 `apps/` 下也无 eval/benchmark
包（关键词命中均为无关项：Playwright `evaluate()`、workflow eval snippet）。

### 6.2 组件层面（二进制速度）：有独立硬核基准，可 30 秒自测复现

捆绑的三个二进制相对 GNU grep 的速度优势是**公开、独立、可复现**的：

- ripgrep 官方 README 基准（[docs.rs 镜像, ripgrep 15.2.0](https://docs.rs/crate/ripgrep/latest)）：
  13GB 单文件 Unicode 词边界搜索，rg 1.042s vs GNU grep 6.577s（**6.31x**）；
  Linux 内核树 literal 搜索，rg 0.106s vs grep 1.246s（约 **11.7x**）。
  原始数据与复现命令都在 BurntSushi/ripgrep README。
- **注意 ugrep 的位置**：ZCode 的 `grep` 劫持用的是 ugrep 而非 rg，而独立基准中
  ugrep 多数 workload 慢于 rg、仍快于 grep（[Genivia/ugrep#517](https://github.com/Genivia/ugrep/issues/517)：
  literal 0.194s vs rg 0.106s vs grep 1.246s）。即速度排序 rg > ugrep > grep。
  ugrep 被选中的理由从 bypass 列表反推是 **GNU grep 兼容性**（透明替换
  `grep "$@"`，不支持的 flag 才绕回系统 grep），不是峰值速度。
- 自测（本机即仓库，凡 `rg` 已装）：`time grep -rn PATTERN . >/dev/null` 对
  `time rg -n PATTERN . >/dev/null`，在含 node_modules 的大仓库上差距最直观
  （rg/ugrep 默认遵守 ignore 文件，还会改变「搜不搜 node_modules」这一语义维度）。

### 6.3 agent 效果层面（任务成功率）：无公开对照报告

「模型用 ugrep/rg 探索是否比用 TS Grep 工具或直接系统 grep 完成更多任务」——
**没有任何公开受控实验**，ZCode 仓库内没有，外部也没有针对这一机制的。能给的
只有旁证：各 agent CLI（Claude Code 的 Grep 底层即 rg、Cursor、Aider 等）趋同
采用 rg 系搜索，属「行业收敛设计」证据，不等于测量报告。ZCode/GLM 官方发布
材料宣称的是模型与整体验证指标提升，从未把收益归因到搜索机制这一层。

### 6.4 诚实的反方向风险（同样无报告）

bypass 列表的存在本身说明 ugrep 与 GNU grep 并非输出级全兼容；模型对
`grep` 输出格式的心智模型偶发失配（color/编码/`-r` 排序差异）是 plausible
failure mode，但也无公开事故报告。两侧都没有数据，只能视为开放问题。
