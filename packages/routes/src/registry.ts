import type { SurfaceMode } from "./surface.ts";

// ADR-0013/0061：模型面散文唯一出处。散文只在本文件出现——工具文件里不许有描述字面量（机械点 6）
// 渲染确定性（决策 25，prompt cache）：输入 = 册子 + surface + 详情目录 + 总则句开关
// 总则句随 PTC 模式开关变（会话中途改系统提示词会废掉提示词缓存）——代价记在 ADR-0015

export type ToolName =
  | "ptc_run_code"
  | "ptc_workflow"
  | "pi_task_codemode"
  | "ptc_task_list"
  | "ptc_task_output"
  | "ptc_task_stop";

export interface ToolEntry {
  name: ToolName;
  /** description 按 surface 参数化——同一句話一个函数，两个面不会分叉 */
  description: (surface: SurfaceMode) => string;
}

export const TOOLS = {
  ptc_run_code: {
    name: "ptc_run_code",
    description: (s) =>
      [
        "写一段 TypeScript 程序批量调用工具：tools.<name>(args)。支持顶层 await、Promise.all 并行、循环与条件；程序返回值是归约后的结果，中间产物不进上下文。",
        s === "codemode_ptc"
          ? "本会话里我从 codemode 脚本可达，模型直走 codemode。"
          : [
              "什么时候写程序而不是逐个调工具，看系统提示词 <ptc> 节的路由表。",
              // 实测（2026-10-30 分档 A/B）：模型因「不确定程序内工具的参数形状」放弃写程序——
              // thinking 原话「It supports tools.<name>(args) presumably … risk of format differences」，
              // 宽题 0/3、窄题 0/2 轮调用 ptc_run_code；对照 pi 自带 codemode 给每个工具完整
              // inputSchema+outputSchema，模型 5/6 轮主动用。故这里把「参数与同名 pi 工具一致」
              // +「返回文本、失败抛异常」写明——不硬编码字段名（pi 的 edit 是 edits[] 数组，
              // 硬编码必错），让模型复用它已经见过的同名工具声明。
              "程序内可调本会话已启用的同名工具（read / write / edit / grep / find / ls；bash 默认不可用），参数与直接调用该工具完全一致；每次调用返回 Promise，要 await，返回文本结果，失败抛异常。",
              '例：const files = await tools.find({ pattern: "*.py" }); for (const f of files) await tools.write({ path: f, content: body });',
            ].join(""),
      ].join(""),
  },
  ptc_workflow: {
    name: "ptc_workflow",
    description: (s) =>
      [
        "结构化的多阶段程序：script 里可用 workflow.log / workflow.phase / workflow.parallel / workflow.pipeline。适合阶段明确的批处理。",
        s === "codemode_ptc"
          ? "本会话里我从 codemode 脚本可达。"
          : "与 ptc_run_code 的取舍看 <ptc> 节的路由表。",
      ].join(""),
  },
  pi_task_codemode: {
    name: "pi_task_codemode",
    description: () =>
      "建一条子代理任务，默认立刻返回 handle（taskId + label）；wait:true 时阻塞到终态再返回结果。任务在任务记录里排队，由派发引擎起独立 pi 进程执行；完成后的报告与产出经 ptc_task_output 读取。",
  },
  ptc_task_list: {
    name: "ptc_task_list",
    description: () => "列出在飞的任务与最近完成的任务（最近 10 条已完成）。",
  },
  ptc_task_output: {
    name: "ptc_task_output",
    description: () =>
      "按 task_id 读一条任务记录：状态、报告、产出。产出超过截断阈值时给尾部与完整产出位置（outputPath）。",
  },
  ptc_task_stop: {
    name: "ptc_task_stop",
    description: () => "按 task_id 叫停任务：排队中的直接抽掉（canceled），在跑的转 stopping。",
  },
} as Record<ToolName, ToolEntry>;

