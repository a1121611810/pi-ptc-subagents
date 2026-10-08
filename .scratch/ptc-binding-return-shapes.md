# `ptc_run_code` binding return shapes — investigation report

## 1. src/tools/run-code.ts — full DESCRIPTION + assembly

`DESCRIPTION` is a module-local `const` array of 20 string literals joined with `"\n"`, at
src/tools/run-code.ts:40-65. Verbatim:

```ts
const DESCRIPTION = [
  "Run a TypeScript program that composes pi's tools in one shot. Required arguments: `code` —",
  "the body of an async function (top-level `return` and `await` work; type annotations are",
  "advisory, the code runs type-stripped) — and `description`, a 5-10 word summary of what the",
  "program does.",
  "",
  "Inside the program, call this session's enabled built-in tools as `tools.<name>(args)` — e.g.",
  '`await tools.read({ path: "src/index.ts" })` or `await tools.bash({ command: "npm test" })`.',
  "The bound names mirror the session's active tools (a default session has `read`, `bash`, `edit`,",
  "`write`); calling a name that is not bound rejects with an error the program can catch, and",
  "independent calls may overlap under `Promise.all`.",
  "",
  "The parallel binding `pi.dispatch` is always available, registered under its literal dot name —",
  'call it with string indexing, e.g. `await tools["pi.dispatch"]({ agent: "reviewer", task: "..." })`;',
  "`tools.pi.dispatch` does not exist. It fans work out to child pi agents, and independent",
  "foreground dispatches compose under `Promise.all` exactly like the built-in calls. The run's",
  "actual bound names (this run, not a static list) are on the `ptcBindings` global, so the program",
  "never has to guess what is bound.",
  "",
  "Only the program's return value and its `console.log` output come back. This surface has no",
  "helpers: `log` / `phase` / `parallel` / `pipeline` exist only in `ptc_workflow`.",
  "",
  "Image-bearing tool results inside the program (a `tools.read` on a PNG, say) are attached to you",
  "after the run, so never return image data as the completion value — that only spends your context",
  "on base64.",
].join("\n");
```

**Assembly into the model-facing text** — three SEPARATE surfaces, wired in the single
`defineTool` call at src/tools/run-code.ts:135-141. They are NOT concatenated; pi collects them
separately in `_refreshToolRegistry`
(node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2236-2248,
`_toolPromptSnippets` / `_toolPromptGuidelines`).

- `description: DESCRIPTION` (src/tools/run-code.ts:138) -> the tool declaration's `description`
  field (the function-calling schema text the model reads). This is the only model-facing surface
  that can be arbitrarily long.
- `promptSnippet: PTC_RUN_CODE_SNIPPET` (src/tools/run-code.ts:139) -> pi's "Available tools" one-liner
  (see src/tools/common.ts:129-138).
- `promptGuidelines: [...PTC_TOOL_GUIDELINES]` (src/tools/run-code.ts:140) -> pi's flat `Guidelines`
  section.

**Existing "declaration" or type text: NONE.** `DESCRIPTION` says only _how to call_
(`tools.<name>(args)`) and never says what a call returns. There is no TS declaration block, no
per-binding return table, no `ToolOutputMap` analogue anywhere in the repo. The parity audit already
names this as gap **A4**: docs/research/ptc-upstream-parity-audit-20260930.md:173 —
"**生成的 TypeScript SDK 段**注入系统提示：`ToolArgsMap`/`ToolOutputMap`/`ToolCallError` 全量声明 …
本项目：**无**。只有工具描述里两行手写示例（`run-code.ts:47-48`）". DSH's generator is cited as
`ts-types.js:270-290`.

The file-header docstring (src/tools/run-code.ts:1-19) also never states return shapes.

## 2. src/tools/workflow.ts — yes, its own DESCRIPTION, and no return-shape text

Its own `DESCRIPTION` at src/tools/workflow.ts:44-63; the binding sentence is
src/tools/workflow.ts:55-59:

```ts
  "Tools are reachable as `tools.<name>(args)` exactly as in `ptc_run_code`, and the bound names",
  "mirror the session's enabled tools. The parallel binding `pi.dispatch` is always available under",
  'its literal dot name — call it with string indexing: `await tools["pi.dispatch"]({ agent, task })`;',
  "the run's actual bound names are on the `ptcBindings` global. What comes back is the script's",
  "return value, its `log`/`phase` narration and its `console.log` output.",
```

**It does NOT mention the return shapes of `tools.<name>()` either.** "What comes back" refers to
the _script's_ completion value, not to a binding result. Wired identically at
src/tools/workflow.ts:230-232.

