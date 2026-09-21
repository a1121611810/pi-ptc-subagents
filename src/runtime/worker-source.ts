/**
 * Worker bootstrap assembly.
 *
 * The worker code is composed at spawn time from three parts:
 *
 *   1. a tiny ES-module preamble that imports the Node builtins the surface needs,
 *   2. the protocol tables and limits as a JSON literal,
 *   3. `workerMain.toString()` — the worker runtime itself (`worker-main.ts`).
 *
 * Two Node behaviours this relies on, both verified against v24.18.0:
 * - `new Worker(<data: URL>)` runs the payload as an ES module ("the data is interpreted
 *   based on MIME type using the ECMAScript module loader"). The `type: 'module'` option
 *   is undocumented for `Worker`, and `eval: true` workers are CommonJS, so a data URL is
 *   the documented way to get an ESM worker from an in-memory string.
 * - `Function.prototype.toString()` returns usable source for a function that came
 *   through Node's type stripping (dev/tests) and through rolldown (dist), which is what
 *   lets the bundle stay a single self-contained `dist/index.js` with no second entry
 *   file to publish.
 *
 * Because the composed source is evaluated in a fresh realm, `workerMain` must be
 * self-contained — see the rule at the top of `worker-main.ts`.
 */
import type { WorkerProtocolSpec } from "./protocol.ts";
import { workerMain } from "./worker-main.ts";

/** Build the worker module source for one spawn. */
export function buildWorkerSource(protocol: WorkerProtocolSpec): string {
  const deps = JSON.stringify({ protocol });
  return [
    `import { parentPort, workerData } from "node:worker_threads";`,
    `import { inspect } from "node:util";`,
    `import { stripTypeScriptTypes } from "node:module";`,
    `const ptcDeps = ${deps};`,
    `(${workerMain.toString()})({ ...ptcDeps, parentPort, workerData, inspect, stripTypes: stripTypeScriptTypes });`,
  ].join("\n");
}

/** The worker entry as a `data:` module URL, ready for `new Worker(url, options)`. */
export function buildWorkerUrl(protocol: WorkerProtocolSpec): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(buildWorkerSource(protocol))}`);
}
