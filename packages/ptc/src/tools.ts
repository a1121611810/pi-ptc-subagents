import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { TOOLS, type SurfaceMode } from "@pi-ptc/routes";
import { runPtcProgram, type BindingTable } from "./dispatcher.ts";
import { renderToolResult } from "./result-text.ts";
import { renderPtcResult, type PtcToolDetails } from "./render.ts";

export interface PtcToolOptions {
  getBindings: () => BindingTable;
  cwd?: string;
  surface?: SurfaceMode;
  getPool?: () => import("./pool.ts").WorkerPool | undefined;
  /** pi 把工具执行上下文交给 execute 的第 5 个参数——程序内 tools.* 的通道在那里（ctx.executeTool） */
  onToolContext?: (ctx: ExtensionToolContext) => void;
}

const RUN_CODE_PARAMETERS = Type.Object({
  code: Type.String({ description: "要执行的 TypeScript 程序体，可用顶层 await 和 return" }),
  description: Type.String({ description: "这段程序要干什么（给人看的一行）" }),
  timeoutMs: Type.Optional(Type.Number({ description: "覆盖默认 2 分钟超时" })),
});

export type RunCodeParams = Static<typeof RUN_CODE_PARAMETERS>;

// ptc_run_code（旧 ADR-0010 门面）：execute 全部委托 runPtcProgram，模型面文本走 旧 ADR-0012/0015
export function createPtcRunCodeTool(options: PtcToolOptions) {
  return {
    name: "ptc_run_code",
    label: "运行程序",
    description: TOOLS.ptc_run_code.description(options.surface ?? "full_ptc"),
    parameters: RUN_CODE_PARAMETERS,
    renderResult: renderPtcResult("run_code"),
    execute: async (
      _id: string,
      args: RunCodeParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<PtcToolDetails>> => {
      options.onToolContext?.(ctx);
      const outcome = await runPtcProgram({
        code: args.code,
        surface: "run_code",
        cwd: options.cwd,
        timeoutMs: args.timeoutMs,
        bindings: options.getBindings(),
        pool: options.getPool?.(),
      });
      const { text, truncated, fullOutputPath } = renderToolResult(outcome);
      // 旧 ADR-0014：程序内产出的图片块跟在文本结果之后挂给模型（失败/取消的运行不挂）
      const imageBlocks = (outcome.status === "fulfilled"
        ? (outcome.images ?? [])
        : []) as unknown as AgentToolResult["content"];
      return {
        content: [{ type: "text" as const, text }, ...imageBlocks],
        details: fullOutputPath
          ? { status: outcome.status, truncated, fullOutputPath }
          : { status: outcome.status, truncated },
        isError: outcome.status !== "fulfilled",
      };
    },
  };
}

const WORKFLOW_PARAMETERS = Type.Object({
  meta: Type.Object({
    name: Type.String(),
    description: Type.String(),
    phases: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
  }),
  script: Type.String({
    description: "workflow 程序体，额外可用 workflow.log/phase/parallel/pipeline",
  }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  timeoutMs: Type.Optional(Type.Number()),
});

export type WorkflowParams = Static<typeof WORKFLOW_PARAMETERS>;

export function createPtcWorkflowTool(options: PtcToolOptions) {
  return {
    name: "ptc_workflow",
    label: "跑 workflow",
    description: TOOLS.ptc_workflow.description(options.surface ?? "full_ptc"),
    parameters: WORKFLOW_PARAMETERS,
    renderResult: renderPtcResult("workflow"),
    execute: async (
      _id: string,
      params: WorkflowParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<PtcToolDetails>> => {
      options.onToolContext?.(ctx);
      try {
        validateWorkflowArgs(params.args);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { status: "rejected" },
          isError: true,
        };
      }
      const outcome = await runPtcProgram({
        code: params.script,
        surface: "workflow",
        cwd: options.cwd,
        timeoutMs: params.timeoutMs,
        args: params.args ?? {},
        bindings: options.getBindings(),
        pool: options.getPool?.(),
      });
      const { text, truncated, fullOutputPath } = renderToolResult(outcome);
      // 旧 ADR-0014：程序内产出的图片块跟在文本结果之后挂给模型（失败/取消的运行不挂）
      const imageBlocks = (outcome.status === "fulfilled"
        ? (outcome.images ?? [])
        : []) as unknown as AgentToolResult["content"];
      return {
        content: [{ type: "text" as const, text }, ...imageBlocks],
        details: {
          status: outcome.status,
          truncated,
          ...(fullOutputPath ? { fullOutputPath } : {}),
          meta: params.meta,
        },
        isError: outcome.status !== "fulfilled",
      };
    },
  };
}

// args 必须可 JSON 序列化（跨边界进 worker 的唯一安全形态）
export function validateWorkflowArgs(args: unknown): void {
  if (args === undefined) return;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) throw new Error("args 不可序列化");
    JSON.parse(json);
  } catch (error) {
    throw new Error(
      `workflow args 必须是 JSON 值：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
