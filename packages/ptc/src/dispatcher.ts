import { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS, effectiveTimeoutMs } from "./limits.ts";
import type { HostToWorkerFrame, RunOutcome, WorkerToHostFrame } from "./protocol.ts";
import type { WorkerPool } from "./pool.ts";
import { SubCallTracker } from "./sub-calls.ts";
import { buildWorkerUrl } from "./worker-source.ts";

export interface BindingContext {
  cwd: string;
  /** 旧 ADR-0014：binding 结果里的图片块经此上提到运行结果，随工具结果挂给模型 */
  emitImage: (image: unknown) => void;
  /** 决策 17：run 级取消信号（timeout/cancel 时触发）——binding 里等排队的任务应据此撤回 */
  signal?: AbortSignal;
}

export type BindingTable = Record<string, (args: unknown, ctx: BindingContext) => Promise<unknown>>;

export interface RunProgramRequest {
  code: string;
  surface?: string;
  cwd?: string;
  timeoutMs?: number;
  /** workflow 的 args：作为程序里的同名全局绑定注入（旧 ADR-0017 只透传 JSON 值） */
  args?: unknown;
  bindings: BindingTable;
  pool?: WorkerPool;
}

// 旧 ADR-0005 F1/F2：环境白名单 + 内存上限——程序以用户身份跑，这些只是降事故面，不是安全边界（旧 ADR-0007）
const WORKER_ENV_ALLOW_LIST = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];

// worker 默认继承 execArgv——宿主若以 -e/--input-type 等启动，原样继承会让 worker 起不来；只剥这几个
const WORKER_EXEC_ARGV_DENY = /^(-e|--eval|-p|--print|--input-type|-)(=|$)/;

function workerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    WORKER_ENV_ALLOW_LIST.filter((key) => key in process.env).map((key) => [
      key,
      process.env[key]!,
    ]),
  );
}

export function spawnPtcWorker(): Worker {
  return new Worker(buildWorkerUrl(import.meta.url), {
    env: workerEnv(),
    execArgv: process.execArgv.filter((arg) => !WORKER_EXEC_ARGV_DENY.test(arg)),
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
  });
}

