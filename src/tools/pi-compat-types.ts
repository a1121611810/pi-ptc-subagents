/**
 * The pi type surface this package needs, declared locally so `src/` compiles on the declared
 * floor. Ticket #193; the spec is #192.
 *
 * ## The problem
 *
 * `package.json` declares `peerDependencies.@earendil-works/pi-coding-agent: ">=0.86.0"`, and
 * `tsc --noEmit` over the floor tree produces 20 errors, 9 of them from `src/` — two because
 * `ToolExposure` is not an exported member there, and seven because a `ToolDefinition` object
 * literal is rejected for carrying `outputSchema` / `exposure` / `defaultActive`. None of that
 * is a behaviour gap: the package installs and runs on 0.86.0 (measured across 14 versions, 210
 * feature checks), so the declaration was honest about runtime and dishonest about types.
 *
 * Both problems have one root cause, measured rather than assumed:
 *
 * - **`ToolExposure` does not exist below 0.99.0.** `grep -rn 'ToolExposure'` over
 *   `@earendil-works/pi-coding-agent@0.86.0`'s `dist/` returns **0** matches, and `grep -rn
 *   'exposure'` returns **0** as well — the concept is absent from that tree entirely, not merely
 *   unexported. It arrives in 0.99.0 (verified by unpacking that version's tarball:
 *   `dist/core/extensions/types.d.ts:388`).
 * - **The three fields are not on `ToolDefinition` below 0.99.0.** On 0.86.0 the interface runs
 *   `dist/core/extensions/types.d.ts:345`–`:378` and goes from `prepareArguments` straight to
 *   `executionMode`; on 1.0.0 the same interface at `:439` carries the three fields in between.
 *
 * **So on such a pi the three fields are inert, and that is what makes a local declaration correct
 * rather than a loosening.** A pi that does not read `outputSchema` cannot turn a result into a
 * codemode script, and 0.86.0 ships no `codemode` at all, so nothing can call an
 * `exposure: "codemode"`-reach tool — the tools there fall back to being declared to the model,
 * which is the behaviour `full` mode wants anyway. That fallback is the floor's own behaviour,
 * not a branch this package takes: the field is simply unread, and the two callers below still
 * register and run.
 *
 * ## Correspondence with upstream
 *
 * `ToolExposure` below is a transcription of pi 1.0.0's declaration
 * (`dist/core/extensions/types.d.ts:388`, byte-identical in 0.99.0 at the same file):
 *
 *     export type ToolExposure =
  | "direct"
  | "model-only"
  | "codemode"
  | "deferred"
  | "hidden"
 ;
 *
 * It is the **full five-literal union**, not the `"direct" | "codemode"` pair this package
 * actually passes. The pair would satisfy the direction these call sites need (each member is
 * assignable to pi's union), but the guard test asserts **bidirectional** assignability and that
 * is what fails on a two-literal copy: `"deferred"` is in pi's union and not in the pair, so pi's
 * `ToolExposure` is not assignable to the pair. Narrowing here would let the copy drift silently
 * the next time pi adds a member — the exact failure the guard exists to catch.
 * `PtcRunCodeToolOptions.exposure` documents which two of the five this package sets.
 *
 * ## Why an interface and a wrapper function, and not a type alias
 *
 * The obvious spelling — `type CompatToolDefinition<…> = PiToolDefinition<…> & { …three }` — does
 * not work, and the reason is worth keeping because it is not visible in the declaration. An
 * intersection loses the `any` fast path in `renderCall`, whose parameter is contravariant, so
 * `CompatToolDefinition<RunCodeParameters, …>` stops being assignable to
 * `ToolDefinition<any, any, any>`. Measured: with the intersection that assignment is TS2345
 * ("`unknown` is not assignable to `{ code: string; … }`"), while the same assignment on pi's
 * own type compiles. `AnyTool` in `child-report-tool.ts` / `ptc-task.ts` is exactly
 * `ToolDefinition<any, any, any>`, and `tests/binding-policy.test.ts` annotates its helper with
 * it, so the alias breaks four existing call sites.
 *
 * An `interface … extends` keeps the `any` fast path: `CompatToolDefinition<RunCodeParameters>`
 * widens to `CompatToolDefinition<any, any, any>` cleanly. The three fields are then removed on
 * the way out, which is what makes the whole thing sound rather than merely compiling — see
 * `defineCompatTool`.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * How the model reaches a tool. Mirrors pi 0.99.0+ / 1.0.0's `ToolExposure`
 * (`dist/core/extensions/types.d.ts:388`).
 *
 * Wider than what this package ever passes (`"direct"` and `"codemode"`), on purpose — see the
 * module comment on why the guard test requires the full union.
 */
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/**
 * Pi's `ToolDefinition`, plus the three optional fields 0.99.0+ grew onto it.
 *
 * It **extends** pi's own declaration rather than restating it, so every field this package does
 * not own — `name`, `parameters`, `execute`, `renderCall`, `renderResult`, … — is read from
 * the installed pi and cannot drift from it. Only the three post-0.86.0 fields are declared here,
 * each at the type upstream gives it:
 *
 * | field          | declared here          | pi 1.0.0                      |
 * | -------------- | ---------------------- | ----------------------------- |
 * | `outputSchema`  | `TSchema | undefined`    | `outputSchema?: TSchema` (462) |
 * | `exposure`      | `ToolExposure | undef`  | `exposure?: ToolExposure` (466) |
 * | `defaultActive` | `boolean | undefined`     | `defaultActive?: boolean` (471) |
 *
 * All three are optional, which is what makes the extension safe in both directions: a pi that
 * lacks them satisfies this type (it is the wider one), and a pi that has them satisfies it too
 * (same three, same types). So a value typed here is accepted by `pi.registerTool` across the
 * declared peer range, not only on the pinned version.
 *
 * `TParams`/`TDetails`/`TState` keep pi's parameter order and defaults, so the
 * `ToolDefinition<X, Y>` annotations throughout `src/` mean the same thing as before.
 */
export interface CompatToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = any,
> extends PiToolDefinition<TParams, TDetails, TState> {
  /** JSON Schema of `structuredContent` in successful results (pi `types.d.ts:462`). */
  outputSchema?: TSchema;
  /** How the model reaches the tool. Default `"direct"` (pi `types.d.ts:466`). */
  exposure?: ToolExposure;
  /** Whether registering the tool activates it. Default `true` (pi `types.d.ts:471`). */
  defaultActive?: boolean;
}

/**
 * Build a tool definition that may carry the three post-0.86.0 fields, and hand back pi's own
 * `ToolDefinition` so nothing downstream needs to know this module exists.
 *
 * The narrowing on the way out is deliberate and is the point of the function. `ToolDefinition`'s
 * three fields are optional on both sides, so returning pi's type is lossless — and it means every
 * consumer of a built tool (`pi.registerTool`, the `AnyTool` aliases, the test helpers) keeps
 * annotating pi's type, which is the type that actually exists on every version in the peer range.
 * A tool definition that only ever existed as a `CompatToolDefinition` would force those consumers
 * to import a type that a 0.86.0 consumer could not resolve.
 */
export function defineCompatTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: CompatToolDefinition<TParams, TDetails, TState>,
): PiToolDefinition<TParams, TDetails, TState> {
  return defineTool(tool);
}