// 派发参数说明（ADR-0008：两扇门共用一份参数表）——文案住本册子，ptc 的 schema 从这里取
// 每个参数都写清代价：宿主不写死默认，用不用由模型自己判断
export const TASK_DOOR_PARAM_DESCRIPTIONS = {
  task: "孩子要干的活",
  agent: "已注册的 agent 名字；省略 = 通用孩子",
  agentScope: "agent 定义的查找范围（user / project / both）",
  why: "这一刀为什么切出来（调用方自己的话）——它会进孩子的提示词、多花孩子的 token；孩子从 task 里已经能读懂就别传",
  model: "覆盖孩子跑的模型",
  thinkingLevel: "覆盖孩子的思考档位——孩子的思考 token 是可调的成本项",
  wait: "true = 等这个任务完成再返回结果；false = 立刻返回 handle，结果走任务面/通知",
  label: "后台任务给人看的标签",
  readOnly:
    "strict = 孩子只有读工具（read/grep/find/ls，搜索开启时含 web_ds_search）；lenient = 默认全工具。只需要读的活别给写权限",
  timeoutMs: "孩子的运行时长上限（毫秒）——超了按超时收尸；不传 = 不限（与不传时同）",
  projectContext:
    "孩子的项目上下文（AGENTS.md/CLAUDE.md）：auto = 照常加载；none = 不加载——注意 none 只关「注入」不关「知识」：文件还在工作目录里，孩子会自己去翻（实测输入只差约 15%，不是省一半）；这活不需要项目约定就传 none，要孩子遵守项目规矩就照常传（auto 也可能把项目里的写码规矩套进答案）",
} as const;

// Kimi 面（MCP，ADR-0018）：ptc_run_code 的宿主中立形态。散文仍住本册子——
// 门禁（双向覆盖/token 预算）扩展随 P2 落地，本块由 tests/kimi 的协议探针守存在性
export const KIMI_MCP_RUN_CODE = {
  name: "ptc_run_code",
  description: () =>
    [
      "写一段 TypeScript 程序批量调用工具：tools.<name>(args)。支持顶层 await、Promise.all 并行、循环与条件；程序返回值是归约后的结果，中间产物不进上下文。",
      "同一形态的读写预计重复 5 次以上时，写程序一次跑完比逐个调更省。",
      "本会话的 tools 是固定文件四件套：read / grep / glob / edit（只作用于 workdir 之内，越界即报错）；没有 bash，也没有 pi_task_ptc——要跑 shell 或派子代理，用宿主自己的工具。",
    ].join(""),
  inputSchemaDescriptions: {
    code: "要执行的 TypeScript 程序体，可用顶层 await 和 return",
    description: "这段程序要干什么（给人看的一行）",
    workdir: "程序读写文件的根目录（绝对路径）；四件套只能在这个目录内活动",
    timeoutMs: "覆盖默认 2 分钟超时（毫秒，可选）",
  },
} as const;

// Kimi 面第二件工具（P2 过河）：程序内联网搜索。搜索核宿主中立，散文仍只住本册子
export const KIMI_MCP_WEB_DS_SEARCH = {
  name: "web_ds_search",
  description: () =>
    [
      "联网搜索三动作：search 概览（title/url/snippet，count 1–50 默认 10）· open 抓整页转 markdown · find 页内行匹配（正则）。单次搜索可直调本工具；要批量取证再写进 ptc_run_code 程序。",
      "配额按 MCP server 进程计（默认 30 次/进程，0 = 不限）——不是跨会话的全局限额；open/find 命中本会话记忆不重复消耗。",
    ].join(""),
  inputSchemaDescriptions: {
    action: "三动作之一：search（搜索）/ open（抓整页）/ find（页内行匹配）",
    query: "search 的搜索词",
    url: "open/find 的目标页面 url",
    pattern: "find 的页内行匹配正则",
    count: "search 条数 1–50，默认 10",
  },
} as const;