// 一次程序一个 run：有池则复用 worker（reset 握手清场），没有则 fresh spawn 用完 terminate
export async function runPtcProgram(request: RunProgramRequest): Promise<RunOutcome> {
  const timeoutMs = effectiveTimeoutMs(request.timeoutMs);
  const cwd = request.cwd ?? process.cwd();
  const worker = request.pool ? await request.pool.acquire() : spawnPtcWorker();

  return new Promise<RunOutcome>((resolve) => {
    const runId = crypto.randomUUID();
    const logs: string[] = [];
    const images: unknown[] = [];
    const subCalls = new SubCallTracker();
    let pendingCalls = 0;
    let runningCalls = 0;
    const callQueue: (() => void)[] = [];
    const controllers = new Set<AbortController>();
    let settled = false;
    let waitingReset = false;
    let resetTimer: NodeJS.Timeout | undefined;

    const send = (frame: HostToWorkerFrame) => worker.postMessage(frame);

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callQueue.length = 0; // 取消后排队中的调用不再拉起：副作用不许落后于「已取消」
      for (const abort of controllers) abort.abort();
      const withExtras: RunOutcome = { ...outcome, subCalls: subCalls.snapshot() };
      if (withExtras.status === "fulfilled" && images.length > 0) withExtras.images = images;
      resolve(withExtras);
      if (request.pool) {
        // 归还前先 reset：拒掉残留 pending、清场 globalThis；ready 回来才放回池里
        waitingReset = true;
        resetTimer = setTimeout(() => {
          // 同步死循环的程序不会处理 reset：宽限后杀掉收回名额（否则池永久少一格）
          if (!waitingReset) return;
          waitingReset = false;
          request.pool!.discard(worker);
        }, DEFAULT_LIMITS.graceMs);
        resetTimer.unref();
        send({ kind: "reset" });
      } else {
        void worker.terminate();
      }
    };

    const timer = setTimeout(() => {
      send({ kind: "cancel", id: runId, reason: "timeout" });
      finish({ status: "canceled", reason: `timeout after ${timeoutMs}ms`, logs });
    }, timeoutMs);

    // 池化复用：run 结束摘除自己的三个监听（off 在归还时），旧 run 的迟到帧不再经过死闭包
    const onMessage = (frame: WorkerToHostFrame): void => {
      if (settled && frame.kind !== "ready") return;
      if (frame.kind === "ready") {
        if (waitingReset) {
          waitingReset = false;
          if (resetTimer) clearTimeout(resetTimer);
          // 审计 F8：归还前先摘除本 run 的三个监听——单 turn 内多次复用不再累积闭包
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
          request.pool!.release(worker);
        }
        return;
      }
      // 迟到帧（已取消 run 的残留调用/日志）不记在当前 run 头上
      if (frame.runId !== runId) return;
      if (frame.kind === "log") {
        logs.push(frame.text);
        return;
      }
      if (frame.kind === "call") {
        if (pendingCalls >= DEFAULT_LIMITS.maxPendingCalls) {
          send({
            kind: "result",
            callId: frame.callId,
            ok: false,
            error: `maxPendingCalls ${DEFAULT_LIMITS.maxPendingCalls} reached`,
          });
          return;
        }
        pendingCalls++;
        subCalls.start(frame.callId, frame.name, frame.args);
        const execute = async () => {
          if (settled) return; // 取消后队列里的调用不再执行
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const binding = request.bindings[frame.name];
            if (!binding) {
              subCalls.end(frame.callId, "rejected");
              send({
                kind: "result",
                callId: frame.callId,
                ok: false,
                error: `unknown binding ${frame.name}`,
              });
              return;
            }
            const value = await binding(frame.args, {
              cwd,
              emitImage: (image) => images.push(image),
              signal: controller.signal, // 决策 17：timeout/cancel 时 binding 据此撤回自己的等待
            });
            subCalls.end(frame.callId, "ok");
            send({
              kind: "result",
              callId: frame.callId,
              ok: true,
              value: value === undefined ? null : value,
            });
          } catch (error) {
            subCalls.end(frame.callId, "error");
            send({
              kind: "result",
              callId: frame.callId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            controllers.delete(controller);
            pendingCalls--;
            runningCalls--;
            const next = callQueue.shift();
            if (next) {
              runningCalls++;
              next();
            }
          }
        };
        if (runningCalls < DEFAULT_LIMITS.maxParallelSubCalls) {
          runningCalls++;
          void execute();
        } else {
          callQueue.push(execute);
        }
        return;
      }
      if (frame.kind === "settled") {
        const outcome = frame.outcome;
        const payload = JSON.stringify({
          logs: outcome.logs,
          value: outcome.status === "fulfilled" ? outcome.value : undefined,
        });
        if (payload.length > DEFAULT_LIMITS.maxOutputBytes) {
          finish({
            status: "rejected",
            error: `output exceeds ${DEFAULT_LIMITS.maxOutputBytes} bytes budget`,
            logs,
          });
          return;
        }
        finish(outcome);
      }
    };
    worker.on("message", onMessage);

    const onError = (error: unknown): void =>
      void finish({
        status: "rejected",
        error: `worker error: ${error instanceof Error ? error.message : String(error)}`,
        logs,
      });
    const onExit = (code: number): void => {
      if (!settled)
        finish({ status: "rejected", error: `worker exited early with code ${code}`, logs });
    };
    worker.on("error", onError);
    worker.on("exit", onExit);

    send({
      kind: "init",
      surface: request.surface ?? "run_code",
      bindingNames: Object.keys(request.bindings),
    });
    send({ kind: "run", id: runId, code: request.code, args: request.args ?? {} });
  });
}
