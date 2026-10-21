# Glossary — pi-ptc-subagents

Terms captured during wayfinder chart session on 2026-09-21. This is glossary
only — no implementation lives here. Source of truth for decision-records is
the wayfinder map issue (`wayfinder:map` label).

## Project terms

**pi-ptc-subagents** — this npm package. Hosts a pi extension that implements
DSH PTC mode. The repo name carries `-subagents` for historical reasons (a
previous `pi-subagents` peer existed); **subagents are explicitly not in scope
for the current PTC-mode effort** (see wayfinder map, 2026-09-21 grill round 3).
A separate effort (ADR-0016, 2026-09-23) added **pi.dispatch** — a binding that
lets a PTC program explicitly fan out to per-call pi sessions. The word
_subagent_ is not used for that mechanism (see _parallel binding_ below); use
precise terms.

**PTC mode** = **P**rogrammable **T**ool **C**alling, also known as
DSH "Code Mode" before the August-2026 rename. The model submits a program
(JS / TS) that composes multiple tools in one shot, and only the program's
return value plus collected logs flow back into the model's context.
This names the **technology**. The session-level switch that puts it to use —
the one that hides the built-ins — is the _narrowing mode_
(`GLOSSARY.md` §Narrowing mode); the two are separate and both exist, so
"PTC mode" never names the switch.

**dsh** = DeepSeek Harness, `deepseek-ai/deepseek-harness` on GitHub. Source
of truth for what PTC mode "means" behaviour-wise; pi-ptc must be re-aligned
to dsh's current behaviour (not the old pi-ptc SPEC's frozen decisions — see
map decisions).

**default-on / 默认开启** — for this package, "default-enabled" means: a user
who runs `pi install npm:pi-ptc-subagents` immediately gets the PTC tools
(`ptc_run_code`, `ptc_workflow`) on next pi startup, with **no** extra setup.
Mechanism: pi reads the npm package's `package.json` `pi.extensions` field
and registers the extension in `~/.pi/agent/settings.json` automatically.
**Not** a postinstall hook. **Not** a manual `pi-ptc install` CLI command.
This is the package's **activation**; what the model may CALL inside a
session is a separate question, answered by the _narrowing mode_
(`GLOSSARY.md` §Narrowing mode), and what the session may START is a third,
answered by the _dispatch switch_ (§Background dispatch and task lifecycle).
The three are independent: the tools are
available whether or not the mode is on.

## pi-side terms

### "Output" — the four senses, and the terms built on them

The word "output" is ambiguous in this project; use these instead (grill
round 2026-09-22, when "PTC 输出没可读性" turned out to mean the third one).
Four terms below are senses of "output" proper; the rest of the section
carries the terms defined against them.

#### The four senses

**completion value** — the value the program `return`s. Carried structurally
as `details.result` and textually as the last block of the tool-result text.
_Avoid_: output, result (when you mean the return value).

**captured output** — the `console.log` lines plus workflow narration
(`log()`): the `logs` / `narrations` arrays. _Avoid_: output.

**tool-result text** — the single text block handed to the model
(`content[0].text`), assembled by `renderToolResult()`. This is what the model
reads; it is not what the human sees. _Avoid_: output, "the result".

**PTC row** — the TUI rendering a human reads, produced by a tool's `renderCall` /
`renderResult` hooks rather than by the _tool-result text_. A tool may register both halves —
the program pair and the three `ptc_task_*` panels do — or only the call half, as the
_subagent surface_ does, leaving its result to pi's own text rendering. _Avoid_: output.

#### Terms defined against a sense

**value tree** — the shape a **PTC row** gives a container **completion value**: one row per
property (or array index), nested containers behind `├─` / `└─` / `│` connectors, bounded by
depth / children / line-width caps whose withheld amount is stated in-band. A scalar completion
value is a one-line hint instead. _Avoid_: value block (removed by ADR-0013 §5), JSON dump, payload.

**hoisted image** — an image block that a _successful_ binding call handed to a PTC
program and that the host then lifted out of the program onto the PTC tool result, so
the model sees the picture without it crossing the program's JSON return value.
Mechanism and the deviations from DSH: ADR-0014 (DSH parity: `dsh-tools`'s
`exec.deferContext`). Nothing is capped or deduped. _Avoid_: attachment, "the program returns the image", base64
result.

#### The binding family

**binding** — a function callable from within a PTC program as
`tools["<name>"](args)`. Every binding lives in the one `tools` table —
there is no `pi` global in the worker — so the parallel binding named
`pi.dispatch` is reached as `tools["pi.dispatch"](args)` and takes a single
object (`{ task, agent?, cwd?, agentScope?, model?, thinkingLevel?, background?, label?,
readOnly? }`),
not a positional argument list. Two
kinds:

- _builtin binding_ — a pi built-in tool whose `execute()` is invoked
  directly from the PTC worker (no `pi.on("tool_call")` route; see
  ADR-0005 §2). Currently: `read`, `bash`, `edit`, `write`, `grep`, `find`,
  `ls` — all seven in `BUILTIN_BINDING_NAMES`, which is the set of names that
  _can_ be bound, not what any one session binds. The default table exposes all
  but the _opt-in binding_ `bash` (ADR-0040); an install grants it with
  `optInBindings` in `~/.pi/agent/ptc.json` (a GRANT — it adds to the default
  set), a caller may instead pass an explicit `optIns` list, and a caller that
  curates the whole surface passes an explicit `names` list instead (the
  _R3 read-only PTC surface_, which REPLACES the default set). Those are three
  different shapes and the glossary names all three; they are not the same
  thing.
- _parallel binding_ — a non-builtin binding whose semantics are independent
  of pi's parallel-tool execution and which is explicitly designed for
  fan-out. Currently: `pi.dispatch(...)` (see ADR-0016). It spawns a
  fresh `pi` subprocess per call, so the PTC program gets session-level
  isolation without inventing a new task state machine.

**opt-in binding** — a binding that is known but NOT exposed unless the install
asks for it. Currently exactly one: `bash`. It stays in `BUILTIN_BINDING_NAMES`
because DSH's PTC preset still mounts `tool-bash` / `tool-pwsh`, so a program
written against DSH may run shell commands; leaving it on by default would hand
every session a shell, and deleting it would break those programs. An install
grants it by naming it in `optInBindings` in `~/.pi/agent/ptc.json`; a caller
may instead pass an `optIns` list to one call. The gate exists in TWO places on
purpose — `resolveBindingNames()` (which decides the names) and
`createBuiltinBindings()` (which builds the table) — because a table that
dropped `bash` while the model-facing list still advertised `tools.bash` would
hand the model a tool it cannot call and hide the reason. ADR-0040.
**Fails CLOSED**: an absent file, a file with no `optInBindings` key, an
unparseable file, and a key that is present but wrong all grant NOTHING, and
the last one is reported at `session_start`. That is the opposite direction from
_whyEnabled_, which fails OPEN — see that entry. An opt-in binding **ADDS** to
the default surface; it does not replace it. _Avoid_: "opt-in tool" (it is a
binding, and the opt-in is on the binding table), "default binding" (the
default set is `DEFAULT_BINDING_NAMES`).

**R3 read-only PTC surface** — a caller-curated binding surface: an explicit
`names` list passed to `createBuiltinBindings()`, which is honoured **VERBATIM**
— it REPLACES the default set rather than adding to it, the opt-in gate does
not apply to it (an opt-in name inside it is taken at face value), and
`includeDispatch` defaults to "did the caller curate the surface", so
`pi.dispatch` stays out unless the caller asks for it explicitly. The name
comes from the R3 research branch (`research/R3-isolation-tradeoff`): ADR-0016
§3 and `tests/bindings.test.ts` both name this pattern, and it is what the
"explicit subset" in the _binding_ entry means. It is the **binding-table**
axis, and it is a DIFFERENT axis from the _read-only tier_, which narrows a
dispatched **child's** tool list at the call site. The two meet at one point: a
strict tier at the call site decides the child's tool list outright. _Avoid_:
"read-only mode" (that is the read-only tier, and it has a tier name), "R3"
unqualified (that is a research branch, not this surface), and — importantly —
"the `optInBindings` subset", which is the _opt-in binding_ axis and does the
opposite thing.

_Avoid_: "subagent" (overloaded; GLOSSARY.md §Out-of-glossary), "BINDING_NAMES
whitelist" (the binding config is a _policy_, not a _filter_; Q1 grill round,
2026-09-23).

**binding result** — what a _builtin binding_ call resolves to: the tool's
model-facing payload, `{ content, details }`, and nothing else. `content` is an
**array of content blocks**, so the text of a text-file result is
`result.content[0].text` and never the result itself; `details` is the tool's
own detail object or `null`, never `undefined`. There is no `files` /
`output` / `matches` field on any binding result -- `bash`, `grep`, `find`
and `ls` hand back one text block of newline-separated rows that the program
splits itself. A call that fails (a `bash` non-zero exit, a missing path, a name
not bound this run) rejects with `ToolCallError`; a _parallel binding_ is the
exception, resolving to a `DispatchResult` that carries `text` and `status`
and has no `content` at all. The `{ content, details }` re-wrap is the only
transformation between a pi tool's own result and the binding result.
ADR-0024. _Avoid_: "binding return value" (a binding resolves to an object, not
a scalar), "tool result" (that is the pre-rewrap shape, which a program never
sees), "output" (the four senses of "output" are split above; this is none of
them).

**binding contract** — the model-facing block inside the `ptc_run_code` and
`ptc_workflow` tool descriptions that states the _binding result_ shape, so the
model never has to guess it. One module owns the text and renders it into both
descriptions, so the two surfaces cannot drift. The per-binding notes are typed
against the bound-name set, and coverage is checked in **both** directions: every
name the contract puts in backticks is either a bindable binding or listed
non-binding vocabulary, and every bound binding is either named or knowingly
covered by the shared shape (`read` is the one binding covered without being
named, and the test states that as a literal). A name written in bare prose is
outside what that first check sees. It declares
return types only -- pi already declares every tool's
arguments natively in the same request, so restating them is pure token cost.
ADR-0024. _Avoid_: "TypeScript SDK section" (DSH's name for its system-prompt
variant, which also ships a full argument map; ours is a description block
carrying return types only), "tool signature" (no per-binding signature is
emitted).

**binding note** — a per-binding clause of the _binding contract_ stating where
one binding departs from the shared _binding result_ shape: `bash` rejects on a
non-zero exit, `write` always reports `details: null`, `edit` always reports
a diff, `pi.dispatch` carries `text` instead of `content`. Written only where
behaviour genuinely differs, so the common case stays one sentence. ADR-0024.
_Avoid_: "per-binding documentation" (the contract is the block; a note is one
exception inside it).

### What this extension exposes

Pi 0.99.1 ships its own PTC, a built-in extension registering one tool,
`codemode`. The two mechanisms are **not** in a superset relation: pi's side
wins on sandbox isolation and on tool discovery, this package's side wins on
spawning a fresh pi process. Terms below name the split, so "turn PTC on"
never has to mean two different things in one sentence.

**pi codemode** — pi's built-in programmable tool calling, the single tool
`codemode`, evaluated in a fresh QuickJS sandbox with no Node, no file
system, no network and no timers. Orchestration, batching and output
filtering; `searchTools` / `describeTool` (BM25) reach nested tools, and
`store` / `load` persist across calls. It cannot spawn a process, which is
the whole reason _parallel binding_ is not replaceable by it. Its designed
centre of gravity is the MCP catalog: MCP tools default to `codemode`
exposure, so the extension activates this tool to make them reachable from
scripts (see _MCP auto-enable evidence_). ADR-0025, ADR-0033.
_Avoid_: "pi's PTC" (it is one implementation of PTC, and "PTC mode"
below already names ours), "code mode" (the pre-August-2026 DSH name).