Also duplicated in the PTC-mode briefing, `buildModeInstruction` (src/mode/ptc-mode.ts:303-342,
esp. :329-333) — a THIRD model-facing place that lists call forms and `ptcBindings`.

## 3. src/tools/common.ts — the shared constants

- `PTC_RUN_CODE_SNIPPET` — src/tools/common.ts:137-138, one line:
  "Run a TypeScript program that composes pi's tools in one shot (tools.<name>(args)); only its
  return value and console.log come back"
  **Consumed only by run-code** (src/tools/run-code.ts:139). No other src or test references.
- `PTC_WORKFLOW_SNIPPET` — src/tools/common.ts:140-141:
  "Run a structured TypeScript workflow with named phases, narration (log/phase) and structured
  concurrency (parallel/pipeline)"
  **Consumed only by workflow** (src/tools/workflow.ts:231).
- `PTC_TOOL_GUIDELINES` — src/tools/common.ts:148-155, 3 bullets, verbatim:
  1. "Image-bearing tool results inside a program (a `tools.read` on a PNG, say) are attached to you
     after the run — never return image data as the completion value."
  2. "Use ptc_run_code when a task needs several tool calls whose intermediate output you do not
     need to see — gather it inside the program and return only the final value."
  3. "Use ptc_workflow instead of ptc_run_code when the work has named phases and the user benefits
     from seeing progress narration."
     **SHARED by both tools** (src/tools/run-code.ts:140 and src/tools/workflow.ts:232), each spread
     into a fresh array.

So: the snippet is _not_ shared; the guidelines _are_. Neither mentions return shapes. Doc comment at
src/tools/common.ts:143-147 notes these land in pi's flat `Guidelines` section with no tool-name
prefix.

## 4. How `ptcBindings` reaches the program — a frozen string[], nothing richer

src/runtime/worker-main.ts:831-836, inside `startRun` (run init, every run):

```ts
// Field report pitfall #5 (2026-09-29): the bound set can grow between runs (late-registered
// extension tools), so the program sees THIS run's actual manifest — the same names as the
// `tools` keys, `pi.dispatch` included only when it is bound — instead of a static list.
// It is reinstalled per run: `restoreWarmBaseline` deletes the previous run's copy before
// `startRun` replaces it.
globals().ptcBindings = Object.freeze([...bindingNames]);
```

**Exactly a frozen array of plain strings** — bare names, no per-name type/schema/description.
`bindingNames` is `frame.bindings` filtered to strings (src/runtime/worker-main.ts:813-815). Pinned by
tests: tests/worker-surfaces.test.ts:324-372
(`{ names: [...ptcBindings], frozen: Object.isFrozen(ptcBindings) }`). It does NOT include the
_candidates_: disabled built-ins get a throwing stub instead (src/runtime/worker-main.ts:820-829,
`no binding named "X" in this run; available bindings: …`).

Related globals: `tools` (src/runtime/worker-main.ts:830, a plain
`Record<string, (args: unknown) => Promise<unknown>>`); workflow-only `args`/`log`/`phase`/`parallel`/
`pipeline` (src/runtime/worker-main.ts:592-672); captured `console` (:399-412).

## 5. The exact runtime shape of `await tools.<name>(args)` — per binding

**The universal wrapper.** src/runtime/bindings.ts:232-237 is the ONLY transformation applied to a
built-in's result:

```ts
// What crosses the wire is the tool's model-facing payload: `usage` and
// `terminate` are agent-loop plumbing with no meaning inside a PTC program.
return {
  content: result.content,
  details: result.details === undefined ? null : result.details,
};
```

Then host-side in the dispatcher it is posted VERBATIM as `value` in a `call-result` frame —
`const value = await binding.execute(...)` (src/runtime/dispatcher.ts:730) ->
`{ kind: callResult, ok: true, value }` (:760-766) -> `control.postMessage(frame)` (:855) — i.e.
STRUCTURED CLONE ONLY, no normalisation, no re-shaping, no text cleaning. The worker resolves the
promise with that value as-is: `entry.resolve(frame.value)` (src/runtime/worker-main.ts:548-550).
(Images are ALSO hoisted host-side for the outer tool result — src/runtime/dispatcher.ts:489-519 —
but the image blocks are LEFT IN `content`; nothing is stripped.)

So inside the program, for all seven built-ins:

```ts
const r = await tools.read({ path: "x" });
// r            -> plain object (structured-cloned)
// r.content    -> Array<TextContent | ImageContent>, 1 or 2 blocks
// r.content[0] -> { type: "text", text: string }   (always index 0 for the 7 builtins)
// r.details    -> plain object | null   (null, never undefined — bindings.ts:236)
```

