# 搜索能力活在子代理里，由子代理的模型直接调用

status: accepted (2026-10-20). Ticket #227 (map #226) 的形状部分。配套记录：[ADR-0048](./0048-deepseek-search-gate.md)（门禁契约）。取代并同日撤销：[ADR-0047](./0047-deepseek-search-is-program-internal.md)（两个面 / 程序内可达）。

> **修订：[ADR-0051](./0051-the-surface-names-the-orchestrator.md)（2026-10-21）：两个表面值改名——`full` → `full_ptc`、`subagents` → `codemode_ptc`——且「表面」现在指**哪个编排器对模型负责**。本记录的决定不变；读到它的 `full` / `subagents` 时，读作那两个新名字。**

> **Amended by [ADR-0052](./0052-the-two-doors-share-one-prefix.md) (2026-10-21): the two task doors are renamed — `pi.dispatch` → `pi_task_ptc` (the PTC door, a binding inside a program) and `ptc_subagent` → `pi_task_codemode` (the codemode door, reachable from a `codemode` script) — with no alias and no compatibility shim. This record's decisions stand unchanged; read its `pi.dispatch` / `ptc_subagent` as those names.**
> **Amended by [ADR-0061](./0061-the-route-index-and-its-detail-files.md) (2026-10-21): the route to the web is now a row in the route table, and the resident index states it per surface. The shared web sentence is carried by the two PTC tool descriptions and the mode briefing; the reach note that used to ride in the `ptc_run_code` description retired, because the door is a codemode-reachable tool now. This record's decision stands unchanged: the parent has no web tool of its own, and the route to the web is a child.**
> **Amended by [ADR-0059](./0059-route-registry.md) (2026-10-21): the web sentence's one home is now the route registry (`src/routes/registry.ts`), not the search module — the search module re-exports it. The decision is unchanged: one sentence, carried by every surface that names the route to the web, with a test asserting each one contains that constant.**

## Context

ADR-0047 把搜索定成「程序内可达的能力，默认不面向模型」，具体形状是**一份实现、两个面**：pi 工具 `web_ds_search`（`exposure: "codemode"`）+ PTC binding `web.ds.search`。那条记录在同一天被实测修订过一次（见其 §修订），而**三件事把旧形状顶到了墙角**。

**一、「模型看不见」从来不是硬保证。** ADR-0047 的修订记下了真机观测：会话里若有 `tool_search`，模型可以主动搜到 `codemode` 档的工具**并把它激活进模型声明**（模型请求 1/2/3 的工具列表里没有它；第 3 次请求发出 `tool_search({ query: … })` 之后，第 4 次请求里多出了它）。pi 没有「可被 codemode 调、但不被 `tool_search` 搜到」这一档 exposure（`dist/extensions/tool-search/tool.js:136-138`）⇒ 旧形状承诺的那条窄面，**是被 pi 自己的机制漏掉的**，不是实现没做对。

**二、0.86.x 上只有 binding 那条路是安全的，而那条路把能力从 `subagents` surface 上拿走了。** `exposure` 字段在 0.99.0 才出现（`docs/agents/pi-compat-matrix.md:63`）；在那之前 `agent-session.js` 的 `_refreshToolRegistry` 会把新注册的扩展工具推进 active 集合（0.86.0 的 `agent-session.js:2262-2283`）⇒ 注册即面向模型。旧形状因此把「codemode 面」判为不可用，只留 PTC binding——**代价是 `subagents` surface 的模型要绕两跳**（codemode → `ptc_run_code` → binding），而那正是旧形状自称「两个 surface 都不缺能力」的地方。

**三、最要命的一条：搜索要用判断力，而判断力在做事的那一侧。** 「这条来源靠不靠谱」「这条是不是够新」「这条与问题相关吗」——这三件事在**干活的子代理**那里，不在拆任务的父会话那里。旧形状把搜索放在程序面（codemode 脚本 / PTC 程序）里，于是**每一次检索都要先写一段程序**：模型的判断被挪到了离动作两跳的地方。

**四、运营方拍板的方向。** 「能力给到子代理，让子代理拥有联网查询的能力/工具，这样能减少不确定性，并且耦合性也不会放大」——能力属于干活的子代理；父会话保持干净的上下文，**也不因为这个工具的形状而多出一份依赖**（它依赖的仍然是它本来就有的 dispatch-and-report 契约）。

## Decision

**搜索只存在于被派出去的子代理里；在子代理里，它就是模型自己的工具。**

具体形状是**一份实现、一个面**：

