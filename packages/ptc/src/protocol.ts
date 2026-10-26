// ADR-0017：host↔worker 线协议。两端共用这一份类型，防止漂移
export type HostToWorkerFrame =
  | { kind: "init"; surface: string; bindingNames: string[] }
  | { kind: "run"; id: string; code: string; args: unknown }
  | { kind: "cancel"; id: string; reason: string }
  | { kind: "reset" }
  | { kind: "result"; callId: number; ok: true; value: unknown }
  | { kind: "result"; callId: number; ok: false; error: string };

// images 为结构化图片块（pi ImageContent 形状）；subCalls 为子调用记录（ADR-0021）
export type RunOutcome =
  | {
      status: "fulfilled";
      value: unknown;
      logs: string[];
      images?: unknown[];
      subCalls?: unknown[];
    }
  | { status: "rejected"; error: string; logs: string[]; subCalls?: unknown[] }
  | { status: "canceled"; reason: string; logs: string[]; subCalls?: unknown[] };

export type WorkerToHostFrame =
  | { kind: "ready" }
  | { kind: "log"; runId: string; level: string; text: string }
  | { kind: "call"; runId: string; callId: number; name: string; args: unknown }
  | { kind: "settled"; runId: string; outcome: RunOutcome };
