/**
 * One measurement of the INSTALLED pi, shared by every version-sensitive test in this repo.
 *
 * Three fields — `structuredContent`, `defaultActive`, `outputSchema` — arrived in pi 0.99.0
 * together and are absent from the 0.86.0 floor `package.json` declares (#192, #193, #195). Every
 * test that has to name one of them must first answer "which pi am I on", and answering that
 * question five different ways is how five probes drift into disagreeing with each other and with
 * pi. This module is the ONE answer.
 *
 * ## It reads the INSTALLED pi, and nothing else
 *
 * Never this repo's own `src/` or `dist/`. A probe that scanned our own symbols would answer
 * "yes, we implement the channel" on every version — the CONSTANT answer, not a measurement — and
 * the branch it selects would then be a restatement of our own code. Everything below is read out
 * of `node_modules/@earendil-works/pi-coding-agent`, resolved by walking up from the caller so
 * the same code works from `tests/` and `tests/unit/` alike.
 *
 * ## Why EXACT matchers, and the defect they exist to prevent
 *
 * The obvious spelling — `source.includes("defaultActive")` — is wrong, and wrong in the worst
 * available direction. Measured on the floor (pi 0.86.1, `dist/core/agent-session.js`):
 *
 *     grep -o 'defaultActive'    -> 2   `defaultActiveToolNames`, an unrelated LOCAL VARIABLE
 *     grep -o '\.defaultActive'  -> 0   no property read at all
 *
 * Both of the floor's two occurrences are substrings of a local variable name, so the
 * bare-substring probe reads TRUE on the floor: a probe that is permanently true is not a
 * measurement, and the branch it selects is a constant dressed up as a finding. Every matcher
 * below therefore matches the PROPERTY READ (`\.` + name + word boundary), never the bare
 * identifier, and each is anchored to the symbol that actually performs the read.
 *
 * The floor proves the difference is behavioural, not lexical: pi 0.86.1's
 * `_refreshToolRegistry` activates every newly-registered tool with a bare
 * `if (!previousRegistryNames.has(toolName))` and NO per-tool check, while 1.0.0's same loop calls
 * `_isActivatedOnRegistration(toolName)` — which returns
 * `...?.definition.defaultActive !== false`. So on the floor `defaultActive: false` on
 * `ptc_child_report` is genuinely INERT. See `DEFAULT_ACTIVE_AVAILABLE`.
 *
 * ## The three fields are ONE compile gate, measured three ways
 *
 * `outputSchema` is probed in `dist/extensions/codemode/execute.js`, NOT in `agent-session.js`,
 * and that placement is load-bearing rather than cosmetic. Measured: `.outputSchema` occurs
 * ZERO times in `agent-session.js` on pi 1.0.0 as well as on 0.86.1, so probing it there would
 * answer `false` on BOTH ends — the same恒-false defect as the bare-substring probe, reached from
 * the other direction. The single place that decides what `outputSchema` means is the codemode
 * gate
 *
 *     if (tool.outputSchema && result.structuredContent !== undefined)
 *         return result.structuredContent;
 *
 * — both halves of one `if`, in a file that does not exist on the floor at all. That line is why
 * the three fields belong to one gate, and why probing them apart is still worth doing: a pi that
 * gained `structuredContent` without shipping the codemode that reads it would have the first and
 * not the third.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The installed pi's package root, or `undefined` when no pi is installed.
 *
 * Walked up rather than resolved through the package `exports` map, which does not expose pi's
 * internals. `realpathSync` because pnpm symlinks
 * `node_modules/@earendil-works/pi-coding-agent` into `node_modules/.pnpm/…`, and the probes
 * join paths onto the RESULT — a non-canonical path would send every lookup somewhere pnpm does
 * not put it.
 */