1. **只在子代理里注册。** 判据是 `ptcDepth > 0`——`dispatch()` 给子进程打的 `PI_PTC_DEPTH`（`src/runtime/dispatch.ts`），与 `ptc_child_report` 用的是同一个机制。**父会话里这个工具不存在**：不是「注册了但隐藏」，是**不在注册表里**。父会话**连凭据都不解析**（`registerSearchModule` 在深度判据之前就返回），所以父进程里不持有一把能开网络出口的 key。
2. **在子代理里它是 model-facing 顶门。** `exposure: "direct"` ⇒ **子代理自己的模型一步就能调它**，一次工具调用，没有程序、没有 binding 表。
3. **门禁不变**（[ADR-0048](./0048-deepseek-search-gate.md)）：开关关 ⇒ 任何地方都不注册；开关开但缺 key ⇒ **仍然注册**、描述里标注不可用、启动告警一次、调用返回面向模型的可读错误。
4. **一份实现、一个面。** 旧形状的三样东西随之消失：binding 表注入、binding contract 里搜索那条 note、拼进 `ptc_run_code` / `ptc_workflow` 描述的调用约定段。**调用约定由工具自己的描述给出**——这正是 pi 对工具参数的原生分工（描述给调用约定，契约给结果形状）。
5. **命名不变**：`web_ds_search`（pi 工具）/ `webDsSearch`（配置键），名字里带 `ds` 的三条理由见 ADR-0047 §命名，它们**全部继续成立**（只走 DeepSeek、provider 是契约的一部分、避开 DSH 自带 `web_search` 的同名覆盖）。
6. **配额是 per child process。** 一个子代理是一个完整的 pi 进程 ⇒ 它有一份额度。这是**诚实的代价**，见 §Consequences。

### 三条硬约束

1. **父会话不得注册这个工具，也不得解析 DeepSeek 凭据。** 门禁是「开关 + 是子代理」两条**同时**成立，顺序是先判深度。
2. **工具必须声明 `outputSchema`。** 结果形状（`operation` / `results` / `page`）因此可机检、可被 pi 原生携带，而不是一坨文本。
3. **错误文案是一份共享常量**（one-home rule，先例 `BINDING_CONTRACT`）。工具描述里的「不可用」那句与调用失败时抛出的那句**是同一份常量**。

### 一条被明确记录的行为：agent 声明的 `tools:` 说了算

pi 把 `--tools` 当**白名单**读（`sdk.js` → `allowedToolNames`）。一个 agent 定义声明了 `tools:`，它派出去的子代理就只拿到那些工具——**搜索工具会被一起过滤掉**。

这是**有意为之**：agent 的 `tools:` 声明是作者对「这个 child 能用什么」的明确收窄，而本决策要的是「能力给到子代理」，不是「无视作者的收窄」。需要某个 child 能搜，就在它的定义里把 `web_ds_search` 写进 `tools:`。

（对比：`ptc_child_report` 是**被合并进**白名单的，因为它是 dispatch 契约的一部分——没有它，父会话收不到报告，契约就断了。搜索不是契约。）

## Consequences

- **父会话不能搜索。** 它到网的唯一路径是派一个能搜的子代理。一个小问题因此变成一次 dispatch 往返——这是代价，也是要点。
- **子代理一步搜到。** 一次工具调用，模型的判断与动作在同一层。
- **父会话的总花费随子代理数线性增长，但那个上界离真实暴露差一个数量级。** 配额是 per child process ⇒ 父会话派出 N 个子代理，最坏情况是 N × `maxCallsPerSession` 次成功请求。按官方价格（Search / Fetch 各 **5 元 / 千次成功请求** = **0.005 元/次**），默认 100 次 ⇒ **≤ 0.5 元/子代理**，N 个 ⇒ **≤ 0.5N 元**。
  **而这个上界够不着**：官方口径下一次搜索返回 10 条、每条 `summary` 600–800 字符 ⇒ 光是摘要就是 6,000–8,000 字符（`content` 更是整页）；一个 128k 上下文的子会话**装不下 100 次**这样的搜索 ⇒ **上下文先于配额用完**，实际落在 10–30 次量级（0.05–0.15 元/子代理）。
  ⇒ **不引入父侧下发额度**：它要兜住的上界（0.5N 元）离真实暴露差一个数量级，而机制代价是跨进程状态（父侧记额度、传递额度、并发派发时「额度分给谁」没有干净答案）。**本记录如实写下这个乘数关系**，让开关与配额旋钮都可见——不假装它是个常数。
  **顺带一条更准的账**：本地配额比计费口径**更严**——本地把「HTTP 200 但结果为空」也算一次成功并扣配额，而官方只对「200 且产生结果」计费 ⇒ **配额用满时实际花费 ≤ 0.5 元**，不是恰好 0.5 元。
