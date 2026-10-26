import { parentPort, workerData } from "node:worker_threads";
import { workerMain } from "./worker-main.ts";
import type { HostToWorkerFrame, WorkerToHostFrame } from "./protocol.ts";

if (!parentPort) throw new Error("worker-entry 只能在 worker 线程里加载");

// ADR-0005 F3：env 冻结在 workerData 里，worker 内不再感知宿主环境变化
void Object.freeze(workerData);

workerMain({
  post: (frame: WorkerToHostFrame) => parentPort!.postMessage(frame),
  onFrame: (handler) => parentPort!.on("message", (frame: HostToWorkerFrame) => handler(frame)),
});