// Kimi 面结果页脚（P2 经济学）：程序成功且确有工具调用时拼在结果尾部——
// 每次「该用而被用」都回一行正强化，纯计算（0 调用）不拼
export const KIMI_MCP_RESULT_FOOTER = (calls: number): string =>
  `程序内 ${calls} 次工具调用，归约成这 1 次结果（逐个调要走 ${calls} 轮）。`;

// Kimi 面工具表：server 从这张表循环出 tools/list——模型可见工具的唯一出处
export const KIMI_MCP_TOOLS = {
  ptc_run_code: KIMI_MCP_RUN_CODE,
  web_ds_search: KIMI_MCP_WEB_DS_SEARCH,
} as const;

export interface RouteEntry {
  id: string;
  name: string;
  when: string;
  /** 每个 surface 怎么走；「这一面不适用」也是答案（机械点 3：不留空洞） */
  how: Record<SurfaceMode, string>;
  fact: string;
  /** 包内相对路径，必须真实存在（机械点 7） */
  detail: string;
}

// 交付核对（父面）：孩子**实际**干了什么（引擎从事件流抽）vs 它**声称**交了什么（模型自述）
// 散文住本册子（ADR-0013）——父面拿到的每一句引导语都从这里出
export interface DeliveryFacts {
  tools: Record<string, number>;
  paths: string[];
  errors: number;
  textChars: number;
}

export const DELIVERY_CHECK_LEAD = "交付核对（引擎实测）";
export const DELIVERY_CHECK_NOTHING = "这孩子的结论没有依据：重派它，或明说缺口，别替它补数。";

/** 父面渲染一行交付核对：工具/路径（实测）· 报错 · 正文长度 · 报告条数（自述） */
export function renderDeliveryCheck(input: {
  delivery?: DeliveryFacts;
  findings?: number;
  channel?: string;
}): string {
  const d = input.delivery;
  if (!d) return "";
  const calls = Object.entries(d.tools);
  const totalCalls = calls.reduce((sum, [, count]) => sum + count, 0);
  const parts: string[] = [];
  if (calls.length > 0) {
    const tools = calls.map(([name, count]) => `${name}×${count}`).join(" ");
    const paths =
      d.paths.length > 0
        ? `（${d.paths.slice(0, 5).join("、")}${d.paths.length > 5 ? ` 等 ${d.paths.length} 条` : ""}）`
        : "";
    parts.push(`工具 ${tools}${paths}`);
  } else {
    parts.push("没调用任何工具");
  }
  parts.push(`报错 ${d.errors}`);
  parts.push(`正文 ${d.textChars} 字`);
  const findings = input.findings ?? 0;
  parts.push(`报告 ${findings} 条（${input.channel ?? "none"}）`);
  const nothing = totalCalls === 0 && findings === 0 && d.textChars === 0;
  return nothing
    ? `${DELIVERY_CHECK_LEAD}：零产出——${parts.join(" · ")}。${DELIVERY_CHECK_NOTHING}`
    : `${DELIVERY_CHECK_LEAD}：${parts.join(" · ")}`;
}