export function installedPiDir(fromDir: string): string | undefined {
  let dir = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** One file inside the installed pi, or `""` when either the pi or that file is absent. */
function piFile(piDir: string | undefined, ...parts: string[]): string {
  if (piDir === undefined) return "";
  const file = join(piDir, "dist", ...parts);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * The measured capabilities of one installed pi.
 *
 * One interface for all three rather than three independent booleans, because the three are
 * answers about the SAME install: a caller that could mix them would be able to report a pi with
 * `structuredContent` but no codemode to read it — a shape no measured version has and nothing
 * else in this repo would catch.
 */
export interface PiCompatCapabilities {
  /** The installed pi's package root, or `undefined` when none is installed. */
  readonly piDir: string | undefined;
  /**
   * Whether a tool's `structuredContent` survives onto the `tool_execution_end` the host reads.
   *
   * Channel 1 of ADR-0032. True from 0.99.0, where `agent-session.js` puts the field on the event;
   * `--mode json`'s `toJsonEvent` returns any non-`message_update` event VERBATIM
   * (`dist/modes/json-event.js`, byte-identical on both measured ends — 1057 bytes each), so
   * nothing downstream drops it. On 0.86.x the token occurs ZERO times in the whole dist and the
   * event is rebuilt field by field, so the channel cannot deliver.
   */
  readonly structuredContentOnTheWire: boolean;
  /**
   * Whether pi reads `definition.defaultActive` per tool when activating.
   *
   * Matched as a PROPERTY READ (`\.` + name + word boundary), never as a bare identifier: the
   * floor carries the identifier twice as a local variable and reads the property zero times, so
   * a name-based matcher would be true on both ends and measure nothing.
   */
  readonly defaultActiveRead: boolean;
  /**
   * Whether anything CONSUMES `outputSchema` — read in the codemode sandbox, absent below 0.99.0.
   *
   * The mirror of `structuredContentOnTheWire`: a tool declaring a schema whose result never
   * arrives is a schema nothing ever resolves a value against.
   */
  readonly outputSchemaRead: boolean;
}

/**
 * Read one installed-pi file, for a test that must QUOTE it rather than branch on it.
 *
 * Exposed on purpose: a branch assertion that re-derives its own condition by calling
 * `probePiCapabilities` a second time proves nothing, because a probe whose matcher was mutated
 * returns the mutated answer every time. Measured — forcing `structuredContentOnTheWire` to
 * `true` on the 0.86.0 floor left `tests/unit/dispatch-child-report.test.ts` entirely green,
 * because its "each arm re-derives the probe" guard read the same forced object. The guard has to
 * come back to the FILE, not to the probe.
 */
export function installedPiSource(fromDir: string, ...parts: string[]): string {
  return piFile(installedPiDir(fromDir), ...parts);
}

/**
 * Resolve all three capabilities in ONE pass over the installed tree.
 *
 * `fromDir` is a test file's own directory (`import.meta.dirname`), so the walk starts where the
 * test actually is and needs no knowledge of the repo layout.
 */
export function probePiCapabilities(fromDir: string): PiCompatCapabilities {
  const piDir = installedPiDir(fromDir);
  const session = piFile(piDir, "core", "agent-session.js");
  const codemodeExecute = piFile(piDir, "extensions", "codemode", "execute.js");

  return {
    piDir,
    // The emitter's own construction of the field, property read and word-boundary anchored.
    // Deliberately not `includes("structuredContent")`: the floor has zero occurrences either
    // way, so that spelling would pass today and would keep passing if pi grew the token in a
    // comment. This one asks "does the session PUT the field on the event".
    structuredContentOnTheWire: /structuredContent:\s*[^,\n]*\.structuredContent/.test(session),
    defaultActiveRead: /\.defaultActive\b/.test(session),
    // Both halves of one `if`, in the file that would consume it. On the floor that file does not
    // exist at all, so this is false there without needing a token match to carry it.
    outputSchemaRead: /tool\.outputSchema\s*&&\s*result\.structuredContent\s*!==\s*undefined/.test(
      codemodeExecute,
    ),
  };
}

/**
 * Whether pi honours `defaultActive: false` — the difference between "the field is not typed"
 * and "the field is read but changes nothing".
 *
 * **Measured, and on the floor the declaration is inert.** pi 0.86.1's `_refreshToolRegistry`
 * (`dist/core/agent-session.js`) handles a newly-registered tool with
 *
 *     else if (!options?.activeToolNames) {
 *         for (const toolName of this._toolRegistry.keys()) {
 *             if (!previousRegistryNames.has(toolName)) {
 *                 nextActiveToolNames.push(toolName);
 *             }
 *         }
 *     }
 *
 * — one check, and it is about RECENCY, not activation. pi 1.0.0's same loop calls
 * `_isActivatedOnRegistration(toolName)`, i.e.
 * `_isDeclarable(name) && ...?.definition.defaultActive !== false`. So on the floor this package's
 * `ptc_child_report` carries `defaultActive: false` into a parent session and is activated there
 * anyway: "registered in the parent but never activated there" is a distinction pi 0.86.1 cannot
 * express, which is why the tests assert what the floor CAN honour instead.
 *
 * Exported as a helper rather than re-derived per file so that the claim — and the reason it is
 * true — lives in one place that every consumer reads the same way.
 */
export function defaultActiveIsHonoured(capabilities: PiCompatCapabilities): boolean {
  return capabilities.defaultActiveRead;
}

/**
 * `result.structuredContent`, read through one widening seam.
 *
 * pi 0.86.0 types `AgentToolResult` without the field — the TS2339 the narrowing exists for — so
 * the read goes here instead of at each site that names it. `unknown` on purpose: on the tool
 * channel the value is an opaque `JsonValue` (whatever pi validated), and deciding whether it is
 * a report belongs to the HOST's validator, not to this seam.
 */
export function readStructuredContent(result: unknown): unknown {
  return (result as { structuredContent?: unknown }).structuredContent;
}

/**
 * `definition.defaultActive`, through the same seam for the same reason.
 *
 * `undefined` is the honest reading of a pi that has the property but never set it, and on such a
 * pi that IS the default: a `direct` tool is activated on registration unless the declaration opts
 * out. "Field absent from the type" and "left off" are therefore indistinguishable to every
 * caller, which is why both collapse to `undefined` rather than to `false` — `false` would be a
 * claim about a declaration this helper did not read.
 */
export function readDefaultActive(definition: unknown): boolean | undefined {
  return (definition as { defaultActive?: boolean }).defaultActive;
}

/**
 * `definition.outputSchema` — the declaration that makes `structuredContent` a CHANNEL rather than
 * an internal detail, and the identity the "declared twice on purpose" assertion pins against
 * `parameters`. Same seam, same reason.
 */
export function readOutputSchema(definition: unknown): unknown {
  return (definition as { outputSchema?: unknown }).outputSchema;
}