- **0.86.0 上那个风险消失了。** 旧形状最大的隐患是「在不支持 `exposure` 的 pi 上，一个联网计费工具会落到模型的直接面里」——现在父会话根本不注册它，而子代理里它**本来就应该**面向模型。⇒ `exposure` 字段被忽略也好、被读到也好，结果一致。
- **binding contract 回到四个 note**（`bash` / `write` / `edit` / `pi.dispatch`），搜索不再是 binding，契约不用改。
- **父会话真的会为「要联网」去派子代理——但前提是它知道孩子能搜。** 真机 e2e（`scripts/verify-parent-dispatch-e2e.ts`）量到了三件事：
  1. **它会派。** 父会话（只拿到 PTC 面、没有 bash 的那个面）面对「查一下某页的原文」时，**主动写了 `tools["pi.dispatch"]` 的程序**——而且是先试 `tools.bash` 发现没有、再转去派子代理。改完描述后整条链跑通：父 → 子 → 子调 `web_ds_search` → 逐字原文回到父。VERDICT: DISPATCHED。
  2. **但第一次被拒了。** 父会话**自己编了一个 agent 名**（`"general"`）⇒「没有定义的 agent 名一律拒绝」⇒ dispatch 拒绝 ⇒ 父会话拿不到页面。**根因是 PTC 工具描述里的那行示例** `await tools["pi.dispatch"]({ agent: "reviewer", task: "..." })` —— 模型照抄了这个形状。⇒ 示例改成不写名字，并写明「名字可选，不写就是 generalist；写了而没有定义会被拒」。
  3. **孩子会不会用搜索模块，取决于父会话怎么写任务。** 父会话知道「孩子能搜」之后，任务写的是「用 `web_ds_search` 搜」⇒ 孩子用了搜索模块；不知道的时候，它写的是「用 curl/bash」⇒ 孩子就 curl 了。⇒ **工具描述里必须有那句话**（`PTC_CHILD_SEARCH_NOTE`，按会话条件化：开关关着时不说）。
- **一条实测缺口已闭合**：真实 pi 上「**child → 搜到东西 → 报告回父**」的端到端，2026-10-20 跑通了（隔离 agent dir ＋ PATH 上的 pi 包装器 ＋ 真的 `dispatch()` ＋ 真的模型 ＋ 真的 Search API）。复现命令：`pnpm run build && node scripts/verify-search-e2e.ts`。
  **它抓出了一个真缺陷**：工具给模型的文本当时只有一行索引（数据在 `details` / `structuredContent` 里，而 **pi 只把 `content` 交给模型**）⇒ 子代理明说「正文没有出现在我的上下文里」「未能从官方原文核实」。改成**文本带实质**（搜索给 title / url / authority / rerank_score / date / summary，抓取给正文）之后，同一条链路的子代理**直接引了官方页面的原文**。
  ⇒ 本决策的第二条（**在子代理里它是 model-facing 顶门**）不只是「模型能调它」，而是「**模型拿得到它调出来的东西**」——这一条只有真机跑过才知道。