Per binding, from each tool's `execute` in @earendil-works/pi-coding-agent@0.86.1
(`dist/core/tools/*.js`; all built via `createXxxTool(cwd)` -> `wrapToolDefinition`, which is
pass-through: tool-definition-wrapper.js:11):

| binding   | `content`                                                                                                                                                                                                                                                                                                                                           | `details`                                                                                                                                | rejection cases (the call THROWS)                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **read**  | text file: exactly 1 block `[{type:"text",text:<file body, possibly with a `[Showing lines ...]`/`[... more lines in file ...]` notice>}]` (read.js:144). image: 2 blocks — `[{type:"text",text:"Read image file [mime]"...}, {type:"image",data:<base64>,mimeType}]` (read.js:82-85). image that fails processing: 1 text block only (read.js:74). | `{ truncation: TruncationResult }` when truncated, else `undefined` -> **null** (read.js:119,132,149)                                    | missing/unreadable file; `offset` past EOF (read.js:99)                                                          |
| **bash**  | exactly 1 text block, **stdout+stderr merged** (bash.js:272)                                                                                                                                                                                                                                                                                        | `{ truncation?, fullOutputPath? }` when truncated, else **null** (bash.js:224,272)                                                       | **non-zero exit code THROWS** ("Command exited with code N", bash.js:269-271); abort; timeout; no exit code      |
| **edit**  | exactly 1 text block: `"Successfully replaced N block(s) in <path>."` (edit.js:131-136)                                                                                                                                                                                                                                                             | **always present**: `{ diff: string, patch: string, firstChangedLine: number \| undefined }` (edit.js:137; type edit-diff.d.ts:79-82)    | file missing ("Could not edit file: ...", edit.js:112); `oldText` not unique/not found; `edits: []` (edit.js:76) |
| **write** | exactly 1 text block: `"Successfully wrote to <path>"` (write.js:50)                                                                                                                                                                                                                                                                                | **always `undefined` -> always null** (write.js:51)                                                                                      | abort only                                                                                                       |
| **grep**  | exactly 1 text block of `path:line: text` rows, plus a trailing `[... limit reached ...]` notice when capped (grep.js:206,234-236). **Zero matches -> the literal string `"No matches found"`** (grep.js:192)                                                                                                                                       | `{ truncation?, matchLimitReached?: number, linesTruncated?: boolean }`, or **null** when no notice fired (grep.js:236; grep.d.ts:19-23) | `rg` unavailable; path not found ("Path not found: ...", grep.js:64); `rg` exit code other than 0/1              |
| **find**  | exactly 1 text block of relative paths, one per line, plus `[... notices ...]` (find.js:228-231). **Zero results -> `"No files found matching pattern"`** (find.js:199)                                                                                                                                                                             | `{ truncation?, resultLimitReached?: number }`, or null (find.js:230; find.d.ts:18-21)                                                   | path not found (find.js:71); `fd` unavailable; `fd` failed with no output                                        |
| **ls**    | exactly 1 text block, alphabetical, `/` suffix on directories, one per line (ls.js:83,108-111). **Empty dir -> `"(empty directory)"`** (ls.js:87)                                                                                                                                                                                                   | `{ truncation?, entryLimitReached?: number }`, or null (ls.js:110; ls.d.ts:14-17)                                                        | path not found; not a directory ("Not a directory: ..."); unreadable                                             |

`TruncationResult` (shared, dist/core/tools/truncate.d.ts:13-36) =
`{ content, truncated, truncatedBy: "lines"|"bytes"|null, totalLines, totalBytes, outputLines,
outputBytes, lastLinePartial, firstLineExceedsLimit, maxLines, maxBytes }`.

**Three facts the current description does not state, and that explain the 31 benchmark crashes:**

1. `content` is an ARRAY OF BLOCKS, never a string -> `r.content.split(...)` is "content.split is not a
   function"; the text is `r.content[0].text`.
2. There is NO `files` / `entries` / `output` field on any result. `ls` / `find` / `grep` / `bash`
   are text blobs of newline-separated rows — you must `.split("\n")` yourself -> "files is not
   iterable". The repo's own tests do exactly this:
   `r.content.map(p => p.text ?? "").join("").trim()` (tests/binding-policy.test.ts:93),
   `r.content[0].text` (tests/bindings.test.ts:85, tests/dispatcher.test.ts:127,
   tests/run-code-tool.test.ts:243).
