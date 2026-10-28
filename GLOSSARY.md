# pi-ptc-subagents

pi 的扩展：PTC（模型写 TypeScript 程序批量调工具）+ 子代理派发。本词表只收本项目特有的领域词，定义与 ADR/spec 一致；包结构见 `AGENTS.md`，pi 版本事实见 `docs/pi-version-matrix.md`。

## Language

### 编排

**编排入口**:
这个 pi 会话归哪个编排器管——`full_ptc` 归我们的 PTC 编排器（模型写 TypeScript 程序批量调工具）；`codemode_ptc` 归 pi 自带 codemode（只额外给一件建任务工具）。由 entry 包在 session_start 探测，不是用户开关切出来的。代码标识符与 ADR 中写作 `surface`。
_Avoid_: `full`、`subagents`（改名前的旧值）；「subagent」；「模式」（撞 pi 四模式 / PTC 模式）、单说「入口」（撞 entry 包 / 建任务工具）

**编排器（orchestrator）**:
一个编排入口下对模型负责的那一层：`full_ptc` 是 PTC 对，`codemode_ptc` 是 pi 的 codemode。一个编排入口只有一个编排器。

**codemode**:
pi 内建的「脚本直接调工具」模式；`codemode_ptc` = pi 的 codemode + 脚本内的 `pi_task_codemode`。

**建任务工具（task-creation tool）**:
模型面创建任务用的那一件工具：`pi_task_ptc` / `pi_task_codemode`。两个编排入口各一件，同名同形，换编排入口只换一个名字。
_Avoid_: `pi.dispatch`（旧名）；模型面散文里的「dispatch」；「门」（与闸门两个门意象，已弃）

**wait**:
「等不等」不是两条路，是建任务工具的一个参数（默认 `false` = 不等）。

**binding（绑定）/ 绑定契约（binding contract）**:
PTC 程序内可调用的宿主能力清单；绑定契约回答「调了得到什么形状」——never throws，读 `status`。

**运行格（vm cell）**:
PTC 程序的执行环境：每 run 新建一个 `vm.createContext`，格内全局只有注入绑定（`tools`/`args`/`console`，workflow 面另有 `workflow` 四辅助）+ JS 标准内置；`process`/`fetch`/动态 `import()`/`node:*` 不可见。程序唯一的门 = `tools.*`（决策 30，ADR-0019）。reset = 丢格。降事故面，不是安全边界。
_Avoid_: 单说「沙箱」（与 minimax QuickJS、OS 级沙箱混淆）

### 任务引擎

**任务（task）/ 任务记录（task record）**:
每次派发先建一条记录（前台也建），registry 是派发的唯一痕迹。
_Avoid_: 「前台任务/后台任务」两种说法（ADR-0013 §6 退役）——任务就是任务，等不等是一个参数。

**registry**:
任务状态的唯一持有者与落盘处（`records/` + `tasks/`），重启恢复。dispatch 包持它，其余包只是调用方。

**闸门（gate）**:
派发前的准入检查点。拒绝是「闸门说不行」：`status: "rejected"` + `errorMessage`，不抛异常。

**准入（admission）/ 排队**:
满了不拒绝，FIFO 排队等；入队即建记录（`queued`），所以队列可观测、可取消。

**槽（slot）/ DispatchSlotCounter**:
同时能跑的孩子数上限。槽只被「跑起来的孩子」占，排队的等槽。与册子的「槽位」不是一个东西。

**取消（cancellation）**:
只对排队中的任务生效（抽掉）；已起的等价 `UV_EBUSY`，走 SIGTERM 阶梯。

**任务面（lifecycle face）**:
`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`。可见性 = 有任务记录就可见，不是独立开关。

**截断（truncation）**:
`/ptc off` 的语义：入口撤掉自己子项目能控制的那一段装配（`full_ptc` 撤编排层；`codemode_ptc` 撤 `pi_task_codemode` 并重注册 `hidden`）。在跑的不受影响，已完成的痕迹不删。

**任务痕迹（task trace）**:
终态任务记录的热存。保留最近 500 条（`taskTraceKeep` 可配），超出按 `(finishedAt, taskId)` 最老先出；未终态记录永不驱逐。
_Avoid_: 以创建时间 / 插入序作驱逐键

**归档（archive）**:
运行时驱逐的落点：`record` + 产出 gzip 进 `archive/`，TTL 30 天自归档时刻起，读者按精确 id 回落；boot 时的历史债务不进归档，直接删。

### 模型面散文

**route registry（册子）**:
全部模型面散文的唯一出处（routes 包），`TOOLS`（一工具一条）+ `ROUTES`（一条路一行）两区。工具的描述/指南/片段必须是册子的渲染，工具文件里不许出现这些字面量。

**路（route）**:
模型可走的一条路；`ROUTES` 区一行一条：什么时候走、各面上怎么调、事实、详情文件指针。

**常驻索引 / detail 指针**:
路由表两层之一：常驻 context 的索引每条路一行；详情永远在随包发布的 `docs/routes/` 文件里，索引只持指针。

**散文（prose）**:
模型面对话里的文字（工具描述、通知文案、引导语）。规矩：一律进册子，工具/引擎文件不许有字面量。

**槽位（slot，册子里的）**:
册子描述段落里的占位：绑定契约段落、会话自己的话（动态事实）。与并发「槽」无关。

**强制点（机械强制）**:
册子的结构守卫——八条机械测试（工具↔行双向覆盖、token 预算、每 turn 字节相同等）+ 一条散文/形状边界的约定。复制散文会红。

**渲染边界（render bounds）**:
tui 包的截断契约与渲染预算：任何渲染路径不超预算，超了明说（`> WARNING:`）不静默截断。

### 验证与工程

**干净室（clean room）**:
重写纪律：只按 ADR / spec / 研究文档写，不抄旧分支（`main` 等）的实现源码。

**探针（probe）**:
`node` 直打 `packages/*/dist/index.js` 的验证（假 spawn / fake pi harness）；引擎类逻辑必须探针覆盖。

**真 pi 冒烟（smoke）**:
`pi -ne -e <entry/dist/index.js>` 的隔离实测——不加 `-ne` 会与全局旧版互踩。

**floor**:
兼容的最低 pi 版本（0.86.0）。
