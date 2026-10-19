/**
 * The caller session's current model, as a dispatch can learn it.
 *
 * ADR-0044: a dispatch that names no model at the call site and whose agent markdown names
 * none inherits the model the caller's session is currently running. That fact lives on pi's
 * tool-execution context (`ctx.model`) rather than in this package, so this module is the one
 * structural reader of it -- kept separate so 0.86.0's type surface (which may not declare the
 * field) cannot turn the read into a compile error on the declared floor.
 *
 * The value is a SNAPSHOT taken when the dispatch starts: a model switch after the spawn does
 * not retro-change a child that is already running, and a nested dispatch inherits the child's
 * own context model (which is what the child runs with, not the grandparent's).
 */

/** One provider + model id pair, e.g. `deepseek` + `deepseek-flash`. */
export interface SessionModel {
  readonly provider: string;
  readonly id: string;
}

/** Bound on each component. Model ids are short; a runaway value is not a model. */
const SESSION_MODEL_COMPONENT_MAX = 200;

/**
 * The `--model` argument for a session model: `provider/id`.
 *
 * pi's own resolver prefers the provider prefix when the part before the first `/` names a
 * known provider (measured on 1.0.0 and 1.3.0), so the qualified form is the deterministic
 * spelling and needs no second `--provider` flag.
 */
export function formatSessionModel(model: SessionModel): string {
  return model.provider + "/" + model.id;
}

/**
 * Read the current model out of a pi tool-execution context, defensively.
 *
 * Returns `undefined` for every shape this module cannot vouch for: a context without a model
 * (direct library callers, a pi too old to pass one, a model-less session), a non-string field,
 * an empty or whitespace-bearing component, a component starting with `-` (argv safety: this
 * value is handed to a child process as an argument), or an over-long component. `undefined`
 * is the "do not inherit" fallback -- the dispatch then keeps pi's configured default, which
 * is the behaviour every existing caller had before ADR-0044.
 */
export function readContextModel(ctx: unknown): SessionModel | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const model = (ctx as { model?: unknown }).model;
  if (model === null || typeof model !== "object") return undefined;
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (!isUsableComponent(provider) || !isUsableComponent(id)) return undefined;
  return { provider, id };
}

function isUsableComponent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_MODEL_COMPONENT_MAX) return false;
  // The component is accepted EXACTLY as it arrived: trimming it here would hide a value the
  // caller wrote differently from the one the child will receive, and `--model " deepseek "` is
  // not the model anyone selected. Surrounding whitespace is a malformed component, not a hint.
  if (trimmed !== value) return false;
  // No whitespace anywhere else either: the value crosses a process boundary as argv, and pi
  // resolves `provider/id` by its first slash -- a whitespace-bearing id would be two args.
  if (/\s/.test(value)) return false;
  // Control characters (NUL, ESC, ...) are not covered by `\s` and must never reach argv.
  if (/\p{Cc}/u.test(value)) return false;
  // A leading dash would be read as a flag by the child pi's argument parser.
  if (value.startsWith("-")) return false;
  return true;
}

/**
 * The observed dispatch model as one spelling: `provider/id` when both were seen, `id` alone
 * when only the model was.
 *
 * The pair is accumulated field by field (a transcript may name a model on a turn that carries
 * no provider), so a formatter may not assume it is complete. `undefined` means NO assistant
 * turn was observed -- callers render no line for it rather than a placeholder, because
 * "the host saw no model" and "the model is called undefined" are different claims.
 *
 * It lives HERE, in the module with no imports at all, and not in `tools/render.ts` where the
 * other shared render helpers live: `tools/ptc-task.ts` needs this formatter, and
 * `render.ts` reaches `common.ts` -> `runtime/bindings.ts` -> `runtime/dispatch.ts`. Adding
 * that edge pulls `dispatch.ts` into `ptc-task.ts`'s module graph ahead of its tests'
 * `node:fs` mock, and agent discovery then reads the real filesystem -- the exact failure
 * `runtime/child-report.ts` records for `CHILD_REPORT_MAX_FINDINGS` and the reason that
 * constant lives in that no-import module too. Vocabulary the tools share with no dependency
 * underneath is what keeps that graph edge from coming back.
 */
export function formatObservedModel(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  const id = model?.trim();
  if (id === undefined || id.length === 0) return undefined;
  const prefix = provider?.trim();
  return prefix === undefined || prefix.length === 0 ? id : prefix + "/" + id;
}
