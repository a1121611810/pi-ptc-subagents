import { Type, type Static } from "typebox";
import type { CreateTaskResult, TaskRecord } from "@pi-ptc/dispatch";
import { readTaskOutput, type TaskOutputView } from "@pi-ptc/task";
import { TASK_DOOR_PARAM_DESCRIPTIONS } from "@pi-ptc/routes";
export type { CreateTaskResult, DispatchResult, TaskHandle, TaskRejection } from "@pi-ptc/dispatch";

// ADR-0006：两扇门共享 pi_task_ 前缀；这是 PTC 门——程序内 binding，不是注册的 pi 工具
export const TASK_BINDING_NAME = "pi_task_ptc";

// HTML 决策 27 / ADR-0008：两扇门共用同一份参数表（原 DISPATCH_PARAMETERS 的职责）
// 文案在 routes（模型面散文唯一出处）——这里只做 schema 形状
// cwd 预埋过又删除（2026-10-27，审计 F1）：全链无消费者；pi CLI 无 --cwd，spawn cwd 只能改相对路径落点
export const TASK_DOOR_PARAMETERS = Type.Object({
  task: Type.String({ minLength: 1, description: TASK_DOOR_PARAM_DESCRIPTIONS.task }),
  agent: Type.Optional(Type.String({ description: TASK_DOOR_PARAM_DESCRIPTIONS.agent })),
  why: Type.Optional(Type.String({ description: TASK_DOOR_PARAM_DESCRIPTIONS.why })),
  agentScope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
      description: TASK_DOOR_PARAM_DESCRIPTIONS.agentScope,
    }),
  ),
  model: Type.Optional(Type.String({ description: TASK_DOOR_PARAM_DESCRIPTIONS.model })),
  thinkingLevel: Type.Optional(
    Type.String({ description: TASK_DOOR_PARAM_DESCRIPTIONS.thinkingLevel }),
  ),
  wait: Type.Optional(Type.Boolean({ description: TASK_DOOR_PARAM_DESCRIPTIONS.wait })),
  label: Type.Optional(Type.String({ description: TASK_DOOR_PARAM_DESCRIPTIONS.label })),
  readOnly: Type.Optional(
    Type.Union([Type.Literal("strict"), Type.Literal("lenient")], {
      description: TASK_DOOR_PARAM_DESCRIPTIONS.readOnly,
    }),
  ),
  timeoutMs: Type.Optional(Type.Number({ description: TASK_DOOR_PARAM_DESCRIPTIONS.timeoutMs })),
  projectContext: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("none")], {
      description: TASK_DOOR_PARAM_DESCRIPTIONS.projectContext,
    }),
  ),
});

export interface TaskDoorOptions {
  task?: string;
  label?: string;
  wait?: boolean;
  why?: string;
  model?: string;
  thinkingLevel?: string;
  agent?: string;
  agentScope?: "user" | "project" | "both";
  readOnly?: "strict" | "lenient";
  timeoutMs?: number;
  projectContext?: "auto" | "none";
}

export interface TaskDoor {
  createTask(task: string, options?: TaskDoorOptions): Promise<CreateTaskResult>;
}

export type TaskBindingArgs = Static<typeof TASK_DOOR_PARAMETERS>;

export interface TaskBinding {
  name: typeof TASK_BINDING_NAME;
  parameters: typeof TASK_DOOR_PARAMETERS;
  execute(args: TaskBindingArgs): Promise<CreateTaskResult>;
}

export function createTaskBinding(door: TaskDoor): TaskBinding {
  return {
    name: TASK_BINDING_NAME,
    parameters: TASK_DOOR_PARAMETERS,
    execute(args) {
      const input = (args ?? {}) as TaskBindingArgs; // 程序里传 null/undefined 不该炸，交给 task 闸按拒绝处理
      return door.createTask(input.task, {
        label: input.label,
        wait: input.wait,
        why: input.why,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        agent: input.agent,
        agentScope: input.agentScope,
        readOnly: input.readOnly,
        timeoutMs: input.timeoutMs,
        projectContext: input.projectContext,
      });
    },
  };
}

// 任务面查询（程序内）：机械扫描在宿主做，筛选/归约在程序里做——
// 正则跑在 worker（terminate 兜底），宿主没有隔离；程序返回什么只有什么进上下文。
// 参数形状（scope: recent | all）由宿主侧实现与册子散文约定，程序侧无需 schema。
export const TASK_RECORDS_BINDING_NAME = "task_records";

// 任务产出（程序内）：归约层——孩子的散文正文。与模型面 ptc_task_output 同一套读法
// （readTaskOutput：正文优先，没正文才退回原始尾部 + 分层引导）
export const TASK_OUTPUT_BINDING_NAME = "task_output";

export interface TaskOutputBindingSource {
  registry: { get(taskId: string): TaskRecord | undefined };
  readArchivedRecord(taskId: string): Promise<(TaskRecord & { archived: true }) | undefined>;
  outputSize(taskId: string): Promise<number | undefined>;
  readOutput(taskId: string): Promise<string | undefined>;
  readOutputTail(taskId: string, maxBytes: number): Promise<string | undefined>;
}

// 绑定契约：never throws——查不到给 { error }，与任务面 ptc_task_output 同形
export function createTaskOutputBinding(
  source: TaskOutputBindingSource,
): (args: unknown) => Promise<(TaskOutputView & { status?: string }) | { error: string }> {
  return async (args) => {
    // 模型面工具的参数是 task_id（下划线），程序内习惯驼峰——两种都收
    const raw = args as { taskId?: unknown; task_id?: unknown } | undefined;
    const taskId = raw?.taskId ?? raw?.task_id;
    if (typeof taskId !== "string" || taskId === "") {
      return { error: "taskId 必须是非空字符串" };
    }
    const record = source.registry.get(taskId) ?? (await source.readArchivedRecord(taskId));
    if (!record) return { error: `unknown task id ${taskId}` };
    // status 一起给：还在跑时归约层是空的，程序靠它分辨「没跑完」与「跑完但没交正文」
    return { ...(await readTaskOutput(source, record)), status: record.status };
  };
}
