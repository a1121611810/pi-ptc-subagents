import { Type, type Static } from "typebox";
import type { CreateTaskResult } from "@pi-ptc/dispatch";
export type { CreateTaskResult, DispatchResult, TaskHandle, TaskRejection } from "@pi-ptc/dispatch";

// ADR-0006：两扇门共享 pi_task_ 前缀；这是 PTC 门——程序内 binding，不是注册的 pi 工具
export const TASK_BINDING_NAME = "pi_task_ptc";

// HTML 决策 27 / ADR-0008：两扇门共用同一份参数表（原 DISPATCH_PARAMETERS 的职责）
// cwd 预埋过又删除（2026-10-27，审计 F1）：全链无消费者；pi CLI 无 --cwd，spawn cwd 只能改相对路径落点
export const TASK_DOOR_PARAMETERS = Type.Object({
  task: Type.String({ minLength: 1, description: "孩子要干的活" }),
  agent: Type.Optional(Type.String({ description: "已注册的 agent 名字；省略 = 通用孩子" })),
  why: Type.Optional(Type.String({ description: "这一刀为什么切出来（调用方自己的话）" })),
  agentScope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]),
  ),
  model: Type.Optional(Type.String({ description: "覆盖孩子跑的模型" })),
  thinkingLevel: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean({ description: "true = 等这个任务完成再返回结果" })),
  label: Type.Optional(Type.String({ description: "后台任务给人看的标签" })),
  readOnly: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("lenient")])),
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
      });
    },
  };
}
