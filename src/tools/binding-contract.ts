/**
 * The binding contract (ADR-0024): the one place that says what a PTC binding
 * call resolves to.
 *
 * The model was previously told how to *call* a binding and nothing about what a
 * call comes back with, so it guessed: a pty-driven run of the real TUI with PTC
 * mode on produced 31 program crashes across 16 runs, the largest classes being
 * "files is not iterable" and "content.split is not a function". Neither guess is
 * ever true. This block states the shape the runtime actually produces, so those
 * two programs cannot be written.
 *
 * Three rules hold this text honest, and each has a test:
 * 1. The shape is the binding wrapper's, not prose: { content, details } is the
 *    only transformation between a pi tool's result and what a program sees.
 * 2. Arguments are deliberately absent. pi declares every tool's arguments
 *    natively in the same request, so restating them is pure token cost.
 * 3. A note exists only where behaviour genuinely differs from the shared shape,
 *    so a new binding forces a decision about whether it needs one.
 */
import { DISPATCH_BINDING_NAME } from "../runtime/bindings.ts";

/** The estimate upstream's declaration renderer uses: characters per token. */
const CHARS_PER_TOKEN = 4;

/** The ceiling is a decision (ADR-0024 section 5), never a baseline to re-fit. */
export const BINDING_CONTRACT_TOKEN_CEILING = 300;

/**
 * A floor, because a ceiling-only budget test passes on an empty block. Set below
 * the block's real cost so a stub cannot clear it and the real text can.
 */
export const BINDING_CONTRACT_TOKEN_FLOOR = 200;

/**
 * The shared shape, as an array of lines joined into one contiguous chunk so it
 * splices into a description as a single structural element rather than as
 * fragments inside a sentence.
 */
const SHAPE_LINES = [
  "Return value: every `tools.<name>(args)` call above resolves to `{ content, details }`.",
  "`content` is an ARRAY of content blocks, never a string, so a text result is",
  "`result.content[0].text`; `details` is that tool's own detail object or `null`, never",
  "`undefined`. No binding result has a `files`, `output`, `matches` or `entries` field:",
  "`bash`, `grep`, `find` and `ls` hand back ONE text block of newline-separated rows that",
  "you split yourself, and the empty answer is a sentinel string (`No matches found`,",
  "`No files found matching pattern`, `(empty directory)`) rather than an empty list.",
  "A failing call REJECTS with `ToolCallError` instead of resolving: a path that is not there,",
  "a builtin this run did not bind. A name that is not a builtin is simply not a function.",
];

/**
 * Per-binding departures from the shared shape, keyed by binding name. A binding
 * with nothing to add is absent rather than mapped to an empty string, so the key
 * set is exactly the set of bindings that genuinely deviate -- which is what a
 * new binding has to be argued into.
 */
export const BINDING_NOTES: ReadonlyMap<string, string> = new Map([
  ["bash", "`bash` rejects on a non-zero exit rather than resolving with its output."],
  ["write", "`write` always reports `details: null`."],
  ["edit", "`edit` always reports `{ diff, patch, firstChangedLine }`."],
  [
    DISPATCH_BINDING_NAME,
    '`tools["pi.dispatch"]` is the exception: it resolves to `{ text, status, ... }`' +
      " with no `content` and never throws, so read `status`.",
  ],
]);

/**
 * Bindings that carry a note, so a caller (and a test) can ask which bindings
 * deviate without re-deriving it from the rendered prose.
 */
export const NOTED_BINDING_NAMES: readonly string[] = [...BINDING_NOTES.keys()];

/** The binding contract, ready to splice into a tool description. */
export const BINDING_CONTRACT: string = [
  SHAPE_LINES.join("\n"),
  "Exceptions: " + [...BINDING_NOTES.values()].join(" "),
].join("\n");

/**
 * Estimate the block's cost the way the upstream renderer does, so a consumer
 * that renders the contract can report its own cost without a second
 * definition drifting from this one.
 */
export function estimateContractTokens(text: string = BINDING_CONTRACT): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
