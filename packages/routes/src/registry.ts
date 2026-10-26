import type { SurfaceMode } from "./surface.ts";

// ADR-0059/0061：模型面散文唯一出处。散文只在本文件出现——工具文件里不许有描述字面量（机械点 6）
// 渲染确定性（决策 25，prompt cache）：输入只有静态册子 + surface，两次渲染逐字节相同

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
          : "什么时候写程序而不是逐个调工具，看系统提示词 <ptc> 节的路由表。",
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

// 路由集完整性（机械点 3）已全量：7 条路在每个 surface 都有交代
export const ROUTES = [
  {
    id: "create-a-task",
    name: "派一个子代理",
    when: "这件事需要它自己的上下文，或者要跟别的活并行",
    how: {
      full_ptc: "tools.pi_task_ptc({ task, label? })（程序内）",
      codemode_ptc: "tools.pi_task_codemode({ task, label? })（脚本内）",
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
    fact: "程序内 tools.*；bash 当前不在程序绑定表里（ADR-0040 的 opt-in 尚未接线）；只在本面（full_ptc）注册 PTC 工具",
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
    fact: "bash 当前不在程序绑定表里（ADR-0040 的 opt-in 尚未接线）",
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
      full_ptc: "ptc_task_list / ptc_task_output / ptc_task_stop（模型直调）",
      codemode_ptc: "同左（模型直调；脚本经结构化返回）",
    },
    fact: "有任务记录这三个工具才出现在模型面前（ADR-0053）",
    detail: "docs/routes/manage-a-task.md",
  },
] satisfies RouteEntry[];

// 超长产出的分层引导（ptc_task_output）：报告是归约层（ADR-0032 本意），响应里的 output 是尾部原始层
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

// ADR-0022：后台任务通知的批渲染——模型面文案归本册子（结构化参数：routes 保持叶子，不依赖 dispatch）
export function renderTaskNotifications(
  batch: ReadonlyArray<{ taskId: string; label?: string; status: string; stopReason?: string }>,
): string {
  const lines = batch.map(
    (n) =>
      `- task ${n.taskId}${n.label ? ` (${n.label})` : ""}: ${n.status}${n.stopReason ? ` — ${n.stopReason}` : ""}`,
  );
  return ["<bg-task-notifications>", ...lines, "</bg-task-notifications>"].join("\n");
}

// ADR-0061：索引 token 预算；超了明说（> WARNING:），不静默截断
export const ROUTE_INDEX_TOKEN_CEILING = 560;

// 启发式估 token（中英混排按 2 字符/token）；旧实现同款思路
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

// 总则句（ADR-0010 的「引导」一半：先给地图再收枪）——按面切换，随索引一起渲染
const ROUTE_INDEX_LEAD: Record<SurfaceMode, string> = {
  full_ptc: "批量调工具默认先写程序（ptc_run_code）；单次调用或要逐步判断、审批敏感的才直连。",
  codemode_ptc:
    "编排写 codemode 脚本；批量派活经脚本内的 pi_task_codemode；要查/停任务用任务面三工具。",
};

export function renderRouteIndex(surface: SurfaceMode): string {
  const lines = ROUTES.map(
    (route) =>
      `- ${route.name} — ${route.when}。这面怎么走：${route.how[surface]}。细节：${route.detail}`,
  );
  let index = [
    `<ptc>`,
    ROUTE_INDEX_LEAD[surface],
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
