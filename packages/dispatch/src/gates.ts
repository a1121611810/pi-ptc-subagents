// 闸门（ADR-0041/0050/0065/0016/0039）：闸在铸 id 与建记录之前，被拒不留痕迹。
// 与 engine 的入参同形——entry 的 admissionGates 挂点直接收这组（类型从 sub 导出，entry 不再自定义）
export type DispatchInput = {
  task: string;
  label?: string;
  agent?: string;
  /** ADR-0039：agent 定义的发现范围——层级覆盖语义：project 定义优先于 user；both=两层都搜（默认） */
  agentScope?: "user" | "project" | "both";
  why?: string;
  readOnly?: "strict" | "lenient";
  wait?: boolean;
  /** ADR-0044：覆盖孩子跑的模型 / 思考档位（缺省继承会话模型，agent 定义可钉） */
  model?: string;
  thinkingLevel?: string;
  /** 决策 17：调用方取消信号——只在「还在排队」时生效（uv_cancel：已起 = EBUSY 不动） */
  signal?: AbortSignal;
};

export type TaskRejection = {
  status: "rejected";
  errorMessage: string;
};

export type Gate = (input: DispatchInput) => TaskRejection | null;

export const rejection = (errorMessage: string): TaskRejection => ({
  status: "rejected",
  errorMessage,
});

// ADR-0041：schema 是第一道，这里守绕过 schema 直调内部的缝；写错值的意图是「只读」，绝不 coerce 成无限制
export const readOnlyGate: Gate = (input) =>
  input.readOnly !== undefined && input.readOnly !== "strict" && input.readOnly !== "lenient"
    ? rejection(
        `invalid readOnly value: ${String(input.readOnly)}（可用 strict / lenient，不 coerce）`,
      )
    : null;

// ADR-0050：dispatchEnabled 独立于 mode；off ⇒ 停收新的（在跑的不动）
export const dispatchEnabledGate =
  (isEnabled: () => boolean): Gate =>
  () =>
    isEnabled()
      ? null
      : rejection("dispatch is disabled（/ptc off）：不再收新的派发，在飞任务不受影响");

// ADR-0065：「会话正在结束」是运行时状态位，谓词非值（deps 按值复制会冻住值）
export const sessionEndingGate =
  (isEnding: () => boolean): Gate =>
  () =>
    isEnding() ? rejection("session is ending：这次派发不被接受") : null;

// ADR-0016：递归深度显式有界
export const depthGate =
  (depth: () => number, maxDispatchDepth: number): Gate =>
  () =>
    depth() + 1 > maxDispatchDepth
      ? rejection(`dispatch depth limit reached（max ${maxDispatchDepth}）`)
      : null;

// 闸门 4：给了名字但畸形（空/空白）——没给不是错，那是通用孩子（ADR-0039）
export const agentNameGate: Gate = (input) =>
  input.agent !== undefined && input.agent.trim() === ""
    ? rejection(
        "agent name is empty or whitespace（省略 agent = 通用孩子；给名字必须是已注册的非空名）",
      )
    : null;

export type AgentResolver = (name: string, scope?: "user" | "project" | "both") => boolean;

// 闸门 5：解析不出来立刻拒（入队前 fail fast，不坐进队列再失败）。
// shortcut: 默认 resolver 只认「未定义」——磁盘 agent 发现（~/.pi/agent/agents、<cwd>/.pi/agents）随 spawn 的 argv 工作落地
export const agentResolveGate =
  (resolver: AgentResolver): Gate =>
  (input) =>
    input.agent === undefined || resolver(input.agent)
      ? null
      : rejection(`unknown agent: ${input.agent}（agentScope 目录里没有这个定义）`);