// 路由集完整性（机械点 3）已全量：7 条路在每个 surface 都有交代
export const ROUTES = [
  {
    id: "create-a-task",
    name: "派一个子代理",
    when: "材料多、主题互不相干、每份都要读一堆材料时派——父一个人扛会算错（实测 92%→100%，n=3）；成本 10 倍上下，一件能算完的活别派",
    how: {
      full_ptc:
        "tools.pi_task_ptc({ task, label? })（程序内）——task 是孩子的唯一规格（写死路径/命令/交付物格式）；要报告就点名 child report 的 JSON 块（summary/findings），别自创报告格式；汇总前核对孩子产出（delivery），零产出就重派别补数",
      codemode_ptc:
        "tools.pi_task_codemode({ task, label? })（脚本内）——task 是孩子的唯一规格（写死路径/命令/交付物格式）；要报告就点名 child report 的 JSON 块（summary/findings），别自创报告格式；汇总前核对孩子产出（delivery），零产出就重派别补数",
    },
    fact: "默认不等，立刻返回 handle；任务在任务记录里排队，可经任务面三工具查/停",
    detail: "docs/routes/create-a-task.md",
  },
  {
    id: "run-one-program",
    name: "批量调工具的一段程序",
    when: "连续多次工具调用、结果要过滤/归约后再看",
    how: {
      full_ptc: "ptc_run_code({ code, description })",
      codemode_ptc:
        "不适用——写程序是 full_ptc 面的编排能力；本面用 codemode 编排、pi_task_codemode 派任务",
    },
    fact: "程序内 tools.*；bash 当前不在程序绑定表里（旧 ADR-0040 的 opt-in 尚未接线）；只在本面（full_ptc）注册 PTC 工具",
    detail: "docs/routes/run-one-program.md",
  },
  {
    id: "run-a-phased-workflow",
    name: "分阶段 workflow",
    when: "批处理有明确阶段，要阶段性可见进度",
    how: {
      full_ptc: "ptc_workflow({ meta, script, args? })",
      codemode_ptc: "不适用——同 run-one-program：workflow 是 full_ptc 的编排能力",
    },
    fact: "script 内可用 workflow.log/phase/parallel/pipeline；只在本面注册",
    detail: "docs/routes/run-a-phased-workflow.md",
  },
  {
    id: "use-the-built-in-tools",
    name: "直接用内置工具",
    when: "单次调用就够，或每步都要模型判断（写操作、审批敏感）",
    how: {
      full_ptc: "程序内 tools.read/grep/find/ls/edit/write；逐个直调走 pi 自己的工具",
      codemode_ptc: "脚本内 tools.<内置名> 直接调",
    },
    fact: "bash 当前不在程序绑定表里（旧 ADR-0040 的 opt-in 尚未接线）",
    detail: "docs/routes/use-the-built-in-tools.md",
  },
  {
    id: "report-what-you-did",
    name: "交报告",
    when: "子代理收工：结论要有证据、副作用与用量要可核对",
    how: {
      full_ptc:
        "孩子的契约：最终消息末尾 fenced JSON（summary/findings/files_touched/usage）；宿主自动解析",
      codemode_ptc: "同左——契约在孩子的追加提示词里，与 surface 无关",
    },
    fact: "reportChannel 恒在四值：tool/prompt-json/none/opted-out；工具通道（ptc_child_report）已是首选",
    detail: "docs/routes/report-what-you-did.md",
  },
  {
    id: "reach-the-web",
    name: "上网查资料",
    when: "需要网页搜索、抓页面、页内找内容——判断力在干活的子代理侧",
    how: {
      full_ptc: "派子代理（pi_task_ptc），孩子用 web_ds_search（search/open/find 三动作）",
      codemode_ptc: "同左——搜索只在子代理进程里注册，父会话没有这个工具",
    },
    fact: "webDsSearch 开关默认关（fail-closed）；配额每进程计；概览走 snippet 超预算整条丢弃",
    detail: "docs/routes/reach-the-web.md",
  },
  {
    id: "manage-a-task",
    name: "管一个任务",
    when: "要知道孩子跑得怎样、读它的产出、或叫停它",
    how: {
      full_ptc:
        "ptc_task_list / ptc_task_output / ptc_task_stop（模型直调）——产出里的 delivery 是引擎实测轨迹",
      codemode_ptc: "同左（模型直调；脚本经结构化返回）——产出里的 delivery 是引擎实测轨迹",
    },
    fact: "有任务记录这三个工具才出现在模型面前（ADR-0007）",
    detail: "docs/routes/manage-a-task.md",
  },
] satisfies RouteEntry[];

// 超长产出的分层引导（ptc_task_output）：报告是归约层（旧 ADR-0032 本意），响应里的 output 是尾部原始层
export const LONG_OUTPUT_GUIDANCE_WITH_REPORT =
  "产出超过截断阈值（{bytes} 字节）。先看孩子的报告（归约层）：{report}——响应里的 output 是截断后的尾部；报告没收录的完整原文用 read 读记录上的 outputPath。";