- **`subagents` 面（pi 自带的 codemode 在场）上的实测，以及一个被它抓出来的真缺陷。**
  2026-10-20 用 `PTC_E2E_SURFACE=subagents node scripts/verify-parent-dispatch-e2e.ts` 量了同一个问题在**不是我们造的 PTC 模式**（pi 自己的 codemode 激活 ⇒ 本包降为 `codemode` reach，模型直接看到的是 pi 的 `codemode` ＋ 我们的 `ptc_subagent`）下的行为。量到的三件事：
  1. **pi 自带的 codemode 确实被主动调用了，而且被调用了三次。** 父会话的第一反应就是写一段 codemode 脚本去派子代理——不是我们的 `ptc_run_code`，是 pi 自己的 `codemode`。
  2. **但那三次全部失败**，失败文本是 `TypeError: tools.pi.dispatch does not exist`（脚本自己的工具表里没有 `pi.dispatch`）。父会话随后**改用 `ptc_subagent` 派单，成功了**。
  3. **真正的缺陷在这里，而且比「绕过」更硬：孩子根本没有搜索工具。** 父会话派单时自己加了 `readOnly: "strict"`，而 strict 名单是 `read,grep,find,ls,ptc_child_report` ⇒ pi 把孩子的 `--tools` 当**白名单**读 ⇒ `web_ds_search` 被**整个滤掉**（子进程的 `toolsAdded` 里只有那 5 个）。孩子自报「this session has no web search, web fetch, or bash tool」并放弃，父会话如实回报「我没拿到那页内容」。
     ⇒ **所以「孩子在 `subagents` 面上绕过搜索模块去 curl」这个说法是错的**：孩子既没有 curl 也没有搜索工具——它**没有工具**。能力不是被绕过的，是**不存在**的，而且是不存在得**静悄悄**的。修法见 [ADR-0041](./0041-read-only-is-a-call-site-tier.md) §"The strict set is derived, not a constant" 的修订：strict 档在搜索模块开着时**保留** `web_ds_search`（它只读网页，不写，符合 strict 的承诺）。
  4. **reach note 在上下文里也没能阻止那个 TypeError。** 它一直挂在 `ptc_run_code` 的描述里（pi 的 codemode 描述会把脚本可调的工具连同描述一起列出，所以父会话**读到了**它），父会话仍然把 `await tools["pi.dispatch"]({ task })` 抄进了脚本。原因不是它没读，而是**它上面那个例子没有作用域标记**：例子写着「always available … e.g. `await tools["pi.dispatch"]({ task: "..." })`」，抄例子的模型不会去读例子下面那段话。⇒ 两处改动：**例子标明「inside the program」**；**reach note 先说一跳的路**（`ptc_subagent`），并让读者**看自己的工具表**而不是去推断一条路。
  5. **修完之后，同一条链路在 strict 形状下量到了「能力在」**：父会话派单带 `readOnly: "strict"` ⇒ 孩子的工具表是 `read, grep, find, ls, ptc_child_report, web_ds_search`——**搜索工具在、`bash` 不在**（strict 的承诺没破）⇒ 孩子调了 **17 次** `web_ds_search` 并自己找到那页 ⇒ VERDICT: DISPATCHED。复现命令：`PTC_E2E_SURFACE=subagents PTC_E2E_TASK_VARIANT=readonly node scripts/verify-parent-dispatch-e2e.ts`（`readonly` 这个变体就是专门为了让 strict 路径被量到的——父会话的档位选择是模型自己的，不加这个变体就量不到）。

## Alternatives considered

| 方案                                                                             | 为什么没选                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两个面（codemode 工具 + PTC binding）——ADR-0047 的形状                           | 撤销。「模型看不见」被 `tool_search` 漏掉；0.86.x 上只剩 binding ⇒ `subagents` surface 绕两跳；且每次检索都要先写程序                                                                                                    |
| 顶层 model-facing 工具（业界默认：Claude Code / Codex / Zed / OpenCode / Cline） | 父会话会直接拿到联网能力，检索结果也会进父会话的上下文；与「能力给到子代理」相悖，也与 ADR-0010 的窄面主张相悖                                                                                                           |
| 只做 PTC binding，不做 codemode 面                                               | `subagents` surface 要绕两跳，且 `full` surface 的父会话里也有这个能力（耦合变大）                                                                                                                                       |
| 父侧在派发时把剩余额度下发（env），把父会话的总花费兜住                          | 机制上可行且与 `PI_PTC_DEPTH` 同构，但**额度怎么分给并发派发的子代理**没有干净的答案（按「派发即扣」会让第二个子代理拿到 0）；且**它要兜住的上界离真实暴露差一个数量级**（见 §Consequences）⇒ 不做，改为如实写明乘数关系 |
| 走 provider 端 server tool（DeepSeek Responses API 的 `web_ds_search`）          | 仅 `deepseek-v4-pro`；结果由服务端自动进上下文，**拿不到 `results` 原始字段**、引用不可控、检索源不可换                                                                                                                  |
| 走 MCP 搜索服务器（Brave / Tavily / Exa）                                        | 不「内置」，要用户自己配 `mcp.json`                                                                                                                                                                                      |
| 只做 fetch 不做 search                                                           | 搜不到就无从抓；Fetch 单独存在只解决「已知 URL」                                                                                                                                                                         |

## See also

- ADR-0010 —— PTC 默认模式：收窄 loadout，snapshot bindings
- ADR-0048 —— 搜索的门禁：开关与凭据判定（本记录不动它）
- [ADR-0047](./0047-deepseek-search-is-program-internal.md) —— 被本记录撤销的形状（两个面 / 程序内可达）
- `docs/specs/0044-deepseek-search-module.md` —— 本决策的规格
- `docs/research/pi-codemode-bridge-live-probe-20261020.md` —— 真机实测（`tool_search` 那条路径）
