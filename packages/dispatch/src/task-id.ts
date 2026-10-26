import { randomUUID } from "node:crypto";

// shortcut: 先 randomUUID 顶着；单调 ULID minter（旧实现 ulid.ts 的职责）随事件/通知排序需求落地
export function createTaskId(): string {
  return randomUUID();
}