**surface mode** — **which orchestrator is responsible to the model**: this
package's own PTC, or pi's `codemode`. (Earlier wording: "which model-facing
tools this package registers" — that named the _inventory_, not the question the
model faces, and the inventory is the same on both surfaces for the PTC pair.)
Independent of the _narrowing mode_ (which decides which of the registered tools are
_active_) and of the _dispatch switch_ (which withholds the _lifecycle face_ from
the model while nothing is running). **Detected, not configured**: there is no key for it, and the
former `surfaceMode` key in `ptc.json` was removed 2026-10-10 (ADR-0034).
Two values, named after the orchestrator they put in charge: `full_ptc`,
`codemode_ptc`.
(Renamed from `full` / `subagents` on 2026-10-21, grill round 1: the old pair
named _what was registered_, the new pair names _who orchestrates_; `full` also
read as "everything is available", which is false on that surface — there the PTC
pair is registered but not model-facing. The `_ptc` suffix says the same thing
about both: our PTC is in play either way, and the prefix says who is in charge
of it.) The detection asks three questions, not one. Does
this pi ship a `codemode` extension directory, will pi actually load it, and
will `codemode` be **active** for the model? The second one is not redundant:
since pi 0.99.0 a user can disable a built-in extension, so a pi can ship
`codemode` and be told not to run it. The third is not redundant either: pi
registers `codemode` inactive, and
since pi 1.0.0 the MCP extension may activate it at runtime (see
_MCP auto-enable evidence_). Shipped **and** loading **and** active
resolves to `subagents`; any other combination resolves to `full` -- and a
probe that cannot answer also resolves to `full` in the safe direction. The
session names that outcome at startup rather than defaulting in silence,
because a detection that cannot be seen is indistinguishable from a pi that
moved its `dist`. ADR-0025 (withdrawn by ADR-0034), ADR-0026, ADR-0027,
ADR-0029, ADR-0033, ADR-0034.
_Avoid_: "PTC mode" (that is the acronym, or the _narrowing mode_ if you mean
the toggle; the two are separate and both exist), "mode" unqualified (ambiguous in this
repository), "enable" (a surface mode leaves the package
installed and doing something, so "disabled" would be a different claim), "default"
(there is no constant default — the answer is a function of the pi, so call
it the detected surface), "setting" (there is no key; the surface is
detected).

**route registry** — 路由文案的**唯一出处**（2026-10-21 grill 决定；ADR-0059 / ADR-0061 落地）。

两个区：`ROUTES`（一行 = 一条「路」）与 `TOOLS`（一行 = 一个工具）。持有**全部** model-facing 散文——
选路（什么时候走哪条路）、事实（这个工具是什么、参数、返回）都在这里；**模型面前不出现 "dispatch" 这个词**
（那是任务侧内部实现）。

**输出两层**，照搬 `@tylerho/pi-memory` 的 `MEMORY.md` 形状：

- **常驻索引**（`<ptc>` section）：每条路**一行** hook + detail 指针。详情**永远不在索引里**。
  有 token 预算，超了要**明说**（`> WARNING:`），不静默截断。
- **详情文件**（随包 markdown，`docs/routes/<id>.md`）：模型用 pi 核心的 `read` 读。
  `docs/usage/` 也**随包发布**——否则 detail 指针在用户机器上是悬空的。

**索引每 turn 字节相同**：改了会废掉 prompt cache（pi-memory 原话：「changing the system prompt
mid-session invalidates the cached prefix」），所以索引只在 `session_start` / `session_compact` 刷新。

八条机械强制点（工具→行 · 行→工具 · route 集完整 · 索引 token 预算 · 每行事实段非空 ·
工具三块散文必须来自 registry · 索引一行一条且指针可解 · 索引每 turn 相同）

- 一条约定（参数 schema 的 description 跟 schema 留在一起）。

**留在外面**：参数 schema（含参数的 description）· 实现 · renderers · **动态**的绑定清单（会话内注入）·
binding contract（「调了得到什么形状」是另一个问题，它已有自己的 ADR 与预算）。

_Avoid_: "路由表"（它有两层：索引 + 详情文件），"prompt 模板"，
"往 AGENTS.md 里写路由"（AGENTS.md 是 per-project 的位置，我们的路由是 per-package 的；
`@tylerho/pi-memory` 明确**不碰** AGENTS.md，`ai-memory` 往里放的是 per-project 的知识，
而且是 server 返回内容、由 agent/CLI 写进文件）。

**admission queue** — 待准入队列：子代理派发在**并发槽满**时去的地方。

照 **libuv 的线程池**建模（2026-10-21 grill 决定）：固定数量的槽（默认 8，session 级，所有前端共用），
超出容量的请求**进队列等，不被拒绝**。队列是 **FIFO**、**无界**、**无超时**。

- **入队即建任务记录**（状态 `queued`）—— 队列 = registry 里 `queued` 的那些记录，**队列状态与任务状态是同一份数据**，
  所以队列天然可观测（`ptc_task_list` 看得见）也可取消。
- **取消只对排队中的生效**（libuv `uv_cancel`：仍在队列里则出队取消，返回 0；已经开始执行则 `UV_EBUSY`）——
  `ptc_task_stop` 能抽掉一个还在排队的任务，已起的不行。
- **后台派发立刻返回 handle，不等槽** —— libuv 每个 work item 的调用方都 await 它，我们是 fire-and-forget，
  让它阻塞在队列上就不 background 了。孩子等槽排到时才真的起；**槽只被「跑起来的孩子」占**。
- **前台程序 abort → 取消还在排队的请求** —— 也是前台队列的天然界（程序 2 分钟 `timeoutMs`）。
- `/ptc off` = 停收新的 + 抽掉排队中的 + 在跑的照常（与 ADR-0050「在跑的不受影响」吻合）。

**已知取舍**：队列无界。libuv 的前提是生产者天然有界（外部请求流），我们的后台生产者是一个能循环调用的程序——
今天 cap-8 白送了「最多 8 个后台孩子」这个界，改成无界队列后这个界就没了。

_Avoid_: "并发队列"（它排的是**待准入**的任务，不是运行中的孩子），"slot 队列"，
"派发队列"（容易和 registry 的事件队列混）。
(2026-10-21, grill round 4.)

**task** — **一次派发的记录**。不是「后台任务」：前台派发也建一条。

**门背后先建记录再起进程**——前台也一样建：一次派发就是一条任务记录，不分等不等。
等的那次等到终态、把结果返回；不等的那次立刻交出句柄，让泵去驱动终态。于是「派发」和「任务」是同一件事：

- registry 是派发的**唯一痕迹**；
- _lifecycle face_ 是它**唯一的模型面**——有任务记录就可见，没有就收走；
- 并发槽按 task id 记（前台不再匿名占槽，`createPtcSubagentTool` 那个写死的 `callId: 0`
  不再让两个并发调用共用一个 token）；
- 前台的产出也落盘（`<sessionDir>/tasks/<id>/output.log`），所以前台孩子的报告事后也读得到；
- 满了不拒绝——进 _admission queue_ 等（libuv 模型）；
- **「等不等」是入口的一个 `wait` 参数**（默认 `false` = 不等），不是两种派发模式。
  `wait: true` = 等这个任务完成，结果在返回值里（`DispatchResult`）；
  省略 = 不等，立刻返回 handle（`DispatchHandle`），完成时**通知回到父会话**。
  参数的语义取自 Kotlin 协程的判据：「**这个调用点需要结果吗**」。

**为什么 `wait` 只能是参数，不能是「调用方自己 await」**（2026-10-21）：tokio / Python 那一路
（一个句柄 + 调用方 `await` 它）在跨边界时做不出来——**结果是一次性穿过结构化边界的值**，
句柄里的 promise 带不回来（codemode 那侧更硬：pi 的文档写死了工具「resolve to a structured
value」，promise 根本传不回来）。剩下的只有「参数」和「两个入口」，而两个入口 = 2 门 × 2 等法
= 4 个名字，模型调用表翻倍。

**已知取舍**：默认不等 = libuv 回调式，代价是返回形状随参数变——模型可能以为要结果却拿到
handle。Kotlin 管这叫「await 遗忘综合征」（「结果永远丢失，且异常静默吞没」），靠静态检查插件

- CI 规则（detekt 的 `UnusedDeferred`）兜；我们靠描述文案、handle 里的明写、以及
  `ptc_task_output` 这个兜底通道。

_Avoid_: "后台派发" / "前台派发"（模型面上是「等 / 不等」，不是两种派发），
"dispatch 模式"（没有模式，只有一个参数），"后台任务"（旧的 `background` 语义已退役）。
(2026-10-21, grill round 4-5.)

_Avoid_: "后台任务"（那是旧语义，现在前台也进 registry），"派发链" vs "任务链"（现在是同一条链），
"前台是内存的"（那是旧事实）。
(2026-10-21, grill round 2.)

**subagent door** — one of the two model-reachable entries into the **one**
shared subagent implementation, named after the orchestrator that uses it. There
is **one** implementation — the machinery that spawns a child pi process — and
**two** doors, one per surface, because each surface's orchestrator reaches a
child in its own language:

- the **PTC door** — `tools.pi_task_ptc({ task })` **inside** a PTC program.
  The program is the orchestrator; it fans out with its own `Promise.allSettled`.
- the **codemode door** — `tools.pi_task_codemode({ task })` called **from** a
  codemode script. The script is the orchestrator; it fans out with its own
  `Promise.allSettled` over the script's tool table.

**Both doors are "start a task", not "dispatch".** The model-facing word is
**task**; _dispatch_ is what the task side does internally, and the word does
not appear in the model-facing vocabulary at all. The two names share the
`pi_task_` prefix on purpose: the suffix is the ONLY thing that differs
between the surfaces, and both are valid JavaScript identifiers — so
`tools.pi_task_…` is dot access in BOTH planes. The old names could not be
that: a name carrying a dot forces bracket indexing, and pi's codemode maps
tool names to JS identifiers (`pi.dispatch` → `tools.pi_dispatch`), so one and
the same call had to be spelled two different ways. That is the shape error
measured on 2026-10-20 (`TypeError: tools.pi.dispatch does not exist`).

Because it is one implementation behind two doors, changing surface is a change
of door, not a change of capability. On the `codemode` surface the model is
expected to take the **flat** door — codemode → `pi_task_codemode` → child —
and not the nested one (codemode → a PTC program → `pi_task_ptc` → child):
the nested path reaches the same implementation through the other orchestrator's
clothes, and it costs an extra worker plus an extra hop. (2026-10-21, grill round 1.)

**Either door can be withdrawn.** pi cannot unregister a tool, but it CAN
overwrite one: `pi.registerTool` is a `Map.set` on the tool name, so
re-registering the same name with `exposure: "hidden"` replaces the entry, and a
`hidden` tool is in neither the declared set (`agent-session.js:1163`) nor the
codemode callable set (`agent-session.js:1151` — that predicate admits `codemode`,
`deferred`, and active `direct`, and nothing else). pi's own MCP extension
withdraws tools exactly this way (`dist/extensions/mcp/index.js:344`). The PTC
door needs no such trick: it lives inside a PTC program, so withdrawing the PTC
pair withdraws the door with it. (2026-10-21, grill round 3.)
_Avoid_: "subagent tool" (the door is not the implementation), "dispatch" alone
for the model-facing entry (the model starts a TASK; dispatch is internal),
"the subagent API".

**codemode activation** — the third question surface-mode detection asks: will
`codemode` be **active**, i.e. callable by the model? It is distinct from the
_codemode switch_ (whether the extension loads) and from presence on disk, and
it has two evidence classes that answer independently, because pi activates
`codemode` by two mechanisms:

