import type { ChildDelivery } from "./task-record.ts";

// 程序型子代理（issue #293）：子进程 = ptc CLI，stdout 只有一个 JSON 信封（RunOutcome 形状）。
// dispatch 是叶子包不能 import ptc——信封只做结构校验，形状对齐 packages/ptc 的 RunOutcome。

export type ProgramEnvelope =
  | { status: "fulfilled"; value: unknown; logs: string[]; subCalls?: unknown[] }
  | { status: "rejected"; error: string; logs: string[]; subCalls?: unknown[] }
  | { status: "canceled"; reason: string; logs: string[]; subCalls?: unknown[] };

// CLI 的 stdout 只打信封：整段 parse。截断/脏输出在这里显式失败，下游按 rejected 收
export function parseProgramEnvelope(text: string): ProgramEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`program envelope 不是合法 JSON（产出被截断或孩子不是 ptc CLI？）`);
  }
  const env = parsed as ProgramEnvelope;
  if (
    !env ||
    typeof env !== "object" ||
    (env.status !== "fulfilled" && env.status !== "rejected" && env.status !== "canceled") ||
    !Array.isArray(env.logs)
  ) {
    throw new Error("program envelope 缺 status/logs——孩子输出不是 ptc CLI 的 --json 形状");
  }
  return env;
}

interface SubCallLike {
  name?: unknown;
  args?: unknown;
  status?: unknown;
}

// delivery 从信封 subCalls 推导：比 pi 事件流反推更准（程序五件套的调用是引擎自己记的）
export function deliveryFromSubCalls(subCalls: unknown): ChildDelivery {
  const list = Array.isArray(subCalls) ? (subCalls as SubCallLike[]) : [];
  const tools: Record<string, number> = {};
  const paths: string[] = [];
  let errors = 0;
  for (const call of list) {
    if (typeof call?.name !== "string") continue;
    tools[call.name] = (tools[call.name] ?? 0) + 1;
    if (call.status !== "ok") errors++;
    // 路径从结构化 args.path 收（与 jsonl.ts 的 MAX_PATHS 同一上限语义）
    const path = (call.args as { path?: unknown })?.path;
    if (typeof path === "string" && path && !paths.includes(path) && paths.length < 20) {
      paths.push(path);
    }
  }
  return { tools, paths, errors, textChars: 0 }; // textChars 由引擎用返回值现算后补
}
