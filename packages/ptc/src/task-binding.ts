import { Type, type Static } from "typebox";
import type { CreateTaskResult } from "@pi-ptc/dispatch";
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