export const LONG_OUTPUT_GUIDANCE_NO_REPORT =
  "产出超过截断阈值（{bytes} 字节），且孩子未交报告（reportChannel=none，散文可信度存疑）。响应里的 output 是截断后的尾部；完整原文用 read 读记录上的 outputPath。";

export function renderLongOutputGuidance(options: {
  bytes: number;
  report?: { summary: string; findings?: Array<{ what: string; evidence?: string }> };
  reportChannel?: string;
}): string {
  if (options.report && options.reportChannel && options.reportChannel !== "none") {
    const findings = (options.report.findings ?? [])
      .slice(0, 5)
      .map((f) => `- ${f.what}${f.evidence ? `（证据：${f.evidence}）` : ""}`)
      .join("\n");
    return LONG_OUTPUT_GUIDANCE_WITH_REPORT.replace("{bytes}", String(options.bytes)).replace(
      "{report}",
      [`summary: ${options.report.summary}`, findings].filter(Boolean).join("\n"),
    );
  }
  return LONG_OUTPUT_GUIDANCE_NO_REPORT.replace("{bytes}", String(options.bytes));
}

// 旧 ADR-0022：后台任务通知的批渲染——模型面文案归本册子（结构化参数：routes 保持叶子，不依赖 dispatch）
export function renderTaskNotifications(
  batch: ReadonlyArray<{ taskId: string; label?: string; status: string; stopReason?: string }>,
): string {
  const lines = batch.map(
    (n) =>
      `- task ${n.taskId}${n.label ? ` (${n.label})` : ""}: ${n.status}${n.stopReason ? ` — ${n.stopReason}` : ""}`,
  );
  return ["<bg-task-notifications>", ...lines, "</bg-task-notifications>"].join("\n");
}

// ADR-0015：索引 token 预算；超了明说（> WARNING:），不静默截断
export const ROUTE_INDEX_TOKEN_CEILING = 560;

// 启发式估 token（中英混排按 2 字符/token）；旧实现同款思路
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

// 总则句（旧 ADR-0010 的「引导」一半：先给地图再收枪）——按面切换，随索引一起渲染
const ROUTE_INDEX_LEAD: Record<SurfaceMode, string> = {
  full_ptc:
    "批量调工具默认先写程序（ptc_run_code）；单次调用或要逐步判断、审批敏感的才直连。派不派子代理自己判断——路由表第一行写了代价。",
  codemode_ptc:
    "编排写 codemode 脚本；批量派活经脚本内的 pi_task_codemode；要查/停任务用任务面三工具。派不派自己判断——路由表第一行写了代价。",
};

export function renderRouteIndex(surface: SurfaceMode, detailBase?: string, nudge = true): string {
  const lines = ROUTES.map(
    (route) =>
      `- ${route.name} — ${route.when}。这面怎么走：${route.how[surface]}。细节：${
        // 详情目录在索引里只给一次，每行只留文件名——每行再贴一遍绝对路径会把索引顶出 token 预算
        detailBase ? route.detail.split("/").pop()! : route.detail
      }`,
  );
  let index = [
    `<ptc>`,
    ...(nudge ? [ROUTE_INDEX_LEAD[surface]] : []),
    // detailBase = 扩展安装位置下的详情目录；模型把目录与文件名拼起来读（绝对路径只出现一次）
    ...(detailBase ? [`详情目录：${detailBase}`] : []),
    "路由表（一条一行，详情按需 read）：",
    ...lines,
    `</ptc>`,
  ].join("\n");
  const tokens = estimateTokens(index);
  if (tokens > ROUTE_INDEX_TOKEN_CEILING) {
    index += `\n> WARNING: index over token budget (${tokens} > ${ROUTE_INDEX_TOKEN_CEILING}); move detail into docs/routes/*.md`;
  }
  return index;
}