3. **`pi.dispatch` is the odd one out: its result is a FLAT object with NO `content` at all** —
   `DispatchResult` = `{ text, status: "fulfilled"|"rejected", started, agentName, durationMs,
exitCode, usage?, stderr?, errorMessage? }` (interface in src/runtime/dispatch.ts, surfaced at
   src/runtime/bindings.ts:289-302). `r.content` there is `undefined`; the text is `r.text`. The
   dispatcher itself special-cases exactly this asymmetry (src/runtime/dispatcher.ts:238-260,
   `firstLineOf` returns `undefined` for it).

**Error path (all bindings):** a throwing `execute` (or a `validateToolArguments` throw at
src/runtime/bindings.ts:225) is caught host-side and posted as `{ ok: false, message }`
(src/runtime/dispatcher.ts:821-840); the worker rejects with `ToolCallError`
(src/runtime/worker-main.ts:542-558, class at :149-156 — `name === "ToolCallError"`, `.toolName`,
`.message`). So the program sees a CATCHABLE REJECTION, never a resolved error value — except
`pi.dispatch`, which "never throws" and returns a `status:"rejected"` result instead
(src/runtime/bindings.ts:259-288).

## 6. Existing value->text helpers (for a declaration that stays truthful)

- `describeValue(value: unknown): string` — src/runtime/protocol.ts:381-385. Returns `"null"` /
  `"an array"` / `"a <typeof>"`. Very coarse; used only in error messages (worker helpers +
  `validateWorkflowArgs`).
- `renderModelValue(value: PtcJsonValue): string` — src/tools/text.ts:206-214. The model-facing
  renderer for a completion value (top-level string verbatim, else inline `{key: value}` under 100
  chars, else an indented block; per-line cap 200). **Exported publicly** at src/index.ts:91
  alongside `sanitizeText` / `stripAnsi`.
- `renderValueTree(value: PtcJsonValue, options?: { maxDepth?, maxChildren?, maxLineChars?,
moreAfter? }): string[]` — src/tools/render.ts:516-524. TUI tree rows for the completion value.
- `formatArgs(args: readonly unknown[]): string` — src/runtime/worker-main.ts:383-390. The
  **console.inspect wrapper**: `deps.inspect(arg, { depth: 4, breakLength: Infinity, colors: false })`
  for non-string args (`deps.inspect` = `node:util.inspect`, injected at
  src/runtime/worker-entry.ts:26). Private to the worker; not exported. Closest existing thing to a
  "render any value" helper.
- `sanitizeText(value: string): string` / `stripAnsi(value: string): string` — src/tools/text.ts:65 /
  :49.

**None of these can be reused to DERIVE a declaration**: they all render a concrete value, none
infers a schema. A declaration block would have to be hand-written from the table in section 5 (or
generated from `BUILTIN_BINDING_NAMES` at src/runtime/bindings.ts:41-49 plus a static per-name return
type, since the return types come from the pi SDK's `.d.ts`, not from anything in this repo).

## Things to watch when you change it

- Description text is pinned by tests: tests/run-code-tool.test.ts:203-217
  (`tools["pi.dispatch"]`, "`tools.pi.dispatch` does not exist", "foreground dispatches compose under
  `Promise.all`", "`ptcBindings`"), tests/run-code-tool.test.ts:200 (`not.toMatch(/sandbox/i)`),
  tests/workflow-tool.test.ts:61-81 (helpers, `pi.dispatch`, `ptcBindings`, `meta.phases`, `args`),
  tests/ptc-mode.test.ts:250.
- The same facts appear in three model-facing places: src/tools/run-code.ts:40,
  src/tools/workflow.ts:44, and `buildModeInstruction` (src/mode/ptc-mode.ts:303-342).
- DSH's precedent is a GENERATED TypeScript declaration (`ToolArgsMap` / `ToolOutputMap` /
  `ToolCallError`) injected into the system prompt, 3000-token budget + BM25 `searchTools` /
  `describeTool` fallback (audit :29, gap A4 at :173, and B4 at :202 noting this repo's
  `ptcBindings` global was the substitute for DSH's static `.d.ts`).
- Two known description inaccuracies you may want to fix in the same pass: it says "a default
  session has `read`, `bash`, `edit`, `write`" (src/tools/run-code.ts:48-49) but
  `DEFAULT_BINDING_NAMES` is all 7 (src/runtime/bindings.ts:64); and "independent calls may overlap
  under `Promise.all`" (src/tools/run-code.ts:50) is what the audit flags as A6 — pi/DSH classify
  concurrency, `bash` / `write` are not safe to overlap.

No files were modified (except this report, written under .scratch/).
