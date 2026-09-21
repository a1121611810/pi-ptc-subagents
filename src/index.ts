/**
 * pi-ptc-subagents — DSH PTC mode (Programmable Tool Calling) for pi.
 *
 * This module is the extension entrypoint pi loads (`package.json` → `pi.extensions`).
 * The PTC machinery it exposes is complete and tested (T3): wire protocol, dispatcher,
 * bindings and the two worker surfaces. The two model-facing tools are registered by the
 * follow-up tickets:
 *
 *   - `ptc_run_code` — bindings + Node + `console.log`, program's return value is the result
 *   - `ptc_workflow` — the same plus `log` / `phase` / `parallel` / `pipeline` and `args`
 *
 * There is no `agent()` helper on either surface (G1 #13 → decision B): calling it produces
 * a plain `ReferenceError` through the normal code-run error path.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { BUILTIN_BINDING_NAMES, createBuiltinBindings, DEFAULT_BINDING_NAMES } from "./runtime/bindings.ts";
export type { Binding, BindingContext, BindingTable, CreateBuiltinBindingsOptions } from "./runtime/bindings.ts";
export { runPtcProgram } from "./runtime/dispatcher.ts";
export type { PtcRunOutcome, RunPtcProgramOptions } from "./runtime/dispatcher.ts";
export { createWorkerEnv, DEFAULT_CONFIG, effectiveTimeoutMs, resolveConfig, WORKER_ENV_ALLOW_LIST } from "./runtime/limits.ts";
export type { PtcConfig, PtcSurface } from "./runtime/limits.ts";
export { PTC_ERROR_KIND, PTC_LOG_LEVEL, HOST_FRAME_KIND, WORKER_FRAME_KIND } from "./runtime/protocol.ts";
export type { PtcErrorKind, PtcErrorShape, PtcJsonValue } from "./runtime/protocol.ts";

export default function ptcSubagents(_pi: ExtensionAPI): void {
  // Tool registration lives in T4 (`ptc_run_code`) and T5 (`ptc_workflow`); both wrap the
  // `runPtcProgram` machinery re-exported above.
}
