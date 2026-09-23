/**
 * Worker entry — loaded by file URL (ADR-0017 §7).
 *
 * The previous bootstrap composed a `data:text/javascript,…` URL from
 * `Function.prototype.toString()` of `workerMain`, which kept the package as a
 * single self-contained file but paid a fresh V8 spin-up + module-graph parse
 * for every worker spawn (no code-cache reuse). After the rolldown dual-entry
 * build emits `dist/worker.js` as a sibling of `dist/index.js`, this file is
 * the target the host loads; V8 and Node's module cache survive across
 * warm-reuse spawns.
 *
 * The protocol tables travel as static imports in both bundles (host imports
 * from `dist/index.js`, worker imports from `dist/worker.js`) — both files
 * bundle `./protocol.ts`, so each side constructs `workerProtocolSpec()`
 * independently and the wire strings stay aligned. This removes the build-time
 * protocol literal the data: URL used to carry.
 *
 * `workerData` is the spawn-time payload `{ env }` — the frozen per-run env
 * snapshot (F3, ADR-0005) — and nothing else. Run identity is *not* spawn-time:
 * a warm worker outlives the run that spawned it, so the host sends each run's
 * `runId` in its own `init` frame instead. `workerMain` reads neither (see its
 * `WorkerMainDeps.workerData` note); `runId` is host-side bookkeeping for
 * attributing frames to a run.
 */
import { parentPort, workerData } from "node:worker_threads";
import { inspect } from "node:util";
import { stripTypeScriptTypes } from "node:module";
import { workerMain } from "./worker-main.ts";
import { workerProtocolSpec } from "./protocol.ts";

workerMain({
  parentPort: parentPort as unknown as Parameters<typeof workerMain>[0]["parentPort"],
  workerData,
  inspect,
  stripTypes: stripTypeScriptTypes,
  protocol: workerProtocolSpec(),
});