- **loadout mirror** — _retired 2026-10-10, ADR-0035._ It used to be the
  settings-side answer: the `--tools` allowlist, then the merged
  `defaultTools` (`<cwd>/.pi/settings.json` over `<agentDir>`), then pi's own
  default, replayed in pi's precedence. It is now a **live read**: pi's own
  active tool set, asked at `session_start` with `getActiveTools()`. The
  difference is not tidiness — a mirror could not know whether pi had been told
  to trust the project, so a project pi declined to read could still name
  `codemode` here and put the session on a surface whose orchestration tools
  nothing could reach (#131). Reading cannot have that disagreement, because it
  IS pi's answer. Do not reintroduce a mirror: a second implementation of a rule
  the host owns is a defect waiting for the host to change the rule.
- _MCP auto-enable evidence_ — the file-side answer: pi's MCP extension calls
  `pi.setActiveTools` to activate `codemode` whenever an enabled MCP server's
  tools are only reachable from scripts, which no settings file records. This
  one stays a file-side read, and it is not redundancy. pi performs that
  activation from inside **its own** `session_start` handler, and extension
  order is not ours to choose, so a live read from ours is too early to see it
  — measured, not assumed: a synchronous read, a read one microtask later, and
  one on a zero-delay timer all read it inactive, and it appeared ~250 ms later.

Either one being positive means the model can call it, so the probe
**unions** them; `"mcp"` names the case where the loadout said inactive and the
evidence said otherwise, and that case is now reachable in a way it was not
before — pi activates `codemode` from its own `session_start`, after ours has
read. Both classes resolve to `inactive` by default, deliberately: pi
registers `codemode` with `defaultActive: false`, so "nobody configured
anything" is a decision and lands on the safe surface (`full`). ADR-0029,
ADR-0033, ADR-0035. _Avoid_: "the activation probe" (the probe is the whole
question; this term is the question), "codemode enabled" (that is the switch, a
different question), "codemode loaded" (that is presence plus the switch), "the
loadout mirror" (retired — the loadout is read, not mirrored).

**MCP auto-enable evidence** — the file-side answer to _codemode activation_,
computed from `<agentDir>/mcp.json` and `<cwd>/.pi/mcp.json` in that order:
true when `autoEnableCodemode` is not `false` and some **enabled** server's
exposure set -- its own `exposure` (default `codemode`) union the per-tool
`toolExposure` values -- contains `codemode`. pi computes it _from the config,
before the servers connect_, so whether a server connects is not part of the
question and this evidence is a pure function of the two files. What it cannot
see: a server an extension registered through `pi.registerMcpServer()`, which
activates `codemode` with no `mcp.json` at all -- that case is caught by the
session's real tool loadout instead (the drift notice). ADR-0033.
_Avoid_: "the activation probe" (see _codemode activation_), "MCP settings"
(the same file also configures transports; only the auto-enable decision is
read).

**codemode switch** — whether the pi that loaded us will actually load its own
`codemode` extension, as distinct from the **codemode probe** (whether the
extension directory is on disk). Three states: `absent` (nothing configured it,
and pi loads built-ins by default), `enabled`, `disabled`. Read from the same
three places pi reads it and in the same order: the command line
(`-e builtin:codemode`, then `-ne` / `--no-extensions`), then
`<cwd>/.pi/settings.json`, then `<agentDir>/settings.json`. It exists because
pi 0.99.0 added `-builtin:<name>`, which made the two questions have different
answers; answering only the first one hands orchestration to a tool that is not
running. ADR-0027. _Avoid_: "codemode probe" (that is the filesystem
question), "is codemode enabled" (the tool is separately registered inactive via
`defaultActive: false`, which this switch does not read), "extension enabled"
(ambiguous between the extension loading and the tool being in the active set).

**`detectedSurfaceMode`** — the pure function behind _surface mode_: where
that term's answer is actually computed. Exported from the package root, so the
decision can be driven from a **built artifact** rather than only from the
source module. It reads exactly three arguments and nothing else — the three
probes, already resolved: `CodemodePresence`, `CodemodeSwitch`,
`CodemodeActivation`. It returns `"subagents"` only when all three hold (the
directory is on disk, the extension is not switched off, the tool is
**active**), and returns the named `FALLBACK_SURFACE_MODE` — `"full"` — in
every other case, a probe that could not answer included. The answer is a
`SurfaceMode`, one of `SURFACE_MODES`. `detectSurfaceMode` is the wrapper
around it: that one runs the probes and returns them alongside the result, which
is the `DetectedSurface` `session_start` reports on. ADR-0026, ADR-0027,
ADR-0029. _Avoid_: "surface decision" (ambiguous — it is both the question and
this function; say which), "detectSurfaceMode" (that one resolves the probes
first, so a caller already holding the three answers does not need it).

**structured result** — the `structuredContent` a model-facing tool returns
alongside its `content`, declared by an `outputSchema`, for **programmatic
callers only**: pi's `codemode` scripts receive it instead of the text, and it
is never sent to the model. It is a **projection**, not a mirror of `details` --
lean, stable, and shaped to match what the model was shown in the text block, so
a script and the transcript agree. `ptc_task_*` and `ptc_subagent` declare one;
`pi.dispatch` does not. ADR-0028. _Avoid_: "structured output" (pi's
`outputSchema` describes the result, it does not validate it — nothing checks
the two agree), "details" (that is the TUI's own richer channel, and the two are
allowed to drift), "the result" (ambiguous between `content`, `details` and this;
say which).

**orchestration surface** — the tool a model uses to compose many tool
calls into one program. Two exist: `ptc_run_code` / `ptc_workflow` (this
package, Node worker, real `tools.<name>(args)` bindings) or `codemode` (pi,
QuickJS). The _surface mode_ decides which one the **model** is offered, and
that is what this term means: having both live in a request is a measured
defect, not a feature — it is two programming models to choose between.

**Registration is not the same question as being offered.** On the `subagents`
line the PTC pair IS registered, at `codemode` reach, which makes it callable
from a pi `codemode` script without declaring it to the model. So the pairing
there is an orchestrator plus its execution layer, not two orchestrators, and
it is what makes `pi.dispatch` — which a QuickJS sandbox cannot reach at all —
available underneath `codemode`. `full` declares the pair instead. The surface
mode decides which; exposure is how. ADR-0025 §3 as amended 2026-10-09, which
survives ADR-0034. _Avoid_:
"the PTC tool" (there are two, and which one is a surface-mode decision),
"code
execution" (both are that; the word says nothing about the shape).

**subagent surface** — the top-level tool the model calls directly to
start a fresh pi subprocess, without writing a program. This is what the
detected `subagents` surface keeps, and it is the reason that line exists: the
_parallel binding_ `pi.dispatch` can only be reached from inside a program,
so a line that handed the program face to `codemode` needs a top-level entry
point or the subagent capability would be deleted rather than handed over.
It stays at `direct` reach on that line, and that asymmetry is deliberate —
the pair underneath is for scripts, this one is for the model itself. An
omitted `model` follows the _dispatch model inheritance_ rule (ADR-0044): the
surface requests nothing, so the child runs the caller's _session model_
unless the call site or the agent definition pins a _requested model_.
ADR-0025 §3 as amended 2026-10-09. _Avoid_: "dispatch tool" (that is the
_parallel binding_ inside
a program), "subagent" (see Out-of-glossary: DSH's subagent is a
different thing), "background task" (that is the `ptc_task_*` lifecycle
face, which can inspect and stop tasks but cannot start one).

**lifecycle face** — the `ptc_task_list` / `ptc_task_output` /
`ptc_task_stop` trio. Registered on **every** surface mode, `subagents` included,
and outside the _narrowing mode_ loadout on purpose:
turning the _narrowing mode_ off must never hide the lifecycle of a task that is
still in flight. Since ADR-0050 they are withheld from the MODEL exactly when
the _dispatch switch_ is off and no task is in flight — with nothing to manage
there is nothing for them to do — and they come back the moment a task is
running, so that task stays inspectable and stoppable. ADR-0022, ADR-0025
(withdrawn by ADR-0034, which removed the `off` value this entry used to
except), ADR-0050. _Avoid_: "task tools", "subagent
tools" (they manage tasks other things started).

**worker surface** — which of the two PTC program surfaces a worker was spawned
as: `PtcSurface` is `"run_code" | "workflow"`, and a worker is spawned with
exactly one of them and keeps it for life. The surface decides the program
surface's helper set (see _helper_) and is sent to the worker in the `init`
frame. It is NOT the same thing as the model-facing tool name — the two
coincide in spelling (`ptc_run_code` / `ptc_workflow` are the tools,
`run_code` / `workflow` are the surfaces) but they are different objects, and
the _orchestration surface_ is a third: the tool the model calls.
_Avoid_: "PTC surface" (there are three surfaces in this repo and the phrase
names none of them), "mode" (collides with _surface mode_ and the
_narrowing mode_).

**helper** — a global function injected into a worker's runtime. **Not all
DSH helpers appear in plain PTC mode** — per R1 (`research/dsh-ptc-behaviour-inventory.md`,
dsh-v0.1.6-alpha.2), `log / phase / parallel / pipeline / agent` are
workflow-engine globals in DSH's `@deepseek-ai/dsh-workflow-ptc`; they do
NOT appear in PTC `run_code`'s worker surface. Plain PTC `run_code`
exposes only `tools.<name>(args)` + standard Node API + `console.log`. The
pi-ptc worker split mirrors this:

- **`ptc_run_code` worker** — bindings + Node + `console.log`; the
  script's async return value goes back to the model as the result;
  there is no `result()` helper in plain PTC.
- **`ptc_workflow` worker** — bindings + Node + `console.log` PLUS
  workflow helpers `log / phase / parallel / pipeline` (real in this map).
  There is no `agent()` helper (G1 #13 decision B — the DSH helper is
  deferred to a future map). For fan-out to per-call pi sessions today,
  the program uses the `pi.dispatch(...)` _binding_ (see _binding_), not
  a helper. The `result(value)` form in `ptc_workflow` is the script's
  async return, materialized lossless-JSON.

**builtin binding** — a pi built-in tool whose `execute()` is invoked
directly from the PTC worker (no `pi.on("tool_call")` route; see ADR-0005 §2).
Its call is IN-PROCESS, which is the whole contrast with a _parallel binding_,
whose call spawns a per-call runtime unit. The seven names that CAN be bound
are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — all seven in
`BUILTIN_BINDING_NAMES`, which is the set of names that can be bound, not what
any one session binds. The default table exposes all but the _opt-in binding_
`bash` (ADR-0040). A builtin binding resolves to a _binding result_; a
_parallel binding_ does not — it resolves to a `DispatchResult` that carries
`text` and `status` and has no `content` at all. _Avoid_: "tool binding" (a
pi built-in tool and a binding are different objects, and the glossary uses
"tool" for the former), "internal binding" (the call is in-process, not
internal — it is the same tool a session would call directly).

**parallel binding** — a binding whose call spawns a per-call runtime
unit (a pi subprocess for `pi.dispatch`; potentially other backends in the
future). The term contrasts with _builtin binding_, whose call is
in-process. See ADR-0016. _Avoid_: "subagent" (DSH subagent is a different
thing; see Out-of-glossary).

**concurrent tool call** — a single tool call (whether builtin or parallel
binding) issued by the PTC program while another tool call is already in
flight. Pi native runs these concurrently (preflight sequentially, execute
concurrently); the PTC program composes with `Promise.all` /
`Promise.allSettled` and the binding return-value shape. See ADR-0016
§3.

**pi.dispatch** — the only _parallel binding_ shipped today. Spawns a
fresh `pi` subprocess (`--mode json -p` plus session-file flags from R1
when `{ background: true }` is set) and returns a structured result
(see _DispatchResult_ for foreground, _DispatchHandle_ for background).
Its child's model resolves as the _requested model_ (the dispatch's `model`
argument, else the agent definition's frontmatter `model:`), the caller's
_session model_, then the _configured default model_ — see _dispatch model
inheritance_ and ADR-0044 — and the result states the _observed model_, not
just the requested one.
Subject to a session-wide _dispatch concurrency_ cap (default 8, matches pi's
`subagent` extension `MAX_PARALLEL_TASKS`): one counter per pi session,
spent by programs, by the `ptc_subagent` front, and by background children.
The spawn surface is binding-only (the model cannot call `pi.dispatch`);
but the **lifecycle face** for background tasks is model-facing via
`ptc_task_*` tools and `<bg-task-notification>` events (see ADR-0022).
_Avoid_: `agent()` (DSH helper stub, deferred), `subagent` (DSH / pi
extension).

**agent definition** — the optional markdown file that NARROWS a dispatched child:
`~/.pi/agent/agents/<name>.md` (user scope) or `<cwd>/.pi/agents/<name>.md` (project scope), selected
by `agentScope`. Naming one is optional — ADR-0039 — because the child is a full pi either way: the
dispatch prompt is APPENDED to pi's own system prompt, and no `--tools` flag is passed unless the
definition declares `tools:`. A definition can therefore only take capability away; there is none it
can add. A dispatch that names none gets the _generalist child_. A definition is not the only narrowing
axis: _read-only tier_ is the other one, and where the two meet a strict tier at the call site
decides the tool list outright.

**Identity and precedence are both decided on the frontmatter, not the filesystem** (#205, #207).
A definition's name is its `name:` field and nothing else: naming the file after it is the
convention and nothing more, so `beta.md` carrying `name: gamma` is the agent `gamma` and is not
reachable as `beta`, while a `.md` with no `name:` is not an agent at all. When one name is
registered in BOTH scopes the **user** copy resolves — deliberately the opposite of pi's own
subagent example README, Claude Code, OpenHands, Roo Code and the Agent Skills client guide, all of
which say project wins. The reason is asymmetry of ownership: `~/.pi/agent/agents/` is a personal,
machine-wide choice, while `<cwd>/.pi/agents/` is checked into a repository and shared, so letting
the shared file silently override the personal one would make which definition runs depend on who
checked out. It only bites for `agentScope: "both"`, which is not the default. Two files in ONE
scope declaring one name is a mistake rather than a rule: entries are sorted by file name and the
first keeps it, and the shadowed file is reported.

_Avoid_: "required" (the name is the narrowing path, not the entry fee), "agent file"
(the name lives in the frontmatter; the file name is a convention and nothing more).

**generalist child** — the child a dispatch creates when the caller names no
`agent`: pi's own system prompt, pi's full toolset, and no _requested model_
pinned by a definition — so the _session model_ tier still applies (see _dispatch
model inheritance_). The result reports it as an EMPTY `agentName`, so a caller
can see that no definition was resolved rather than being told a plausible-sounding
one that does not exist. In code it is `GENERALIST_AGENT`, a frozen literal whose
every field is inert: `name: ""`, `systemPrompt: ""` (the child receives only what
the dispatch appends, on top of pi's own prompt — nothing is substituted), no `tools`
key (so no `--tools` flag reaches the child), and `source: "unknown"` (it came
from no directory). "Absent" and "present but unusable" are different: an absent
`agent` selects the generalist, while a malformed one — a non-string, or a string
that is empty after trimming — is REFUSED (issue #185), because collapsing them
would let a caller's typo silently dispatch something it did not ask for. A
generalist also has no _child report_ opt-out: with no definition there is no
`childReport: false` to set. ADR-0039.
_Avoid_: "preset agent" / "default agent" (nothing ships in the package, and the
generalist is the child pi already is, not a definition this project wrote and
installs), "narrowed child" (a definition is what narrows; the generalist is the
unnarrowed case), "subagent" (see Out-of-glossary: DSH's subagent is a different
thing).

**DispatchResult** — the structured return type of `pi.dispatch(...)`.
Fifteen fields. `text` (final assistant text), `status` (`fulfilled` /
`rejected`), `started` (whether the child process was actually brought up —
`status: "rejected"` covers two different things, the harness declining to start
and a child that ran and failed, and this is what tells them apart; the
_dispatch sub-row_ colours the first `rejected` and the second `error`),
`agentName` (EMPTY for a _generalist child_), `durationMs`, `exitCode`,
`usage?` (input/output/
cacheRead/cacheWrite/cost/turns; absent when the child reported no usage
block), `observedProvider?` / `observedModel?` (the _observed model_ pair — what the host read
off the child's assistant turns, last turn wins; absent means no observed
assistant turn NAMED the pair — no turn, a pi within the declared floor that
does not report it, or an old record — not "unknown"), `stderr?` (best-effort,
never promised), `errorMessage?` (the structured failure channel — the
_child-reported error_, verbatim, when there is one; otherwise the exit-code /
truncation diagnosis, or absent when there is none), `report?` (the _child
report_, when one arrived over either channel), `reportChannel` (TOTAL — always
present, including on every refusal, so a degradation the caller cannot see is
not a silent failure; the four values are `tool` / `prompt-json` / `none` /
`opted-out`), `readOnlyTier?` (the tier actually applied — present whenever a
tier was requested, absent when none was, so `undefined` is a claim rather than
a gap; it exists so a caller can see that a definition's declared `tools:` was
OVERRIDDEN, and it is stamped on refusals too, where it states the tier the
call resolved to), and `whySuppressed?` (`true` when the caller's _why_ was
dropped — the fact that a suppression happened is recorded, never the value).
Shape matches `Promise.allSettled`
settled records, so PTC programs compose without `try/catch`. See
ADR-0016, ADR-0032, ADR-0041, ADR-0043, ADR-0044.

Four model words are in play in dispatch, and they are different facts rather than synonyms: the _requested model_ (what the caller asked for), the _session model_ (what the caller's session is on), the _configured default model_ (pi's fallback), and the _observed model_ (what the host saw run). A result can name the first and the fourth, and have them differ — that difference is the point of ADR-0044.

**requested model** — the model a dispatch ASKS for: the `model` argument on
`pi.dispatch` / `ptc_subagent`, else the agent definition's frontmatter
`model:`. It is an instruction, not an observation: it outranks the _session
model_, and when neither it nor a definition names one, the session model
applies instead (ADR-0044 §Decision 1). A call-site value and a definition
value are both requests; the call site is the more specific one.
_Avoid_: "the model" (four model words exist — see above), "target model"
(nothing is sent to it; it is what the child runs on).

**session model** — the provider/model pair the caller's pi session is currently running, as pi
places it on the tool-execution context it hands a tool's `execute`. Read structurally for the
turn that issues the dispatch by `readContextModel`, validated and formatted as `provider/id` by
`formatSessionModel`, carried as `SessionModel` (`{ provider, id }`) through the dispatch context,
and resolved into the child's argv at spawn. It is a snapshot of the session's CURRENT model — not
its configured default, and not necessarily the model an earlier turn ran: a mid-session switch
changes it, while a model switched after a dispatch starts does not retro-change that child. `undefined` (no context model, or an unusable one) means "do not inherit"
— the dispatch falls through to the _configured default model_. ADR-0044.
_Avoid_: "default model" (that is the _configured default model_, the tier below this one), "parent model"
(dispatch nesting is depth, not a session — a nested dispatch inherits its own session's model), "the model" (unqualified).

**configured default model** — the provider/model pi itself falls back to when neither a dispatch nor its agent definition names a _requested model_ and no _session model_ can be read: the global model pi is configured with. It is the last resolution tier and it belongs to pi, not to the dispatch. A dispatch that lands here says nothing about that model on the request side; if the child ran, the _observed model_ is what names it (ADR-0044).
_Avoid_: "default model" unqualified (it is the configured fallback, not the session's or the requested one).

**observed model** — the provider/model a dispatched child was actually seen running, read by the host off the child's own assistant turns (last turn wins; either half may be missing). It is a measurement, never a child claim — the same authority rule as a record's `usage`, which the child also cannot declare (ADR-0032). Reported on `DispatchResult` / `TaskRecord` as `observedProvider` + `observedModel` (renamed by ADR-0045), rendered as a `model:` line on the model-facing surfaces, and stated in a refusal diagnostic. Absence means no observed assistant turn NAMED the pair — no turn, a pi within the declared floor that does not report it, or a record written before the fields existed — never "unknown model"; callers do not substitute the _requested model_ for it. ADR-0044 §Decision 2.
_Avoid_: "actual model" (there is no ground truth beyond the measurement), "child model" (ambiguous between the requested, inherited and observed model), "the model" unqualified.

**child-reported error** — the failure a dispatched child itself reports on an assistant turn: pi writes `stopReason: "error"` plus an `errorMessage` (empty content, zero usage) when a model call fails, retries a few times, exits 0. It is the child's own claim of WHY it failed, and a different channel from the host's inferences: `stderr` is best-effort and often empty, the exit code carries no signal here, and a dispatch _refusal_ means the harness declined to start a child at all. Both dispatch fronts put it on the result / record as `errorMessage`, verbatim; a `ptc_subagent` refusal renders it as a bounded diagnostic. Issue #70 (ADR-0022's silent-failure amendment) and ADR-0044 §Decision 3 are why a child that exits 0 with no text is no longer described as "produced no final text" alone.
_Avoid_: "model error" (a cause, not the channel — the same channel carries rate limits and transport failures), "stderr" (a different, best-effort channel), "refusal" (the harness declining to start; a child that ran and failed is not a refusal).

**dispatch model inheritance** — the rule that a dispatch which names no _requested model_ runs on
the caller's _session model_ instead of falling straight to the _configured default model_. First
match wins: the call-site `model` argument, the agent definition's frontmatter `model:`, the
session model, the configured default. Resolved once at spawn, so a nested dispatch inherits its
own session's model, while a direct library caller or a pi that exposes no context model falls
through to the configured default — the pre-ADR-0044 behaviour. It is paired with observation: the
result and the record state the _observed model_. Pin a model at the call site or in the definition
to opt out; there is no config key. ADR-0044.
_Avoid_: "model inheritance" unqualified (the caller's session is the source), "inherit the parent
dispatch" (each level resolves against its own session context), "default model" (that is the
_configured default model_ — the last tier, not the inherited one).

**child report** — the structured value a dispatched child produces and
the host hands back, carrying exactly four things: `summary` (one line, the
child's own words), `findings` (each with `what` and independent `evidence`),
`files_touched`, and `usage` — its four-field derived view (`input`, `output`,
`cost`, `turns`) of the counter the _TaskRecord_ carries: the record's own
six-field `usage` is the canonical copy, written on every terminal close for a
child the host started, so a non-reporting or failed child still accounts for
what it cost. It arrives over one of two channels — a report
**tool** the child calls (preferred) or a fenced JSON block in the child's
final text (the fallback) — and the result **always names which channel
delivered it**, including when none did: `tool`, `prompt-json`, `none` (the
contract was on and the child did not comply), or `opted-out` (the agent's
frontmatter set `childReport: false`, so nobody asked). Prose is preserved
alongside it, never
replaced. On by default; an agent's frontmatter opts out with one yes/no.
Bounded at 20 findings for a model-facing render, withheld count stated in-band
like the value tree. ADR-0032.

_NOT the same as_ **structured result** (that is `structuredContent`, defined
above as never reaching the model), and the two point in opposite directions:
`structured result` is machine-only and model-blind, a child report is
model-facing and is _also_ what a program reads. Reusing the older term for
this would invert its meaning. _Avoid_: "subagent report" (the word
_subagent_ is reserved for the top-level _subagent surface_, `GLOSSARY.md`
§subagent surface), "structured output" (pi has no such concept — see
ADR-0032 §What pi 1.0.0 actually offers), "child result" (the child report is
one field of a _DispatchResult_, not the whole of it).

**child report tool** — the declared tool a dispatched child calls to hand its
_report_ back: `ptc_child_report`, the preferred of the two report channels.
The tool is a **carrier, not a validator**: `execute` neither validates its
arguments nor builds a report — pi has already checked the arguments against
`CHILD_REPORT_PAYLOAD_SCHEMA` by the time it runs, and the HOST validates what
comes back through `validateChildReport`. One validator, one shape, and the side
that stamps the report is the side that reads it. The shape itself is NOT in
the tool description; it lives in `CHILD_REPORT_SHAPE`, which the child's
appended system prompt renders, and a second copy in either place is the
two-copies problem ADR-0032 rejects. The tool is **active only inside a
dispatched child**: `defaultActive` is decided by whether THIS pi process is
itself a child (`PI_PTC_DEPTH`), so a parent session registers it and never
offers it to the model — a parent has no child to report. `buildArgv`
additionally merges the name into the child's `--tools` list, because without
that merge pi's allowlist would filter the tool straight back out.
_Avoid_: "the report tool" unqualified (the child report has two channels and
this is one), "child report API" (it is a pi tool, and the shape lives in the
child's prompt, not in a schema the child reads at runtime).

**why** — the caller's reason for one dispatch slice, carried as an optional argument named `why`
on `pi.dispatch` / `ptc_subagent` and delivered to the child as its own `<pi-ptc-why>` block **after**
the policy block. It is context, not authority: the task stays the deliverable, and a disagreement
between the two is reported as a finding rather than acted on. Absent or blank emits no block at
all. ADR-0042, renamed by ADR-0043: the term was `goal` until then, and the agent ecosystem already
spends `goal` on an objective or a loop, so the name cost a reader more than it carried. `background`
was the other candidate and is unavailable — `pi.dispatch` already has a `background` argument
meaning "detach the child", one schema away. _Avoid_: "goal" (elsewhere that names an objective or a
loop), "context" (that is the host's `pi-ptc-context` policy block), "instructions" (it is not one),
"prompt" (it is one input to it).

**whyEnabled** — the config key in `~/.pi/agent/ptc.json` that decides
whether a dispatched child is handed the caller's _why_, default **on**,
read once at extension load by `readWhyEnabledConfig` and consulted per
dispatch through `DispatchDeps.whyEnabled`. Its failure direction is the
design: a non-boolean value, an unparseable file, a file that is not an
object — all resolve to ON, because a broken value must never remove the
feature. A broken **key** is reported at `session_start` with the path, the
key and the type that arrived; a broken **file** is `readDefaultModeConfig`'s
to report and this reader stays silent, so one typo produces one notice.
The opposite direction from _opt-in binding_, which grants a shell and so
fail closed. When a `why` is dropped, `DispatchResult.whySuppressed` and
`TaskRecord.whySuppressed` record **that a suppression happened**, never the
value; `/ptc why on|off` overrides it for the current session only and never
writes the file. ADR-0043 §Decision 2, which also amends ADR-0042's "not
persisted on the `TaskRecord`" — the amendment covers the event, not the
content.
_Avoid_: "opt out" (it defaults on and inverts), "privacy mode" (the block is
caller context, not caller data), "per-dispatch" (there is no per-call
override), and reading the flag as a failure — the call still succeeds, it
just says the reason was not carried.

**dispatch concurrency** — the hard cap on concurrently in-flight
dispatch in one pi session. Default 8, configurable via
`PtcConfig.dispatchConcurrency`; the live control is the
`createBackgroundTaskRuntime({ concurrency })` call that sizes the
session's one `DispatchSlotCounter`, which is acquired inside
`dispatch()`. The cap is session-scoped, **not per-run**: every front
spends it, and a background child holds its slot for its whole
lifetime. So two concurrent programs in one session share 8 rather
than 8 each, and a program sharing a session with eight live
background children can be refused every foreground slot. The 9th
concurrent call resolves immediately with `{ status: "rejected",
errorMessage: "dispatch concurrency limit reached" }` — a hard
reject, never a queue, so an over-cap call is not parked behind a
long-running child. Distinct from the soft hint for ordinary tool-call
concurrency (where pi's own parallel-tool limits are the real ceiling)
and from `maxParallelSubCalls`, which has its own counter for builtin
fan-out.

**dispatch depth** — the per-run depth in a recursive `pi.dispatch` chain.
The parent turn's PTC run is depth 0; a child spawned by `pi.dispatch`
is depth 1; a grand-child is depth 3. Configurable via
`PtcConfig.maxDispatchDepth` (default 3). A `pi.dispatch(...)` call whose
`childDepth = currentDepth + 1` would exceed `maxDispatchDepth` resolves
immediately with `{ status: "rejected", errorMessage: "dispatch depth
limit reached" }`. Aligns with dsh's `SubagentCapabilities.depthLimit`
and codex's `agent_max_depth`. ADR-0016 Recursive dispatch section.

**`pi-ptc-context` hint** — the `<pi-ptc-context depth="N" max-depth="M">...</pi-ptc-context>`
block that pi-ptc appends to a dispatched child subprocess's system prompt. It carries three
unrelated things: how much recursion room the child has (`depth` / `max-depth`), **what the child
IS** — that it was dispatched, that it cannot see the dispatching session, and that its final
message is the deliverable (ADR-0039 §Decision 4, issue #186) — and, unless the definition opts
out, the child-report clause (ADR-0032). Everything in it is pi-ptc's, and it is _appended_ to pi's
own system prompt rather than substituted for it: for a child with no agent definition the block is
the whole of what the prompt file adds, with pi's own prompt still underneath. Shape mirrors
DSH's `subagent-context` injection; the only difference is the depth /
max-depth attributes, which are pi-ptc-specific. ADR-0016 Recursive section, ADR-0039.

**read-only tier** — the optional `readOnly` argument on a `pi.dispatch` call, in two tiers:
`"strict"` narrows the dispatched **child pi process's** tool list to the read set — the tools that
**cannot write** — so a child that can search the web keeps that ability (ADR-0049: reading is not
writing, and a narrowing that silently removed the only route to the web left the child with no
web tool at all); `"lenient"` narrows nothing and only adds one clause to the _`pi-ptc-context`
hint_. Strings only — a boolean was tried first, and pi's validator coerced `readOnly: 0` into "no
tier", a silent full-capability child for a caller who asked to be read-only; the string enum refuses
every wrong-typed value at the schema (ADR-0041 §Decision). Which side it narrows is load-bearing:
the child's own tools, decided at the call site — **not** the PTC worker's binding surface, which is
what the _R3 read-only PTC surface_ narrows (an explicit `names` list curating the binding
table). The two axes meet at one point: a strict tier at the call site decides the child's tool
list outright. ADR-0041.
_Avoid_: "read-only mode" without a tier named, "read-only dispatch" (that names the argument's two
tiers, not a kind of dispatch), and reading the strict tier as a boundary — it is a narrowing, not
a sandbox.

**run_code** — the model-facing tool name DSH exposes in PTC mode. The pi
version exposes `ptc_run_code` to avoid collision with pi's hypothetical
future native `run_code`, plus a sidekick `ptc_workflow` for structured
(with `meta` + `args`) runs.

### Which pi: two floors, not one

This package makes a RANGE claim about pi, and the range is not the same
object as the capability set. Both numbers below are real and neither is
"the" floor; calling either one that is how the other one gets used.

**declared floor** — the lower bound `peerDependencies` writes down:
`@earendil-works/pi-coding-agent: ">=0.86.0"`. It is a claim about **this
package** — the oldest pi it installs and runs on — and it is measured, not
aspirational: `src/` typechecks against that version's tree with zero errors
and the package installs and runs on it. That holds because the three fields pi
grew onto `ToolDefinition` after it (`outputSchema`, `exposure`,
`defaultActive`) are declared locally in `CompatToolDefinition` instead of
being read from pi; on a floor pi they are **inert**, and an unread optional
field still registers and runs. The dev dependency pins `1.3.0` (as of 2026-10-20), so the
default gate measures the ceiling of the range and `compat:pi` is what measures
the edge. The measured table is `docs/agents/pi-compat-matrix.md`. _Avoid_:
"floor" unqualified (there are two), "minimum supported pi" (same number, but
it reads like a capability claim, which is the confusion this section exists to
stop), "supported pi version" (every version in the range is supported; the
declared floor is where the claim starts, not where features start).

**capability floor** — the version at which a given pi API **appears**, and for
every API this package leans on that is **0.99.0**: not 1.0.0, and not the
declared floor. `AgentToolResult.isError`, pi's own `codemode` extension,
`ToolExposure` and the `exposure` field, and the `structuredContent` forward
are all present in 0.99.0 and absent below it. Below that line the gap is a
**capability absence, not a defect** — there is no `codemode` to hand
orchestration to, so _surface mode_ detection resolves to `full` anyway, and
this package compiles and runs there without any of the four. _Avoid_: "floor"
unqualified (both terms are floors), "minimum pi version" (that is the declared
floor), "0.99.0 is the floor" (true of these four capabilities, false of
`peerDependencies`, and the two are set independently).

## Narrowing mode

**strict program** — a PTC program runs in **strict mode**（2026-10-21 grill 决定）：
`new Function` 的 body 开头带 `"use strict";`，整个程序体（连同它里面定义的函数）都是严格的。

Three reasons it is strict rather than sloppy:

1. **It is what upstream DSH does** — DSH materializes the program as
   `new AsyncFunction(..., "'use strict';\n" + code)(...)`. Not a preference: an
   upstream difference we had not registered in the parity audit.
2. **We run TypeScript** — TS emits `alwaysStrict` for modules by default, so
   `stripTypeScriptTypes` was silently dropping the strictness the author
   expected.
3. **Sloppy mode had two measured costs** — assigning to an undeclared name
   really does create an implicit global on the worker's global object
   (measured: an own enumerable property). The worker's warm-baseline restore
   deletes it before the next run, so today it does not reach the next program
   — but it exists, and its cleanup is a separate mechanism; strict mode makes
   it never exist. And the silent case was the **write** side, not the read
   side: a bare read of an undeclared name already threw in sloppy mode, while
   assigning to a misspelled name succeeded quietly. Strict mode turns that
   write into a `ReferenceError`.
   (2026-10-21 grill 决定；代价一在实现票 #244 于 base commit 上复测后订正，见 ADR-0060。)

**Breaking**: top-level `this` becomes `undefined` (was `globalThis`), an
implicit global becomes a `ReferenceError`, duplicate parameters become a
compile-time `SyntaxError`, and octal literals become a `SyntaxError`. A program
may still write `"use strict";` itself — it stays legal and is a no-op. There is
no in-program opt-out: JavaScript has no `"use sloppy"` directive.

Distinct from _read-only tier_ (which narrows what a CHILD may change) and from
_JS hardening_ (the prototype-pollution axis, still open — the parity audit's
A8 row, where DSH captures Node intrinsics and uses `Object.create(null)` and we
do neither).

The session-level switch that makes a session work the PTC way. It is one of
the two switches `/ptc on` and `/ptc off` control — the other is the
_dispatch switch_ (ADR-0050); it is a _toggle_, not the technology
(see _PTC mode_ in §Project terms).

**narrowing mode** — the session-level tool-restriction state machine: while
enabled, the session's visible tool loadout is narrowed so the model reaches the
bound built-ins only from INSIDE a program (`tools.<name>(args)`). It is not a
separate execution path — same worker, same dispatcher, same bindings; it
changes only _what the model may call directly_. It is decided per session at
`session_start`, announced once, and always reversible (`/ptc off` restores the
loadout). TUI-only: print, JSON and RPC sessions are left exactly as launched,
because forcing the shape on a CI script buys nothing — nobody is watching a
CI run's tool list — and what it costs there is measurable but small: measured
2026-10-21 against a real pi, removing the TUI-only check narrows an ordinary
`pi -p` session (the built-ins leave the model's loadout) while the JSON output
contract, the binding table and the run itself all survive. So the cost is
_what the model is offered_, not a broken run — an earlier version of this
entry called it "breaks it", and the measurement did not support that.
Distinct from _surface mode_, which decides which model-facing tools are
REGISTERED, from _dispatch switch_, which decides what may be STARTED, and
from _PTC mode_, which is the technology this switch puts to use.
ADR-0010, ADR-0025, ADR-0050. _Avoid_: "PTC mode" (that is the acronym — see
§Project terms), "mode" unqualified (ambiguous: _surface mode_ and the
_narrowing mode_ both exist), "restriction mode" (that is the _read-only tier_'s
shape, applied to a child rather than to a session), "PTC default mode"
(ADR-0010's title — keep it as an alias of this entry, not as a second name).

**base snapshot** — the loadout captured BEFORE the narrowing mode hides
anything, and the source the binding table is derived from while the mode is
on. Without it the mode would neuter itself: bindings are computed as
`BUILTIN_BINDING_NAMES ∩ pi.getActiveTools()`, and the mode hides exactly the
built-ins that set contains, so reading the LIVE loadout would empty the
binding table and every `tools.read(…)` would fail with "not bound". The
snapshot keeps the guarantee that a program never reaches further than the
session it runs in — `base` IS the session's own loadout, so a session launched
with `--tools read` has `base = ["read"]` and bindings stay `["read"]` — while
making the mode's own narrowing transparent to the binding table. It is
reconstructed at `session_start`: a persisted `base` wins only when the live
loadout is still the narrowed one (a `/reload` or a resumed session); otherwise
the live loadout wins, so a new `--tools …` choice is not overridden by an
older session's snapshot. ADR-0010 §2, ADR-0005 addendum (T7, #21).
_Avoid_: "binding snapshot" (it is a loadout snapshot that happens to feed the
binding table), "frozen loadout" (it is not frozen — it is reconstructed per
session), "the mode's loadout" (that is the NARROWED one, which this snapshot
exists to be different from).

**hide strategy** — how much of the loadout the narrowing mode hides:
`ModeHideStrategy` is `"builtins-only" | "all-but-ptc"`. The shipped default is
`builtins-only` — the seven built-ins go off the model's direct list while every
other extension's tools stay. `all-but-ptc` leaves only `ptc_run_code` /
`ptc_workflow` reachable; it is implemented and unit-tested for callers who
want the strict shape, but it is NOT the default, because pi's
`pi.getAllTools()` returns metadata only (`name`, `description`, `parameters`,
`promptGuidelines`, `sourceInfo`) — no `execute` — so a binding for another
extension's tool is impossible to build, and hiding such a tool would make it
unreachable for the whole session. This is the one place where the shipped
behaviour is deliberately LESS strict than DSH's PTC preset, and the reason is
a hard API limit rather than a preference. ADR-0010 §3.
_Avoid_: "strict mode" (the _read-only tier_ owns "strict"), "mode" (see
_narrowing mode_).

**mode entry** — the decision to enter the narrowing mode, and the conditions
that gate it. `decideModeEntry()` returns a `ModeEntryDecision` whose
`ModeBlockReason` names the blocker: `not-tui` (a non-TUI session is left
exactly as launched), `config-off` (`~/.pi/agent/ptc.json` set
`{"defaultMode": false}`; an absent file means on, and a malformed file is
reported to the user and still defaults to on, because silently flipping a
behaviour this visible is worse than the malformed file), `tools-unavailable`
(neither `ptc_run_code` nor `ptc_workflow` is enabled — there would be nothing
to run), and `restricted-session` (the session was launched with an explicit
tool restriction — `--tools`, `--exclude-tools`, `--no-builtin-tools` — so
narrowing further would override a deliberate instruction; the session stays as
launched, and the PTC surface would be degraded anyway). The restricted-session
check deliberately compares against pi's four DEFAULT tools (`read`, `bash`,
`edit`, `write`), NOT against `BUILTIN_BINDING_NAMES` — that list is every name
that can be bound, not what a default session has (`grep` / `find` / `ls` are
bindable but off by default), so requiring all seven would misread every
ordinary session as restricted and never turn the mode on. `/ptc on` overrides
everything but the TUI and availability checks: a restricted session enters
with its own smaller loadout as `base`, so bindings stay inside the user's
allowlist. There is no CLI flag — pi's extension boolean flags can only be set
to true, and `--no-ptc "a prompt"` would swallow the prompt as the flag's value.
ADR-0010 §4–§5. _Avoid_: "mode on" (on is one of two outcomes and this entry
covers both), "entry policy" (the same thing, less precisely), "activation"
(that is the package's _default-on_).

**drift notice** — the report that the narrowing mode has EXITED because
someone else owns the tool loadout now. `detectExternalLoadoutChange()`
compares the live loadout against `ourLoadout`, the exact array the mode wrote;
a mismatch means another extension (pi's own `preset.ts` and `tools.ts`
examples call `setActiveTools()`) or the user took ownership. The mode then
exits and restores `base` rather than fighting over it — it never re-asserts
itself over another actor. Always false while the mode is off. ADR-0010 §6.
_Avoid_: "loadout drift" (that is the condition; the notice is what the user is
told), "conflict" (implies two parties disagree, when the rule is that the
later owner wins), "extension takeover" (the user can be the one who changed
it).

**skills section** — pi's `<skills>` block in the system prompt, and the
narrowing mode's duty to keep it. pi advertises skills only when the session
can actually open one: its prompt builder checks whether `read` or `bash` is in
the selected tools, and the narrowing mode hides exactly those two — so the
gate drops the section, and with it the model's only way to learn that skills
exist. Measured on real session files: sessions before PTC-mode-by-default
carried 43 skills in `SystemMessage.sections.skills`; narrowing-mode sessions
carried no `skills` section at all. The list body stays pi's own
(`formatSkillsForPrompt` is a public export and its XML shape is the
agentskills.io spec, so re-deriving it here would only create drift); only the
loading SENTENCE changes, because "Use the read tool" is false in a session
where `read` is hidden and the way in is `tools.read` from inside a program.
ADR-0011. _Avoid_: "the skills prompt" (it is a section of the system prompt,
and "prompt" is the thing it is part of), "skill loading" (that is the
instruction the section carries, not the section).

**`<ptc>` section** — the custom system-prompt section this package writes on
every turn, carrying how to reach a child on the surface in play. It exists
because a tool's own description reaches the model only while that tool is
offered to it, and on the `subagents` surface the pair that carried the calling
convention was offered to a SCRIPT rather than to the model: measured
2026-10-20, a parent there had no way to learn that a `codemode` script's tool
table holds no `pi.dispatch`, wrote `await tools["pi.dispatch"]({ task })` into
a script, and got `TypeError: tools.pi.dispatch does not exist` three times
before falling back to `ptc_subagent`. A section does not have that dependency:
pi merges every custom section into the system prompt unconditionally, so the
text reaches the model on every surface and in every run mode. Its content
follows the surface — the program form on `full`, the top-level face on
`subagents` — and when the _dispatch switch_ is off it says only that
dispatching is off, because handing a model a convention it cannot follow is a
wasted call. Distinct from the _skills section_, which is pi's own block and
this package's duty to keep. ADR-0029, ADR-0050.
_Avoid_: "the PTC prompt" (it is one section of the system prompt), "dispatch
section" (that is ADR-0016's recursive-dispatch section, a different thing).

## PTC run outcomes

**PTC error kind** — the seven-value taxonomy every failed run resolves to, in
`PTC_ERROR_KIND`: `exception` (program parse error or thrown exception,
including the `ReferenceError` from a helper that does not exist on this
surface), `timeout` (elapsed deadline expiry), `abort` (caller cancellation),
`protocol` (malformed or excessive control traffic), `worker-exit` (early
worker exit or a worker-level crash), `invalid-output` (the completion value
could not be materialized as lossless JSON), and `output-limit` (oversized
outer result; the collected logs are retained). It is R1 §3's taxonomy minus
`sandbox-unavailable` (this package ships no OS sandbox, ADR-0007) and minus
every `agent`-related kind (there is no `agent()` helper). The table lives in
one place, `src/runtime/protocol.ts`, and the worker receives the same tables as
plain data at spawn, so the two ends of the wire cannot drift on names.
_Avoid_: "error type" (it is a kind; the shape around it is `PtcErrorShape` —
`kind`, `message`, optional `stack`), "failure reason" (a reason is a cause;
this is the taxonomy's bucket), "exit code" (that is one input to the
diagnosis, not the kind).

**truncation contract** — the model-facing text ceiling this package inherits
from pi: pi's `truncateTail` at 50 KB / 2000 lines, TAIL-biased. Two rules
make it a contract rather than a constant: the text is cut from the tail, so
the end of a long output survives, and the UNTRUNCATED text is written under
`os.tmpdir()` before the tail is cut, so the pointer the model receives never
names a partial file. Two call sites implement it — the run-scale text block
(`renderToolResult`) and the task-scale output dereference (`ptc_task_output`) —
and both go through one shared implementation, so the two cannot drift.
ADR-0015. _Avoid_: "truncation" unqualified (the direction matters —
tail-biased, not head), "output limit" (that is the run's byte budget,
`maxOutputBytes`, ADR-0003 — a different ceiling at a different boundary), "the
50 KB limit" (the limit is part of the contract; the contract also carries the
tmpdir rule).

## Worker lifecycle (ADR-0017)

**worker pool** — the per-surface collection of warm `worker_threads` workers
owned by the parent turn, held by a `TurnPools` holder. Created lazily by the
first PTC run of the turn, passed to `runPtcProgram()` via
`RunPtcProgramOptions.pool`, retired by the extension's `turn_end` hook.
Default `poolSize` 4, `poolAcquireTimeoutMs` 30s. `run_code` and `workflow` do
not share a pool. _Avoid_: "singleton" (this is per turn), "thread pool" (Node
idiom for something else).

**warm worker** — a `worker_threads` Worker that has been retained after a
run settled and may be reused for a future run in the same pool. The worker's
internal state machine is `CREATED → BOOTING → READY ↔ RUNNING`; only
`READY`-state workers are eligible for warm reuse.

**reset handshake** — the extended meaning of the `ready` worker frame: on
warm reuse, `ready` means "this worker has cleared all per-run state and is
ready for the next `init` frame". On cold start, `ready` keeps its original
meaning ("booted"). No new frame kind.

## TUI rendering — partial-state visibility (ADR-0020, ADR-0021)

**partial-state render** — the visual treatment of a PTC row while a run is in
flight (`isPartial: true`). Three visible parts: a shimmered description on
the parent row, a sub-call tree under it, and right-aligned meta not yet
present. The _subagent surface_'s call row joins the same partial/settled
distinction with two differences: there is no sub-call tree under it, and its
right-aligned meta states the dispatch **request** (`foreground`/`background`,
the read-only tier, a _requested model_ when the call site pinned one) rather
than the run's measured facts — so that meta is present from the first frame
and only the shimmer band separates partial from settled. A **generalist** dispatch (no agent
named) that names no _requested model_ shows `model=inherit` when the host could read the
caller's session model, and its expanded row names that inherited model; a named agent gets no
such claim (its definition may pin the model above the session tier), and a pinned _requested
model_ is stated instead. The inherited value is captured at the call's first render, so a later
model switch does not change an already-rendered row. The _observed model_ is still a result
fact, so it appears in the _tool-result text_, not in this request meta. _Avoid_: "running state", "loading state" (these collide
with pi's own `toolPendingBg` / settled-state distinctions elsewhere in the TUI).

**settled-state render** — the visual treatment after the run completes
(`isPartial: false`). Description is uniformly `accent` (no character is
highlighted), sub-call tree is fully populated with their final statuses, and
right-aligned meta is present. By ADR-0020 §5 and ADR-0021 §8, the only
visible difference between partial and settled is the shimmer band on
running rows + the row colour of sub-calls still in flight.

**shimmer** — DSH's `TextShimmer` design, adapted to ANSI: same text
content, one character at a time is bright (`accent`) and the rest dim — except at the
sweep-off step, where every character is dim.
The bright character's position advances one step per 150ms, wrapping at
the description's length. Subtle by design (DSH §A; ADR-0020 "trade-off,
restated"). _Avoid_: "TextShimmer" alone (that name refers to DSH's CSS
implementation, not ours); "pulse" (that name covers too many distinct
visuals — see ADR-0020 §1 vs `Loader`, Knight-Rider, trailing dots).

**shimmer band** — the bright accent character at the current band
position. In a description of length N the band visits positions 0 … N
inclusive (`% (N + 1)` in the formula). At the extra step N the band has
swept past the end and the whole description rests at the off-band colour
(`dim`) — never the settled all-`accent`, which would make one frame per
sweep indistinguishable from a finished run. Everywhere else the bright
character is the **only** colour difference; font, position and glyphs are
identical in both states.

**bandPos** — the integer index of the bright character on a running row,
computed in `render()` as `floor((Date.now() - startedAt) / intervalMs) %
(desc.length + 1)`. It is **derived, never stored**: the "no character
highlighted" state is a cleared `startedAt` (settle), which short-circuits
the whole band computation. _Avoid_: a `-1` sentinel (an earlier draft
stored one; the render path no longer tests for it).

**ShimmerDecorator** — the module that owns the shimmer mechanism:
`src/tools/shimmer.ts`. Exposes `withShimmer<T extends Component>(inner,
options): T`, which wraps a pi-tui `Component` with the band's colour
cycle, and attaches a `dispose()` hook that stops the interval (belt-and-braces:
production settle rides pi's `isPartial` flip, and pi never disposes a tool row
itself — the hook exists for a caller that replaces a still-partial row). Its
lifecycle state — `startedAt` and the interval handle — lives in the
**`ShimmerState`** bag the caller passes in, which is pi's
`ToolRenderContext.state`. It cannot live on the decorated instance:
pi rebuilds the row on every `updateDisplay()`, and the shimmer's own
interval triggers one, so instance state would restart `startedAt`
each tick (band frozen at position 0) and leak the previous interval.
Used by every PTC **call row** — the program rows and the _subagent surface_ row;
sub-call rows do not shimmer (US16). _Avoid_: "shimmer wrapper" (too generic),
"shimmer component" (collides with the `Component` vocabulary elsewhere).

**ShimmerState** — the two-field bag `{ startedAt?, interval? }` that
carries the shimmer across the row recreation pi performs. Owned by pi
(`ToolRenderContext.state`, one bag per tool call) and threaded through
`PtcRenderOptions.state`; `withShimmer` reads and writes it. Direct
library callers and tests may pass a throwaway `{}`.

**sub-call tree** — the list of `SubCallRecord` rows under a PTC parent
row, always visible: both while the run is in flight (pushed live through
pi's `onUpdate`, so the reader can see which binding is currently in
flight) and at settle, and in both collapsed and expanded states. Each row
carries its own status + duration; order = host-side dispatch order; capped
at `maxSubCalls = 32` with a `└─ …+N more calls` tail. ADR-0021.

**SubCallRecord** — the per-binding-call data the dispatcher tracks and
the renderer reads:

```
{ callId, name, args, status, startMs, endMs?, durationMs?,
  resultSummary?, errorMessage? }
```

Copied out of `SubCallTracker.snapshot()` and into `PtcToolDetails.subCalls`
by `renderToolResult`. The snapshot copies the records, so a captured push
shows the state as of that moment rather than the state the record was later
mutated into. _Avoid_: "binding call", "tool call" (those refer to the
binding's own concept, not the record we surface to the renderer).

**SubCallStatus** — the five-state union on a `SubCallRecord`:
`"running" | "ok" | "error" | "cancelled" | "rejected"`. `running` is the
moment between `call`-frame arrival and binding resolve; `ok` / `error`
follow `binding.execute` resolution; `cancelled` is set when the run's
`AbortSignal` fired before the binding resolved; `rejected` is set when
the `pi.dispatch` capacity gate (ADR-0016 §2) declined the call before
it started. ADR-0021 §6. _Avoid_: three-state collapsing (DSH has
running/ok/error; we add `cancelled` + `rejected` because the dispatcher
already knows them).

**SubCallTracker** — the module that owns the `SubCallRecord` lifecycle:
`src/runtime/sub-call-tracker.ts`. Exposes `recordStart(callId, name, args)`,
`recordEnd(callId, status, summary?)`, `snapshot(): readonly SubCallRecord[]`.
Dispatcher holds one instance per run and calls `snapshot()` on every start
and end (feeding the tool's throttled live push) and once at settle. The
renderer never sees the tracker directly, only snapshots that reached it via
`PtcToolDetails.subCalls`. ADR-0021 §9. _Avoid_: "sub-call store",
"sub-call list" (the data is a snapshot, copied per call, not a live view of
the tracker's internals).

**args preview** — the one-line summary of a sub-call's args, rendered
after the status cell. `read` → `args.path`, `bash` →
`args.command`, `grep` → `args.pattern`, `find` → `args.pattern`,
`ls` → `args.path`, `edit` → `args.path`, `write` → `args.path`.
Falls back to `JSON.stringify(args)` truncated to 40 chars when the
selector misses — **the only place** `JSON.stringify` is acceptable on a
sub-row. ADR-0021 §3. _Avoid_: "args display" (vague), "args format"
(implies the JSON-format capability).

## Background dispatch and task lifecycle (ADR-0022, ADR-0023, ADR-0050)

**ULID** — the identifier format every task-scoped id uses: 26 characters of
Crockford base32, `TTTTTTTTTTRRRRRRRRRRRRRRRR` — 10 characters (48 bits) of
ms-epoch followed by 16 characters (80 bits) of entropy. The alphabet omits
`I`, `L`, `O` and `U`, and its order means **lexical sort equals creation
order**, which is what lets a task list be ordered by id without a second sort
key. Entropy comes from `crypto.randomBytes` (never `Math.random()`), so two
ids minted in the same millisecond are distinct, and a per-ms increment makes
them strictly increasing. `ULID` is a compile-time BRAND
(`string & { __brand: "ULID" }`) and nothing more: the runtime value is a plain
string, and the brand only keeps a taskId from being passed into a cursor slot
by accident. `src/runtime/ulid.ts` is the single source of truth for the
alphabet, the time encoder and the minter — before it, two independent
implementations had to be kept from drifting and were joined by an `as ULID`
cast. _Avoid_: "UUID" (a different format, and not lexically sortable), "id"
unqualified (the format matters: it is what makes the ordering claim true).

**dispatch task** — the instruction prose a caller passes as `task` to
`pi.dispatch(...)` or `ptc_subagent`: what the child is asked to do, sent as its
user message (`Task: …`). It is not the whole assembled prompt (the appended
system prompt carries the policy context), not the caller's reason (that is the
dispatch `why`, ADR-0043), and not a **background task** (the _TaskRecord_
lifecycle row a `{ background: true }` dispatch creates). _Avoid_: "task"
unqualified (ambiguous between this and the lifecycle row), "prompt" (the
assembled whole), "goal" (the retired name of `why`, ADR-0043).

**DispatchHandle** — the thin 3-field snapshot returned by background
`pi.dispatch(...)` when `{ background: true }` is set:
`{ taskId: ULID, label: string, status: "running" }`. Spawn-time projection
of the TaskRecord; not updated on transition. Programs that need live
state call `ptc_task_list` instead. See ADR-0022.

**background dispatch** — the long-lived variant of `pi.dispatch`. The
spawning program's model observes the spawned child via `<bg-task-notification>`
events delivered through the TaskRegistry subscription buffer, and via
model-facing tools `ptc_task_list` / `ptc_task_output` / `ptc_task_stop`.
The child survives the spawning program, the spawning turn, and
`/ptc off`; it is owned by the dispatching pi process (the _task owner_)
and ends when that session ends or is replaced
(`session_ended_while_running`) or when the owner process dies before
completion (`lost_on_session_restart`). See ADR-0022 + ADR-0023.

**dispatch switch** — whether this session may start NEW children. A
session-level switch, on by default, turned off by `/ptc off` together with the
_narrowing mode_ — "off" has to mean one thing (ADR-0050). It is not the
_narrowing mode_ (which decides what the model may CALL directly) and not
_surface mode_ (which decides what is REGISTERED); it decides what may be
STARTED. It never reaches a child that is already running: a child is its own
process, so a refusal to start a new one cannot touch it — which is also why
the _lifecycle face_ stays in front of the model while a task is in flight, and
why the user is told at the moment of the switch that the running ones are NOT
affected. A refused call comes back as `{ status: "rejected", started: false }`
with the message `PTC is off in this session: no new child can be started (run /ptc on to allow them again)` — it names the
way out, because a refusal the caller cannot act on is one the model retries.
Measured 2026-10-21: before ADR-0050 the switch did not exist and `/ptc off`
gated nothing about dispatch at all — a parent still dispatched a child with it
off, and the _lifecycle face_ stayed in front of the model with nothing to
explain it. _Avoid_: "dispatch gate" (that is the _dispatch concurrency_ /
_dispatch depth_ caps, which refuse for capacity rather than for policy),
"narrowing mode" (the other switch), "PTC mode" (the technology).

**TaskRecord** — session-level _TaskRegistry_ row tracking the full
lifecycle of one background child. 28 fields today: ADR-0022 §3's code block lists
22 of them — its 19 originals (the block's "21 fields" heading is the authoring
miscount it always was), the 2026-10-16 top-level `usage`, and the ADR-0044
_observed model_ pair (`observedProvider`, `observedModel`, written at the same terminal close as
`usage`: the model the child actually ran, absent when no observed assistant
turn named it) — and the rest are the two optional owner-identity fields (`ownerPid`,
`ownerBootMs`, ADR-0023) stamped at spawn, the two optional _child report_
fields (`report`, `reportChannel`, ADR-0032) written only when the record
reaches `succeeded` — so a still-running or failed task carries neither, because
"has not reported yet" is not "reported nothing" — the optional
`readOnlyTier` (ADR-0041), and the optional `whySuppressed` (ADR-0043). The block's `usage` is the
host's own six-field counter, written on every terminal close for a child the host actually
started:
independent of `reportChannel` and of the close outcome, so a `none` /
`opted-out` or failed child still accounts for what it cost, while a record
written before the field existed, a child that never started, and a `lost`
record carry none. Persisted to `<sessionDir>/tasks/<taskId>.json` per R1.
Independent of `DispatchResult` and `SubCallRecord` — the _child report_'s
four-field `usage` view is derived from the record's own counter, not a second
one. See ADR-0022 + ADR-0023 + ADR-0032 + ADR-0041 + ADR-0044.

**TaskStatus** — the 6-state enum for `TaskRecord.status`:
`running / stopping / succeeded / failed / canceled / lost`. The `queued`
state is deliberately absent in v1 (spawn-or-reject, no in-task queue).
See ADR-0022.

**TaskRegistry** — session-level singleton holding `TaskRecord` rows and
their per-subscriber `Subscription` cursors. On session restart,
replays events whose cursor is ahead of the highest-scanned position.
Its startup reconcile marks a `running`/`stopping` record `lost` (reason
`lost_on_session_restart`) only when the record's owner process is dead
(or the record predates ownership); its shutdown sweep marks only its own
still-running records `lost` (reason `session_ended_while_running`).
Reaping is owner-scoped — see _task owner_. See ADR-0022 + ADR-0023.

**BackgroundTaskRuntime** — the session-scoped holder for everything the
`ptc_task_*` tools and the background branch of `pi.dispatch` need: the
`TaskRegistry`, the `OutputStorage`, the notification pipeline, and the ONE
`DispatchSlotCounter` that sizes the session's _dispatch concurrency_. It is
constructed once in the extension factory, BEFORE any session exists, because
the model-facing tools capture its delegates once and are built later — a pi
session starts after the factory runs and can be re-bound (resume / fork), so
the holder closes that gap by exposing STABLE delegating objects whose
per-session delegate is swapped underneath them. Before the first bind they
delegate to an in-memory pair, so a session-less context (direct library use,
unit tests) is fully usable. The slot counter lives HERE rather than per-run
precisely so that a long-lived background child keeps counting against
`dispatchConcurrency` across program boundaries; the task id is the slot
token, and the release is idempotent per task, so exactly one slot is freed no
matter which party (the detached pump or the shutdown reclaim) runs first.
_Avoid_: "the runtime" unqualified (the worker runtime is a different thing —
see _worker surface_), "background runtime" (the same object, shorter and less
distinctive), "task service" (it holds state, it does not serve anything).

**task owner** — the identity of the extension-runtime instance that
created a `TaskRecord`: `{ ownerPid, ownerBootMs }` (process pid + the
runtime instance's start ms, minted once per _BackgroundTaskRuntime_).
A record belongs to exactly one owner; only the owning runtime reaps or
terminates it, so a sibling pi process sharing the session dir (every
background `pi.dispatch` child does) neither reaps nor kills another
owner's tasks. Listing stays cross-owner. See ADR-0023.

**Subscription** — per-subscriber cursor for one `TaskRecord`.
Persisted to `<sessionDir>/subscriptions/<subscriberId>-<taskId>.json`.
The ADR's fork-cursor rule is `max(parent, child)` (child observes
post-fork events only) and it names an explicit-reset surface
`ptc_task_resubscribe(taskId, since: "initial")`; neither the helper nor that
tool ships in v1 — the caller supplies `since` and a resubscribe tool is
deferred to v2. See ADR-0022.

**output storage** — the persistence seam for a background task's captured
output. The `TaskRecord` deliberately does NOT carry the child's result body:
it keeps only a small projection — `outputRef` (the path), `outputBytes` (the
size) and `outputPreview` (≤ 2 KB of inline text) — and the raw text is
reached by dereferencing `outputRef`. The seam is `OutputStorage`, a
three-method interface (`readOutput` returns `null` for "no output yet", an
EXPLICIT ABSENCE that is never a silent empty string; `writeOutput` accepts
any string), with an in-memory backend for tests and ephemeral sessions and a
file backend writing `<sessionDir>/tasks/<taskId>/output.log`. The adapters
store and return the RAW text; truncation is applied by the CALLER (the
`ptc_task_output` tool), through the _truncation contract_, so the pointer
the model receives never names a partial file. The inline-preview rule is a
byte budget, not a heuristic: `outputPreview` is present only when
`outputBytes <= 2048`, and above that the renderer must dereference
`outputRef`. ADR-0022 §3 + §6. _Avoid_: "output file" (the in-memory backend
has no file), "task output" (that is the text; this is where it lives), "log"
(the file is `output.log`, but the concept is the seam, and the truncation
contract is not the same as a log rotation).

**`ptc_task_*` (model-facing management tools)** — the _lifecycle face_: three
tools, offered to the model whenever a task may need managing, and withheld
from it only while the _dispatch switch_ is off and no task is in flight
(ADR-0050; before that they were never gated at all):
`ptc_task_list({ status?, limit? })` returns matching TaskRecords
(newest first, default limit 100); `ptc_task_output({ taskId, sinceBytes? })`
dereferences `outputRef`, applies ADR-0015 truncateTail, and renders the
persisted _child report_ ahead of the prose when the record reached
`succeeded` (ADR-0032); `ptc_task_stop({ taskId, reason? })` triggers
`running → stopping → canceled` (the dispatcher delivers the signal).
See ADR-0022.

**`<bg-task-notification>` (event schema)** — user-role XML emitted to
the model when a `TaskRecord` changes. Batch parent `<bg-task-notifications>`
wraps N per-event children; per-event `<bg-task-notification>` carries
`id="task:<ulid>:-><status>"`, `task-id`, `subscription-id`, `status`,
`label`, `agent-name`, `depth`, `duration-ms`, `transition-at-ms`,
`<output-bytes>`, optional `<error-message>` (only when the record carries an `errorMessage`
— `failed` / `lost` in practice; head-truncated to 1024 code points, an ellipsis marking the
cut, and XML-escaped), optional `<report-channel>` on a `succeeded` event (`tool` /
`prompt-json` / `none` / `opted-out` — the record's declared channel, ADR-0032), optional
`<output-ref>`, optional `<output-preview>` (only when outputBytes <= 2048). See ADR-0022.

**dispatch sub-row** — the variant of a sub-row for `pi.dispatch(...)`
calls. Uses the binding's `agent` argument for the args preview and reads
its state from `DispatchResult`: a refusal (`status: "rejected"` with
`started: false` — depth or concurrency gate, the _dispatch switch_, unknown
agent, a spawn that
never happened) is `rejected`, a child that ran and failed
(`started: true`) is `error`, and everything else is `ok`. One per dispatch call; no recursion into the child PTC run's
tree (ADR-0021 §7).

## DeepSeek search module (ADR-0049, ADR-0048)

**child-only search tool** — a capability that exists **only inside a dispatched
child** and is **model-facing there**: the child's own model calls it as a
tool of its own, one call, with no program in between. The parent's
capability is _absence_, not _hiding_ — the tool is not in a parent
session's registry at all, and a parent does not even resolve the
credential that would unlock it. The depth test is the same one that
gates `ptc_child_report`: the process carries `PI_PTC_DEPTH` when it was
dispatched. It is a property of a capability's _reach_, not of a session's
state — the _narrowing mode_ is the session-level toggle, and
`exposure: "hidden"` is the opposite of this (hidden means unreachable at
all). _Avoid_: "hidden tool" (hidden is unreachable, the opposite),
"internal" (says nothing about reach), "narrowed" (that is the _narrowing
mode_), "private" (it is not private — the child's model calls it
directly), "program-internal" (the shape this replaced; a program's
binding table is a different thing).

**DeepSeek search module** — this package's built-in web retrieval: DeepSeek's
**Search** and **Fetch** APIs, which are model-agnostic raw JSON endpoints
(`POST /v1/tools/search` and `/v1/tools/fetch`) carrying no `model` field, so
they are decoupled from the chat model entirely. One implementation, one
**child-only** face, gated by the _search gate_, results passed through
unchanged (no citation assembly — `url` is the only source identifier, and
the model assembles its own citations). The retrieval source is **fixed**, not
pluggable. Its two names both carry `ds`, because the capability needs a
DeepSeek key and bills DeepSeek: the pi tool is `web_ds_search` and the
config key is `webDsSearch`. _Avoid_: "web
search" unqualified (it does not say which provider — `web_search` is DSH's
tool, see _Out-of-glossary_), "search tool" unqualified (the parent's model
never calls it — its children do).

**search gate** — the conditions that decide whether the DeepSeek search
module is usable in a session: a **switch** (`webDsSearch.enabled` in
`~/.pi/agent/ptc.json`, **off by default**), a **credential verdict** (the
DeepSeek credential is present and resolves to a non-empty key), and
**being a dispatched child**. Switch off ⇒ the capability is not registered
anywhere. Switch on but no credential ⇒ it
**is** registered in the child, marked unusable, and announced once at session
start — the
missing key is a stated state, never a silent failure. The verdict follows pi's
own resolution order (stored credential → provider config → environment) and
must use a **resolved** key, not the raw stored one. _Avoid_: "enabled" /
"disabled" unqualified (the switch is one of three conditions), "configured"
unqualified (means the key is present, which is only half the gate).

## Release & supply chain

**release tag** — an annotated git tag `v<version>` on `main`; pushing it is the act
that publishes the package (the `v*` workflow does the rest). The tag must agree with
`version` in `package.json`. _Avoid_: "version bump" (the commit that precedes the
tag), "npm publish" (the mechanism the tag triggers).

**trusted publishing** — npm's OIDC publish path: the `publish.yml` workflow is
registered on npmjs.com as this package's trusted publisher, so no long-lived npm
token exists anywhere. ADR-0018 §2. _Avoid_: "NPM_TOKEN" / "automation token" (this
package has none).

**provenance** — the signed build attestation npm attaches to a published version.
**Absent for this package**, because npm generates it only for public source
repositories; the absence is expected, not a publishing defect, and it clears by
itself if the repository is ever made public. ADR-0018 §7. _Avoid_: "signature"
(registry signatures are a different npm feature).

**staged publishing** — npm's optional approval gate (`npm stage publish`, then a 2FA
`npm stage approve`). Not adopted here; ADR-0018's considered options say why, and
when to revisit. _Avoid_: "draft release" (that is a GitHub Releases concept).

## Out-of-glossary (do not confuse)

- **DSH `subagent`** (a separate dsh concept: continuable sub-agent with
  capability flags) is NOT the same as the historical `pi-subagents` npm
  package. Neither is in scope here; both surface only via the `agent()`
  helper stub.

- **pi `subagent` extension** (`examples/extensions/subagent/index.ts` in
  `@earendil-works/pi-coding-agent`) is the user-installable extension that
  spawns pi subprocesses. It is a separate object from `pi.dispatch`; the
  latter is implemented inside this package and is _behaviour-compatible_
  with the former but not _cooperative_ (does not require the extension to
  be installed).

**DSH preset / agent-preset** (Standard / PTC / Minimal / Creative) is a
dsh-side concept. pi has no equivalent preset system today; this package
is _only_ the PTC mode implementation, not a preset framework.

**"PTC off" is not "the package is off".** `/ptc off` turns off the
_narrowing mode_ and the _dispatch switch_ (ADR-0050): this session stops
working the PTC way and stops starting new children. It does NOT take the
package out of your sessions — that is its _activation_ (see _default-on_),
and the way to do it is `pi config` or not installing it, after which the tools
are not registered at all. A session with PTC off still has the package
loaded, still answers `/ptc why`, and still runs programs. The confusion this
entry records is not hypothetical: "PTC is off, so these three tools should be
gone too" was a real question about a real session, and the answer was that
those tools were still there because dispatching was still possible — the
switch had not been given that meaning yet (ADR-0050).

**DSH `web_search`** (the `dsh-tool-web` tool) is NOT the same object as this
package's **DeepSeek search module**. DSH's is a dsh-side tool that takes 1–4
merged queries and returns summaries plus source URLs; ours is a
child-only pi tool over DeepSeek's raw Search/Fetch
endpoints, reached only from inside a dispatched child. The names are deliberately
different in both directions — ours is `web_ds_search`, not
`web_search` — because pi's tool registry is keyed by tool name
(`toolRegistry.set(tool.name, tool)`), so two extensions registering the same
name **overwrite each other** rather than coexisting. _Avoid_: "the web_search
tool" unqualified (which one?), and "web search" for ours.
