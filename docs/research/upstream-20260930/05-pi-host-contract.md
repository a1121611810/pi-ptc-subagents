# The pi Host SDK Contract — Ground Truth for a PTC Extension

**Scope.** The contract a third-party extension must integrate with, as it actually exists in
the installed first-party artifacts. No memory-of-other-versions; every claim cites the
installed file.

| artifact                          | installed version       |
| --------------------------------- | ----------------------- |
| `@earendil-works/pi-coding-agent` | **0.86.1**              |
| `@earendil-works/pi-ai`           | **0.86.1**              |
| `@earendil-works/pi-tui`          | **0.87.0**              |
| `@earendil-works/pi-agent-core`   | **0.86.1** (transitive) |

Base: `<repo>/node_modules/@earendil-works/`

The audited host project declares exactly these: `package.json:44-48`
(`devDependencies` `^0.86.1` / `^0.87.0`, `peerDependencies` `>=0.86.0`) and
`package.json:78-83` (`"pi": { "extensions": ["./dist/index.js"] }`).

**Note on `dist/index.d.ts`.** It is only 36 lines — a pure re-export barrel
(`dist/index.d.ts:1-36`). The real public type surface lives in
`dist/core/extensions/types.d.ts` (1360 lines), `dist/core/agent-session.d.ts` (724),
`dist/core/session-manager.d.ts` (379), `dist/core/tools/*.d.ts`, and
`dist/core/extensions/runner.d.ts` (181). A consumer that only reads `dist/index.d.ts`
sees the _names_, not the shapes.

---

## 1. The extension API surface

### 1.1 Module shape

An extension is a TypeScript module whose **default export is a factory** taking
`ExtensionAPI`, sync or async:

- `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>` — `dist/core/extensions/types.d.ts:1169`
- `InlineExtension = ExtensionFactory | { name; factory; hidden? }` — `types.d.ts:1170-1176`
- `export default function (pi: ExtensionAPI) { … }` — `docs/extensions.md:158-177`
- Async factories are awaited **before** `session_start`, `resources_discover`, and before
  queued `pi.registerProvider()` calls flush — `docs/extensions.md:181`
- Loaded via **jiti**, so TS works uncompiled — `docs/extensions.md:179`
- **Do not start background resources in the factory** (factories can run in invocations that
  never start a session); defer to `session_start` and register an idempotent
  `session_shutdown` — `docs/extensions.md:220-224`

### 1.2 The 37 events

`ExtensionAPI.on()` declares exactly **37** event overloads at
`dist/core/extensions/types.d.ts:912-948`. The union is `ExtensionEvent` at `types.d.ts:814`.

Handler signature: `ExtensionHandler<E,R> = (event, ctx) => Promise<R|void> | R | void` — `types.d.ts:907`.
`pi.on()` returns an **unsubscribe function** — `docs/extensions.md:1393`.
**Dispatch order: extension load order, then registration order within each extension**;
mutating the handler set mid-dispatch does not affect an in-flight dispatch — `docs/extensions.md:1402`.

| #   | event                     | payload                                                                                                                 | can block / mutate                                                                 | declared                               |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | `project_trust`           | `{ type, cwd }`                                                                                                         | returns `{ trusted: "yes"/"no"/"undecided", remember? }`; first yes/no wins        | `types.d.ts:388-403`, `912`            |
| 2   | `resources_discover`      | `{ type, cwd, reason: "startup"/"reload" }`                                                                             | returns `{ skillPaths?, promptPaths?, themePaths? }`                               | `types.d.ts:405-415`, `913`            |
| 3   | `session_start`           | `{ type, reason: "startup"/"reload"/"new"/"resume"/"fork", previousSessionFile? }`                                      | notify                                                                             | `types.d.ts:417-423`, `914`            |
| 4   | `session_info_changed`    | `{ type, name: string/undefined }`                                                                                      | notify                                                                             | `types.d.ts:425-429`, `915`            |
| 5   | `session_before_switch`   | `{ type, reason: "new"/"resume", targetSessionFile? }`                                                                  | `{ cancel? }`                                                                      | `types.d.ts:431-435`, `916`            |
| 6   | `session_before_fork`     | `{ type, entryId, position: "before"/"at" }`                                                                            | `{ cancel?, skipConversationRestore? }`                                            | `types.d.ts:437-441`, `917`            |
| 7   | `session_before_compact`  | `{ type, preparation, branchEntries, customInstructions?, reason: "manual"/"threshold"/"overflow", willRetry, signal }` | `{ cancel? }` or `{ compaction: CompactionResult }`                                | `types.d.ts:443-453`, `918`            |
| 8   | `session_compact`         | `{ type, compactionEntry, fromExtension, reason, willRetry }`                                                           | notify                                                                             | `types.d.ts:455-463`, `919`            |
| 9   | `session_compact_failed`  | `{ type, reason, errorMessage?, aborted, willRetry, fromExtension }`                                                    | notify                                                                             | `types.d.ts:465-477`, `920`            |
| 10  | `session_shutdown`        | `{ type, reason: "quit"/"reload"/"new"/"resume"/"fork", targetSessionFile? }`                                           | cleanup                                                                            | `types.d.ts:479-484`, `921`            |
| 11  | `session_before_tree`     | `{ type, preparation: TreePreparation, signal }`                                                                        | `{ cancel? }` or `{ summary?, customInstructions?, replaceInstructions?, label? }` | `types.d.ts:486-504`, `922`            |
| 12  | `session_tree`            | `{ type, newLeafId, oldLeafId, summaryEntry?, fromExtension? }`                                                         | notify                                                                             | `types.d.ts:506-512`, `923`            |
| 13  | `context`                 | `{ type, messages: AgentMessage[] }` (deep copy)                                                                        | returns `{ messages? }`                                                            | `types.d.ts:515-518`, `815`, `924`     |
| 14  | `cache_warming_decision`  | pi's cost estimates + decision                                                                                          | returns `{ action: "warm"/"stop" }`; last wins                                     | `types.d.ts:819`, `925`                |
| 15  | `before_provider_request` | `{ type, payload: unknown }`                                                                                            | returns replacement payload; `undefined` keeps                                     | `types.d.ts:520-523`, `818`, `926`     |
| 16  | `before_provider_headers` | `{ type, headers: ProviderHeaders }`                                                                                    | **mutate in place**; return ignored; `null` deletes                                | `types.d.ts:529-532`, `927`            |
| 17  | `after_provider_response` | `{ type, status, headers }`                                                                                             | notify                                                                             | `types.d.ts:534-538`, `928`            |
| 18  | `before_agent_start`      | `{ prompt, images?, readonly systemPrompt, mutable systemPromptOptions }`                                               | `{ message?, systemPrompt? }`                                                      | `types.d.ts:540-550`, `850-854`, `929` |
| 19  | `agent_start`             | `{ type }`                                                                                                              | notify                                                                             | `types.d.ts:552-554`, `930`            |
| 20  | `agent_end`               | `{ type, messages }` — **low-level run only**                                                                           | notify                                                                             | `types.d.ts:556-559`, `931`            |
| 21  | `agent_settled`           | `{ type }` — no retry/compaction/follow-up left                                                                         | notify                                                                             | `types.d.ts:561-563`, `932`            |
| 22  | `ui_prompt_start`         | `{ reason: "ui_prompt", kind, title? }`                                                                                 | notification-only, not awaited                                                     | `types.d.ts:566-571`, `933`            |
| 23  | `ui_prompt_end`           | same shape                                                                                                              | notification-only                                                                  | `types.d.ts:573-578`, `934`            |
| 24  | `turn_start`              | `{ type, turnIndex, timestamp }`                                                                                        | notify                                                                             | `types.d.ts:580-584`, `935`            |
| 25  | `turn_end`                | `{ type, turnIndex, message, toolResults }`                                                                             | notify                                                                             | `types.d.ts:586-591`, `936`            |
| 26  | `message_start`           | `{ type, message }`                                                                                                     | notify                                                                             | `types.d.ts:593-595`, `937`            |
| 27  | `message_update`          | `{ type, message, assistantMessageEvent }` (token-by-token)                                                             | notify                                                                             | `types.d.ts:598-602`, `938`            |
| 28  | `message_end`             | `{ type, message }`                                                                                                     | returns `{ message }`; replacement must keep `role`                                | `types.d.ts:604-607`, `846-849`, `939` |
| 29  | `tool_execution_start`    | `{ toolCallId, toolName, args }`                                                                                        | notify                                                                             | `types.d.ts:609-614`, `940`            |
| 30  | `tool_execution_update`   | `{ toolCallId, toolName, args, partialResult }`                                                                         | notify                                                                             | `types.d.ts:616-622`, `941`            |
| 31  | `tool_execution_end`      | `{ toolCallId, toolName, result, isError }`                                                                             | notify                                                                             | `types.d.ts:624-630`, `942`            |
| 32  | `model_select`            | `{ model, previousModel, source: "set"/"cycle"/"restore" }`                                                             | notify                                                                             | `types.d.ts:631-638`, `943`            |
| 33  | `thinking_level_select`   | `{ level, previousLevel }`                                                                                              | return **ignored** (notification-only)                                             | `types.d.ts:640-644`, `944`            |
| 34  | `tool_call`               | union on `toolName`; `event.input` **mutable in place**                                                                 | `{ block?, reason?, terminate? }`                                                  | `types.d.ts:679-725`, `820-829`, `945` |
| 35  | `tool_result`             | `{ toolCallId, input, content, isError, usage?, details }`                                                              | returns partial patch `{ content?, details?, isError?, usage? }`                   | `types.d.ts:726-772`, `840-845`, `946` |
| 36  | `user_bash`               | `{ command, excludeFromContext, cwd }`                                                                                  | returns `{ operations }` **xor** `{ result }`                                      | `types.d.ts:646-654`, `831-839`, `947` |
| 37  | `input`                   | `{ text, images?, source, streamingBehavior? }`                                                                         | `continue` / `transform` / `handled`; transforms chain                             | `types.d.ts:656-678`, `948`            |

### 1.3 Firing order (authoritative)

`docs/extensions.md:277-349` — the Lifecycle Overview, condensed:

    pi starts
      project_trust          (user/global + CLI extensions only)   md:280
      session_start { reason: "startup" }                           md:281
      resources_discover { reason: "startup" }                     md:282

    user prompt
      extension commands checked first (bypass if matched)         md:287
      input                                                        md:288
      skill/template expansion (if not handled)                     md:289
      before_agent_start   (inject message / modify system prompt) md:290
      agent_start                                                   md:291
      message_start / message_update / message_end                 md:292
        per turn (repeats while the LLM calls tools):              md:294
          turn_start                                               md:296
          context (can modify messages)                            md:297
          before_provider_headers (can mutate headers)             md:298
          before_provider_request (can inspect or replace payload)md:299
          after_provider_response (status + headers, pre-consume)  md:300
            [LLM responds, may call tools:]
              tool_execution_start                                 md:303
              tool_call (can block)                                md:304
              tool_execution_update                                md:305
              tool_result (can modify)                             md:306
              tool_execution_end                                   md:307
          turn_end                                                 md:309
      agent_end                                                    md:311
      agent_settled (no retry/compaction/follow-up left)           md:312

Other orderings:

- **Session replacement** (`/new`, `/resume`, `/fork`, `/clone`, `reload`):
  `session_before_*` (cancel) -> `session_shutdown` -> extensions **reloaded and rebound** ->
  `session_start` -> `resources_discover` — `docs/extensions.md:316-326`, `432`, `449`, `1348-1353`.
  Old `pi` / old command `ctx` session-bound objects are **stale and will throw** after
  replacement — `docs/extensions.md:1290-1331`.
- **Input**: commands -> `input` -> skill expansion -> template expansion -> agent
  — `docs/extensions.md:939-944`.
- **Parallel tool mode**: `tool_execution_start` in assistant source order (preflight), then
  concurrent execution; `tool_execution_update` interleaves; `tool_execution_end` in
  completion order; final `toolResult` message events still in assistant source order
  — `docs/extensions.md:658-663`, `868`.
- **Handler chain**: `before_provider_request` handlers run in extension load order; last
  replacement wins — `docs/extensions.md:710`. `tool_result` handlers "chain like
  middleware", partial patches merge — `docs/extensions.md:870-873`.
- `cache_warming_decision`: last handler returning an action wins — `docs/extensions.md:758`.
- `project_trust`: first extension returning `"yes"`/`"no"` owns the decision and suppresses
  the built-in prompt — `docs/extensions.md:368`, `docs/security.md:27`.
- `before_provider_headers` runs **once per provider request**; retries reuse the same
  headers and do **not** re-fire the hook — `docs/extensions.md:706`.
- `before_agent_start` chains: `event.systemPrompt` and `ctx.getSystemPrompt()` reflect
  earlier handlers' changes; later handlers can still change them
  — `docs/extensions.md:568`, `types.d.ts:546-549`.

### 1.4 `ExtensionContext` (every handler)

`types.d.ts:210-250`:

| member                 | type                                                          | note                                                                                                              |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ui`                   | `ExtensionUIContext`                                          | `types.d.ts:69-193`                                                                                               |
| `mode`                 | `"tui"/"rpc"/"json"/"print"`                                  | `types.d.ts:209`; `docs/extensions.md:994`                                                                        |
| `hasUI`                | `boolean`                                                     | true in TUI **and** RPC; false in json/print — `docs/extensions.md:996-998`                                       |
| `cwd`                  | `string`                                                      | use `CONFIG_DIR_NAME`, not a literal `.pi` — `docs/extensions.md:1004`                                            |
| `sessionManager`       | `ReadonlySessionManager`                                      | **read-only**, 13 methods — `session-manager.d.ts:152`                                                            |
| `modelRegistry`        | `ModelRegistry`                                               | `streamSimple`/`stream` see extension providers — `docs/extensions.md:1045`                                       |
| `model`                | `Model<any> / undefined`                                      |                                                                                                                   |
| `scopedModels`         | `readonly ScopedModel[]`                                      | same set as `/scoped-models` — `types.d.ts:229`                                                                   |
| `thinkingLevel?`       | `ThinkingLevel`                                               |                                                                                                                   |
| `isIdle()`             |                                                               | false during run **or** retry **or** auto-compaction retry **or** queued continuation — `docs/extensions.md:1076` |
| `isProjectTrusted()`   |                                                               | `docs/extensions.md:1018-1022`                                                                                    |
| `signal`               | `AbortSignal / undefined`                                     | defined during turns, usually `undefined` when idle — `docs/extensions.md:1058-1059`                              |
| `abort()`              |                                                               | abort current agent operation                                                                                     |
| `hasPendingMessages()` |                                                               |                                                                                                                   |
| `shutdown()`           |                                                               | deferred to idle in TUI/RPC; **no-op in print** — `docs/extensions.md:1078-1086`                                  |
| `getContextUsage()`    | `{ tokens: number/null, contextWindow, percent } / undefined` | `types.d.ts:194-200`                                                                                              |
| `compact(options?)`    | fire-and-forget                                               | `{ customInstructions?, onComplete?, onError? }` — `types.d.ts:201-205`                                           |
| `getSystemPrompt()`    |                                                               | excludes `context` mutations and payload rewrites — `docs/extensions.md:1123-1130`                                |

### 1.5 `ExtensionCommandContext` — command handlers only

`types.d.ts:255-292`. Session-control methods live here **because they can deadlock from event
handlers** — `docs/extensions.md:1141`.

`getSystemPromptOptions()`, `waitForIdle()`, `newSession({ parentSession?, setup?, withSession? })`,
`fork(entryId, { position?: "before"/"at", withSession? })`,
`navigateTree(targetId, { summarize?, customInstructions?, replaceInstructions?, label? })`,
`switchSession(sessionPath, { withSession? })`, `reload()`.

Each returns `{ cancelled: boolean }`. `navigateTree` **rejects** (does not return
`{cancelled:true}`) when an agent response, compaction, or another navigation is active
— `docs/extensions.md:1230`.

`withSession` receives a `ReplacedSessionContext` (`types.d.ts:298-307`) with async
`sendMessage`/`sendUserMessage` bound to the **replacement** session.

**Tools run with `ExtensionContext`, so they cannot call `ctx.reload()` or any
session-control method.** Documented workaround: register a command that reloads, and a tool
that calls `pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`
— `docs/extensions.md:1357-1387`.

### 1.6 `ExtensionAPI` (the factory argument)

`types.d.ts:911-1090`. Beyond `on`:
`registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `getFlag`,
`registerMessageRenderer`, `registerMarkdownTransformer`, `registerEntryRenderer`,
`sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`,
`setLabel`, `exec`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`,
`setModel`, `getThinkingLevel`, `setThinkingLevel`, `registerProvider`,
`unregisterProvider`, and `events: EventBus` (`types.d.ts:1089`; `event-bus.d.ts:1-4`:
`{ emit(channel, data), on(channel, handler) => unsubscribe }`).

---

## 2. Registering tools

### 2.1 `ToolDefinition<TParams, TDetails, TState>`

`dist/core/extensions/types.d.ts:345-378`:

```ts
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string; // used in LLM tool calls
  label: string; // human-readable UI label
  description: string; // for the LLM
  promptSnippet?: string; // one line in "Available tools"; custom tools are OMITTED without it
  promptGuidelines?: string[]; // bullets appended to the system prompt "Guidelines" while active
  parameters: TParams; // TypeBox
  constrainedSampling?: false | ConstrainedSamplingConfig; // NOT documented in extensions.md
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>; // runs BEFORE schema validation
  executionMode?: ToolExecutionMode; // "sequential" | "parallel" — NOT documented
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?: (args, theme, context: ToolRenderContext) => Component;
  renderResult?: (result, options: ToolRenderResultOptions, theme, context) => Component;
}
```

`defineTool<TParams, TDetails, TState>(tool)` exists purely to preserve parameter inference
when a definition is stored in a variable or array — `types.d.ts:380-387`, exported at
`dist/core/extensions/index.d.ts:10` and `dist/index.d.ts:9`.

### 2.2 Registering

`pi.registerTool(def)` — `types.d.ts:950`. Works **after** startup too (from
`session_start`, command handlers, any event handler); new tools appear in
`pi.getAllTools()` and become LLM-callable without `/reload` — `docs/extensions.md:1408`.

- **Overriding a built-in**: register with the same name; interactive mode shows a warning
  — `docs/extensions.md:2119-2121`. **Renderer inheritance is per-slot**: omitting
  `renderCall` keeps the built-in `renderCall`; omitting `renderResult` keeps the built-in
  `renderResult`; omitting both reuses the whole built-in renderer — `docs/extensions.md:2136`.
- `promptSnippet`/`promptGuidelines` are **not** inherited from a built-in override
  — `docs/extensions.md:2138`.
- **First registration per name wins** across extensions — `runner.d.ts:117`.
- Dynamic enable/disable: `pi.setActiveTools(names)`; unknown names ignored
  — `docs/extensions.md:2412`. Pi persists the tool loadout in the transcript's first system
  message and appends deltas before the next request — `docs/extensions.md:2406`,
  `docs/session-format.md:228`.

### 2.3 Result / renderer attachment

`AgentToolResult<T>` — `pi-agent-core/dist/types.d.ts:337-349`:

```ts
interface AgentToolResult<T = JsonValue | undefined> {
  content: (TextContent | ImageContent)[]; // what the model sees
  details: T; // for UI + state reconstruction
  usage?: Usage; // nested-LLM usage, persisted into session totals
  terminate?: boolean; // end the run after this batch — only if EVERY result sets it
}
```

- `onUpdate(partial)` streams; calls after the promise settles are **ignored**
  — `pi-agent-core/dist/types.d.ts:350-356`.
- **Errors must be thrown, never returned.** `extensions.md:2056`: "Returning a value never
  sets the error flag regardless of what properties you include in the return object."
  `extensions.md:2940`: "Tool `execute` errors must be signaled by throwing."
- `ToolRenderContext` — `types.d.ts:316-341`: `args`, `toolCallId`, `invalidate()`,
  `lastComponent`, `state`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`,
  `expanded`, `showImages`, `isError`.
- `ToolRenderResultOptions` — `{ expanded, isPartial }` — `types.d.ts:309-314`.
- Default shell is a `Box`; `renderShell: "self"` opts out. The default resolves at
  `dist/modes/interactive/components/tool-execution.js:69`:
  `return this.toolDefinition?.renderShell ?? "default"`.
- Slot fallback if a renderer is missing or throws: `renderCall` shows the tool name;
  `renderResult` shows raw text from `content` — `docs/extensions.md:2398-2403`.
- Best practice: `Text` with padding `(0, 0)`; handle `isPartial`; support `expanded`;
  read `context.args` in `renderResult` rather than copying into `context.state`; reuse
  `context.lastComponent` for in-place updates — `docs/extensions.md:2386-2396`.

### 2.4 Argument validation

- `parameters` is **TypeBox**. Use `StringEnum` from `@earendil-works/pi-ai` for string
  enums — `Type.Union`/`Type.Literal` breaks Google's API — `docs/extensions.md:2070`, `2010`.
- `prepareArguments(args)` runs **before** schema validation and before `execute`, to keep
  old resumed sessions working without widening the public schema
  — `docs/extensions.md:2072-2117`.
- Normalize a leading `@` in path arguments — some models emit it; built-ins strip it
  — `docs/extensions.md:1962`.

### 2.5 Concurrency safety for mutating tools

`withFileMutationQueue(filePath, fn)` — `dist/core/tools/file-mutation-queue.d.ts:1-5`,
exported at `dist/index.d.ts:25`. Documented hard requirement at
`docs/extensions.md:1964-1991`: tool calls run in **parallel by default**; without the queue
two tools can read the same old file, compute different updates, and one is lost. Pass the
**resolved absolute** path, not the raw argument; the helper canonicalizes through
`realpath()` for existing files. Queue the **entire read-modify-write window**, not just the
final write.

---

## 3. Built-in tools and reusable factories

### 3.1 The eight built-in tools

`ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls"`
— `dist/core/tools/index.d.ts:23`; `allToolNames: Set<ToolName>` — `:24`.
Overridable set confirmed at `docs/extensions.md:2121`.

| tool         | `create*ToolDefinition(cwd, options)`                   | params                                                                                  | details type                                                                               |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `read`       | `createReadToolDefinition` — `read.d.ts:36`             | `{ path, offset?, limit? }` — `read.d.ts:5-9`                                           | `ReadToolDetails { truncation? }` — `read.d.ts:15-17`                                      |
| `bash`       | `createBashToolDefinition` — `bash.d.ts:85`             | `{ command, timeout? }` — `bash.d.ts:6-9`                                               | `BashToolDetails { truncation?, fullOutputPath? }` — `bash.d.ts:15-18`                     |
| `powershell` | `createPowerShellToolDefinition` — `powershell.d.ts:14` | same as bash (type alias) — `powershell.d.ts:10`                                        | `PowerShellToolDetails = BashToolDetails` — `powershell.d.ts:9`                            |
| `edit`       | `createEditToolDefinition` — `edit.d.ts:41`             | `{ path, edits: [{ oldText, newText }] }` — `edit.d.ts:5-11`                            | `EditToolDetails { diff, patch, firstChangedLine? }` — `edit.d.ts:17-24`                   |
| `write`      | `createWriteToolDefinition` — `write.d.ts:27`           | `{ path, content }` — `write.d.ts:4-7`                                                  | `undefined` — `write.d.ts:27`                                                              |
| `grep`       | `createGrepToolDefinition` — `grep.d.ts:38`             | `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }` — `grep.d.ts:5-13` | `GrepToolDetails { truncation?, matchLimitReached?, linesTruncated? }` — `grep.d.ts:19-23` |
| `find`       | `createFindToolDefinition` — `find.d.ts:39`             | `{ pattern, path?, limit? }` — `find.d.ts:8-12`                                         | `FindToolDetails { truncation?, resultLimitReached? }` — `find.d.ts:18-21`                 |
| `ls`         | `createLsToolDefinition` — `ls.d.ts:38`                 | `{ path?, limit? }` — `ls.d.ts:5-8`                                                     | `LsToolDetails { truncation?, entryLimitReached? }` — `ls.d.ts:14-17`                      |

Also: `createShellToolDefinition(cwd, config, options)` — `bash.d.ts:84`;
`relativizeFindResultPath` — `find.d.ts:7`.
**`AgentTool` variants** (`createReadTool`, `createBashTool`, …) re-exported at
`dist/index.d.ts:19` and `dist/core/sdk.d.ts:71`.

**Aggregate helpers** (`dist/core/tools/index.d.ts:35-42`; not all in `dist/index.d.ts`):
`createToolDefinition`, `createTool`, `createCodingToolDefinitions`,
`createReadOnlyToolDefinitions`, `createAllToolDefinitions`, `createCodingTools`,
`createReadOnlyTools`, `createAllTools`.

**Pluggable operations** (the remote-execution seam) — `docs/extensions.md:2152-2183`:
`ReadOperations` `read.d.ts:22-29` · `WriteOperations` `write.d.ts:17-22` ·
`EditOperations` `edit.d.ts:29-36` · `BashOperations` `bash.d.ts:23-40` ·
`PowerShellOperations` (= Bash) `powershell.d.ts:6` · `LsOperations` `ls.d.ts:22-33` ·
`GrepOperations` `grep.d.ts:28-33` · `FindOperations` `find.d.ts:26-34`.

`createLocalBashOperations({ shellPath? })` — `bash.d.ts:49-51` — lets a `user_bash`
interceptor reuse pi's local shell backend instead of reimplementing spawn / shell resolution /
process-tree termination — `docs/extensions.md:2183`, `917-924`.
`createLocalPowerShellOperations()` — `powershell.d.ts:13`.

`BashToolOptions` — `bash.d.ts:58-69`: `operations`, `commandPrefix`, `shellPath`,
`exposeSessionEnvironment` (default `true`), `spawnHook`.
`spawnHook: (ctx: { command, cwd, env }) => { command, cwd, env }` — `bash.d.ts:52-57`,
`docs/extensions.md:2185-2197`. `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
`PI_MODEL`, `PI_REASONING_LEVEL` are injected **before** `spawnHook`
— `docs/extensions.md:2199`, `docs/environment-variables.md:20-49`.

### 3.2 Truncation helpers

`dist/core/tools/truncate.d.ts`, exported at `dist/index.d.ts:25`:

- `DEFAULT_MAX_LINES = 2000` — `truncate.d.ts:10`
- `DEFAULT_MAX_BYTES` (doc says 50KB / ~10k tokens) — `truncate.d.ts:11`, `docs/extensions.md:2216`
- `GREP_MAX_LINE_LENGTH = 500` — `truncate.d.ts:12`
- `truncateHead(content, { maxLines?, maxBytes? })` — never returns partial lines; if the
  first line exceeds the byte limit it returns empty with `firstLineExceedsLimit: true`
  — `truncate.d.ts:47-54`
- `truncateTail(...)` — for logs/command output; may return a partial first line
  — `truncate.d.ts:55-61`
- `truncateLine(line, maxChars?)` — `truncate.d.ts:62-69`
- `formatSize(bytes)` — `truncate.d.ts:46`
- `TruncationResult` — 11 fields incl. `truncatedBy: "lines"/"bytes"/null`, `totalLines`,
  `totalBytes`, `outputLines`, `outputBytes`, `lastLinePartial`, `firstLineExceedsLimit`
  — `truncate.d.ts:13-36`

**Contract: "Tools MUST truncate their output"**; "Always inform the LLM when output is
truncated and where to find the full version" — `docs/extensions.md:2211`, `2256`.
Both limits are independent; whichever hits first wins — `truncate.d.ts:4-7`.

### 3.3 Renderers, split from implementations

`dist/core/tools/renderers/index.d.ts`:

- `createShellRenderers(prompt)` — `renderers/bash.d.ts:11` (shared by bash + powershell)
- `editRenderers`, `readRenderers`, `writeRenderers`, `grepRenderers`, `findRenderers`,
  `lsRenderers` — `renderers/index.d.ts:18`
- `createAllToolRenderers(): Record<ToolName, ToolRenderers>` — `:20`
- `withBuiltInRenderers(toolName, definition)` — `:27`
- `BASH_UPDATE_THROTTLE_MS = 100` — `renderers/bash.d.ts:9`
- `EditRenderState = { callComponent? }` — `renderers/edit.d.ts:12-14`

Source rationale: importing renderers alone keeps ~17 MB of module graph out of a
rendering-only process — `renderers/index.d.ts:1-7`.

**These are NOT in `dist/index.d.ts`.** Reachable only by deep import into
`dist/core/tools/renderers/index.js`.

### 3.4 Other reusable helpers (all in `dist/index.d.ts`)

`withFileMutationQueue` `:25` · `generateDiffString`/`generateUnifiedPatch`/`EditDiffResult`
`:24` · `CONFIG_DIR_NAME`/`getAgentDir`/`VERSION` `:2` · `parseFrontmatter`/`stripFrontmatter`
`:32` · `keyHint`/`keyText`/`rawKeyHint` `:29` · `renderDiff`/`truncateToVisualLines`
`:29` · `highlightCode`/`getLanguageFromPath`/`getMarkdownTheme`/`getSelectListTheme`/
`getSettingsListTheme`/`initTheme`/`Theme` `:30` · `CustomEditor` `:29` ·
`createSyntheticSourceInfo` `:23` · `convertToLlm` `:11` · `copyToClipboard` `:31` ·
`resizeImage`/`convertToPng` `:33-34` · `createEventBus` `:7` ·
compaction utilities `compact`/`estimateTokens`/`calculateContextTokens`/`findCutPoint`/
`shouldCompact`/`serializeConversation`/`generateSummaryWithUsage`/… `:6` ·
`SessionManager` + entry types `:20` · `SettingsManager` `:21` · `loadSkills`/
`formatSkillsForPrompt` `:22` · `ProjectTrustStore` `:26` · `DefaultResourceLoader` `:18` ·
`getShellConfig`/`getPowerShellConfig` `:36`.

### 3.5 Virtual modules available to extensions

`dist/core/extensions/virtual-modules.js:13-37` — resolved **before** `node_modules`:
`typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox` (+ `/compile`, `/value`),
**`@earendil-works/pi-agent-core`**, `@earendil-works/pi-tui`,
**`@earendil-works/pi-ai` -> `pi-ai/compat`**, `@earendil-works/pi-ai/oauth`,
`@earendil-works/pi-ai/providers/all`, `@earendil-works/pi-coding-agent`, plus legacy
`@mariozechner/*` aliases.

---

## 4. Sessions, agents, dispatch

### 4.1 What an extension can do from inside pi

- **Speak to the live session**: `pi.sendMessage({customType, content, display, details},
{ triggerTurn?, deliverAs? })` — `types.d.ts:977-980`. `deliverAs`:
  `"steer"` (default; after the current assistant turn's tools finish, before the next LLM
  call) / `"followUp"` (only when the agent has no more tool calls) / `"nextTurn"` (queued for
  the next user prompt, triggers nothing) — `docs/extensions.md:1472-1476`.
  Custom messages **do** participate in LLM context (`session-manager.d.ts:97-115`).
- `pi.sendUserMessage(content, { deliverAs?, expandPromptTemplates? })` — always triggers a
  turn; `expandPromptTemplates` defaults **false** — `docs/extensions.md:1478-1506`.
- `pi.appendEntry(customType, data?)` — persists state, **never** sent to the LLM
  (`session-manager.d.ts:71-85`); pair with `pi.registerEntryRenderer` for TUI-only cards
  — `docs/extensions.md:1510-1526`.
- `pi.setLabel(entryId, label)` / `pi.setSessionName(name)` / `pi.getSessionName()`
  — `types.d.ts:993-997`; labels persist and show in `/tree` — `docs/extensions.md:1547-1562`.
- `pi.exec(command, args, { signal, timeout })` -> `{ stdout, stderr, code, killed }`
  — `types.d.ts:999`, `docs/extensions.md:1707-1714`.
- **Inter-extension bus**: `pi.events.on(channel, handler)` / `.emit(channel, data)`
  — `types.d.ts:1089`, `event-bus.d.ts:1-4`.
- **Session replacement** is command-only (§1.5); extensions can veto it via
  `session_before_switch` / `session_before_fork`.

### 4.2 Session identity, directories, resume

- Location: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`, where `<path>`
  has the leading separator removed and `/`, backslash, `:` replaced with `-`
  — `docs/session-format.md:7-11`. Override precedence: `--session-dir` >
  `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` in settings — `docs/settings.md:315`.
- JSONL, append-only **tree**: every entry has `id`/`parentId`; a `leaf` pointer tracks
  position; branching never mutates history — `session-manager.d.ts:188-197`,
  `docs/session-format.md:3`, `343-356`.
- Header: `{ type:"session", version, id, timestamp, cwd, parentSession? }`
  — `session-manager.d.ts:5-12`. `CURRENT_SESSION_VERSION = 3` — `:4`. v3 renamed
  `hookMessage` -> `custom` — `docs/session-format.md:19-27`.
- Statics: `create`, `open`, `continueRecent`, `inMemory`, `forkFrom`, `findById`,
  `list`, `listAll` — `session-manager.d.ts:335-378`.
- Appenders (all return an entry id): `appendMessage`, `appendThinkingLevelChange`,
  `appendModelChange`, `appendUsage`, `appendCompaction`, `appendCustomEntry`,
  `appendSessionInfo`, `appendCustomMessageEntry`, `appendLabelChange`
  — `session-manager.d.ts:232-272`. `appendMessage` **refuses** compaction/branch-summary
  messages (they must be top-level entries) — `:226-231`.
- Tree: `getLeafId`, `getLeafEntry`, `getEntry`, `getChildren`, `getBranch`, `getTree`,
  `branch`, `resetLeaf`, `branchWithSummary`, `createBranchedSession`
  — `session-manager.d.ts:256-329`.
- Context: `buildContextEntries()` (compaction-aware active list) and
  `buildSessionContext()` (what the LLM sees) — `session-manager.d.ts:283-288`,
  `docs/session-format.md:358-379`.
- `ctx.sessionManager` is the **read-only** projection — only
  `getCwd, getSessionDir, getSessionId, getSessionFile, getLeafId, getLeafEntry, getEntry,
getLabel, getBranch, buildContextEntries, getHeader, getEntries, getTree, getSessionName`
  — `session-manager.d.ts:152`.

### 4.3 Spawning sub-agents — the first-party pattern

`examples/extensions/subagent/` ships in the installed package (`index.ts` 35 714 bytes,
`agents.ts`, `README.md`, `agents/*.md`, `prompts/*.md`); referenced at
`docs/extensions.md:3019`. **It is not a pi API — it is a reference implementation of one.**
Its dispatch contract:

- **Process isolation**: one `pi` subprocess per invocation, isolated context window
  — `subagent/README.md:7`, `index.ts:3-5`.
- **Invocation** (`index.ts:300-307`, `344-350`):
  `spawn(argv, ["--mode","json","-p","--no-session", ...])` plus
  `--model <provider/id>`, `--thinking <level>`, `--tools <a,b,c>`, and
  `--append-system-prompt <tempfile>` when the agent declares a system prompt.
  `cwd` is per-task overridable. `shell: false`.
- **Self-resolution of the binary** (`index.ts:249-263`): prefer `process.argv[1]` if it is a
  real file and not a Bun virtual script; else `process.execPath` unless it is a generic
  `node`/`bun`; else bare `"pi"`.
- **Inheritance** (`index.ts:301-306`): if the agent declares no `model`, the dispatching
  session's `ctx.model.provider`/`ctx.model.id` and `ctx.thinkingLevel` are passed through
  (`index.ts:485-488`). **`--thinking` is only inherited when the model is inherited.**
- **Agent definitions** are markdown with YAML frontmatter `{ name, description, tools, model }`
  — `subagent/README.md:126-140`, `agents.ts:11-19`. `tools` accepts both `a, b` and
  `[a, b]` — `agents.ts:53-60`. Discovered from `~/.pi/agent/agents/*.md` and
  `<nearest ancestor>/.pi/agents/*.md` — `agents.ts:116-147`. **Rediscovered on every
  invocation** so agents can be edited mid-session — `subagent/README.md:176`.
- **Stream parsing** (`index.ts:353-388`): line-buffered JSONL; handles
  `event.type === "message_end"` and `"tool_result_end"`; accumulates per-assistant-message
  `usage` into `{ input, output, cacheRead, cacheWrite, cost, contextTokens, turns }`.
- **Abort** (`index.ts:410-420`): `SIGTERM` on `signal.abort`, escalating to `SIGKILL`
  after 5 s; throws `"Subagent was aborted"`.
- **Prompt file hygiene** (`index.ts:239-247`): `mkdtemp`, sanitized filename, mode
  `0o600`, written through `withFileMutationQueue`, unlinked + rmdir in `finally`.
- **Three modes** — `{ agent, task }` single, `tasks[]` parallel (max 8 tasks, 4 concurrent —
  `index.ts:33-34`), `chain[]` sequential with a `{previous}` placeholder
  — `index.ts:459-469`, `README.md:91-98`.
- **Per-task model-visible output cap 50 KB** in parallel mode; full results stay in
  `details` — `index.ts:36`, `README.md:116`, `175`.
- **Security model it self-imposes** — `README.md:55-65`: project-local agents
  (`.pi/agents/*.md`) are repo-controlled prompts; default scope is **user only**; project
  scope requires an explicit `agentScope: "project"/"both"` **and** an interactive confirmation
  when the project is untrusted (`confirmProjectAgents` default `true`, `index.ts:465-467`).
- **Rendering** (`index.ts:723-830`): `renderCall` shows mode + first 3 items;
  `renderResult` builds a `Container` of `Text`/`Spacer`/`Markdown`, with
  `formatToolCall` (`index.ts:71-137`) mimicking built-in formatting
  (`$ cmd`, `read ~/p:1-10`, `grep /pat/ in ~/p`) and a one-line usage strip
  (`index.ts:45-69`).

### 4.4 `AgentHarness` lanes — the sub-agent primitive pi does NOT surface

`@earendil-works/pi-agent-core` ships a full **multi-lane harness**
(`pi-agent-core/dist/harness/agent-harness.d.ts`, 715 lines):

- `AgentHarness.create({ session, models, model, thinkingLevel?, activeToolNames?, tools?,
toolContext?, systemPrompt?, resources?, streamOptions?, retry?, compaction?, steeringMode?,
followUpMode?, toolExecution?: "sequential"|"parallel", toProviderMessages?, entryProjectors? })`
  — `:617-635`
- `harness.lane(name, context)` -> `AgentLane` — `:679-682`, `:636-675`
- `AgentLane`: `accept`/`drive`/`prompt`/`skill`/`promptFromTemplate`/`compact`/
  `navigateTree`/`resume`/`abort`/`steer`/`followUp`/`nextRun`/`cancelQueued`/
  `recordUsage`/`waitForIdle`/`runWhenIdle`/`getModel`/`setModel`/`getThinkingLevel`/
  `setThinkingLevel`/`getActiveTools`/`setActiveTools`/`watch`/`appendMessage`/
  `appendCustomEntry`/`getResult`/`findEntry`/`findEntries`/`getTipId`/`inspectExecution`
  — `:636-675`
- Result types are a discriminated `Result<T, E>` with typed failures
  (`LaneBusy`, `InvalidMessage`, `Closed`, `NothingToResume`, `NoActiveOperation`, …)
  — `:19-42`, `:8`
- `HarnessEventPayload`: 30+ typed events including `run_start`, `run_suspend`,
  `operation_abort` (which returns the **steer/follow-up arrays that were dropped**),
  `retry_scheduled`, `entry_added`, `compaction_start/end`, `navigation_start/end`,
  `lane_created`, `usage`, `fault`, `handler_error` — `:206-420`
- `hooks`: `before_run`, `before_drive`, `before_run_end`, `transform_context`,
  `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`,
  `before_compaction`, `before_navigation` — `:485-604`
- `DriveOutcome` distinguishes `settled` / `waiting(retry)` / `waiting(deferred)`
  — `:109-122`

**Reachability from an extension: yes, but only as a raw import.** It is a virtual module
(`virtual-modules.js:20`), so `import { AgentHarness } from "@earendil-works/pi-agent-core"`
resolves inside an extension. It is **not** re-exported from
`@earendil-works/pi-coding-agent` (`dist/index.d.ts` has no `AgentHarness`), not exposed on
`ExtensionAPI`, and `extensions.md` never mentions it (0 hits). `AgentSession` does not use
it either — `dist/core/agent-session.d.ts` imports only `Agent`, `AgentEvent`,
`AgentMessage`, `AgentState`, `AgentTool`, `ThinkingLevel` from pi-agent-core (`:15`),
and `AgentSessionConfig.agent: Agent` (`:106`) is the older single-agent shape.

Also shipped but unreferenced by the coding-agent docs:
`pi-agent-core/dist/harness/session/` (`fork.d.ts`, `fork-policy.d.ts`, `jsonl/`,
`memory.d.ts`, `gating-storage.d.ts`), `dist/harness/pico3/` (a second experimental
dispatch surface with `kinds/{job,task-api,plugin,tool,collapse,entries,frames,generation,post-tools}`),
and `dist/harness/telemetry.d.ts` (typed spans, `defineTelemetrySchema`).

### 4.5 JSON mode — the wire protocol a dispatcher should use

`docs/json.md`. `pi --mode json "<prompt>"` emits one JSON object per line.

- First line is the session header: `{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"..."}`
  — `json.md:69-73`.
- `JsonAgentSessionEvent` = `AgentSessionEvent` **minus** cumulative snapshots on
  `message_update` — `json.md:11-29`. `message_update` is delta-only, with a top-level
  cumulative `usage` — `json.md:87-92`.
- `AgentSessionEvent` adds over the base `AgentEvent`: `agent_settled`, `queue_update`
  (full steering + follow-up arrays), `compaction_start`, `entry_appended`,
  `session_info_changed`, `thinking_level_changed`, `compaction_end`, `auto_retry_start/end`,
  `summarization_retry_*`, `bash_execution_update`; and widens `agent_end` with
  `willRetry` — `agent-session.d.ts:41-102`.
- Message types: `UserMessage`, `AssistantMessage`, `ToolResultMessage`, plus
  `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`,
  `CompactionSummaryMessage` — `json.md:54-65`, `messages.d.ts:16-59`.

---

## 5. Security model — what `security.md` actually promises

`docs/security.md` is short (59 lines) and unusually explicit.

1. **No trust boundary at all.** "Pi is a local coding agent. It runs with the permissions of
   the user account that starts it, and it treats files writable by that user as inside the
   same local trust boundary." — `security.md:3`
2. **No built-in sandbox.** "Pi does not include a built-in sandbox. Built-in tools can read
   files, write files, edit files, and run shell commands with the permissions of the pi
   process. **Extensions are TypeScript modules that run with the same permissions.**"
   — `security.md:33`. Rationale ("a partial in-process sandbox would be easy to
   misunderstand as a security boundary") — `security.md:35`.
3. **Project trust is an input-loading guard, not a sandbox.** "It is not a sandbox and it
   does not restrict what the model can ask tools to do after you start working in a
   directory." — `security.md:7`. Trust-required resources: `.pi/settings.json`;
   `.pi/{extensions,skills,prompts,themes}`; `.pi/{SYSTEM,APPEND_SYSTEM}.md`;
   `.agents/skills` in cwd or an ancestor. A bare `.pi` directory does **not** require trust
   — `security.md:9-16`.
4. **Decisions** stored by canonical directory in `~/.pi/agent/trust.json`; closest saved
   decision on the current or parent path wins; then `defaultProjectTrust` (default
   `"ask"`) — `security.md:18`. **Context files (`AGENTS.override.md`, `AGENTS.md`,
   `CLAUDE.md`) load regardless of trust** unless context loading is disabled
   — `security.md:27`.
5. **Before trust is resolved**, only context files, user/global extensions, and CLI `-e`
   extensions load; those may handle `project_trust`, and the first yes/no decision owns it
   — `security.md:27`, `docs/extensions.md:368`.
6. **Non-interactive modes** (`-p`, `--mode json`, `--mode rpc`) never prompt. Without a
   saved decision, `"ask"` and `"never"` ignore such resources and `"always"` trusts them.
   `--approve`/`-a` and `--no-approve`/`-na` override for one run — `security.md:29`.
7. **Prompt injection is explicitly out of scope.** "Prompt injection from repository files,
   comments, documentation, context files, or build output is expected local-agent risk and
   cannot be reliably prevented by pi." — `security.md:37`. Behaviour of user-installed
   extensions is outside the security boundary unless there is a real privilege-boundary
   bypass — `security.md:59`.
8. **Recommended containment**: container / VM / micro-VM / remote sandbox / policy-controlled
   sandbox; avoid bind-mounting host `~/.pi/agent`; read-only mounts; minimum credentials
   — `security.md:39-53`, `docs/containerization.md:11-16`.
9. **Packages run with full system access** — `docs/packages.md:20`.

**What an extension must therefore build for itself** (none of it is provided by pi):

- **Approval / permission gating** is a userland pattern, not a pi feature. The mechanism is
  `tool_call` returning `{ block: true, reason?, terminate? }` — `types.d.ts:820-829`,
  `docs/extensions.md:800-840`. `terminate` only takes effect when **every** finalized
  result in the batch is terminating — `types.d.ts:824-828`. `event.input` is mutable in
  place and **no re-validation happens after mutation** — `types.d.ts:720-723`,
  `docs/extensions.md:810-815`.
  Reference: `examples/extensions/permission-gate.ts:13-33` — regex gate on
  `rm -rf`/`sudo`/`chmod 777`, **fail-closed when `!ctx.hasUI`**.
- **Sandboxing** is delegated to an external runtime. `examples/extensions/sandbox/` uses
  `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux) and overrides
  the built-in `bash` tool's `operations` — `examples/extensions/sandbox/index.ts:1-45`.
  `examples/extensions/gondolin/` routes all seven built-in tools **and** `!` commands into
  a micro-VM — `docs/containerization.md:20-44`.
  **Caveat stated by pi itself:** "Extensions run wherever the `pi` process runs. If you run
  host `pi` with a tool-routing extension, other custom extension tools still run on the host
  unless they also delegate their operations." — `docs/containerization.md:18`
- **Protected paths**: `examples/extensions/protected-paths.ts` — same `tool_call` block
  mechanism.
- **Trust boundaries that actually exist**: `ctx.isProjectTrusted()`
  (`docs/extensions.md:1018-1022`), the `project_trust` event, and
  `hasTrustRequiringProjectResources` / `ProjectTrustStore` (exported at
  `dist/index.d.ts:26`).

---

## 6. TUI capabilities

### 6.1 What a renderer can return

Any `Component` from `@earendil-works/pi-tui` (`dist/index.d.ts:1-33`):
`Text`, `Box`, `Container`, `Spacer`, `Markdown`, `Image`, `HStack`/`VStack`,
`SelectList`, `SettingsList`, `Loader`, `CancellableLoader`, `Input`, `Editor`,
`ScrollView`, `MouseRegion`, `TruncatedText`; plus `renderLatex`, `Marked`/tokens,
`visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi`/`sliceByColumn`,
`highlightCode` (from coding-agent, `dist/index.d.ts:30`), and OSC-8 hyperlinks.

`Component` contract — `docs/tui.md:14-21`:

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

`Focusable` (IME) adds `focused: boolean`; TUI scans output for `CURSOR_MARKER` to place the
hardware cursor — `docs/tui.md:33-57`. Containers holding an `Input`/`Editor` must propagate
focus or the IME candidate window lands in the wrong place — `docs/tui.md:59-87`.

### 6.2 Limits pi itself imposes

- **Hard width rule**: "Each line from `render()` must not exceed the `width` parameter."
  — `docs/tui.md:25`, `328-330`. Use `truncateToWidth` / `wrapTextWithAnsi`.
- **Styles do not cross lines** — the TUI appends a full SGR + OSC-8 reset at the end of every
  rendered line; reapply per line or use `wrapTextWithAnsi()` — `docs/tui.md:31`.
- **Images** need Kitty / iTerm2 / Ghostty / WezTerm / Warp — `docs/tui.md:273-284`; gated by
  `showImages`, `imageWidthCells`, `images.autoResize` / `images.blockImages`
  (`settings-manager.d.ts:32-44`). `ToolRenderContext.showImages` reports the current state
  to renderers — `types.d.ts:337`.
- **Mouse**: only in fullscreen mode; regular mode does not capture mouse because the terminal
  owns scrollback — `docs/tui.md:326`.
- **Hardware cursor hidden by default**; opt in with `showHardwareCursor` or
  `PI_HARDWARE_CURSOR=1` — `docs/tui.md:57`, `docs/environment-variables.md:90`.
- **`invalidate()` must clear theme-baked caches**, not just memoized lines — pre-baked ANSI
  survives a cache clear — `docs/tui.md:524-530`.
- **Fallback on a missing or throwing renderer**: name only / raw text
  — `docs/extensions.md:2398-2403`.
- **Tool output expansion** is a single global boolean: `ctx.ui.getToolsExpanded()` /
  `setToolsExpanded()` — `types.d.ts:190-192`. Renderers must handle both states.
- **Output pad**: `MessageRenderOptions.outputPad` (`types.d.ts:883`), from the
  `outputPad: 0 | 1` setting — `settings-manager.d.ts:117`.
- **Performance**: cache rendered output per width; call `invalidate()` on state change then
  `tui.requestRender()` — `docs/tui.md:496-522`, `939-949`.

### 6.3 Mode availability

| capability                                                                                      | `tui` | `rpc`                                        | `json` | `print`                                |
| ----------------------------------------------------------------------------------------------- | ----- | -------------------------------------------- | ------ | -------------------------------------- |
| `hasUI`                                                                                         | true  | **true**                                     | false  | false — `docs/extensions.md:2944-2949` |
| `select/confirm/input/editor`                                                                   | yes   | via `extension_ui_request` sub-protocol      | no-op  | no-op                                  |
| `custom()` components                                                                           | yes   | **returns `undefined`**                      | no-op  | no-op                                  |
| `setWorkingMessage/setWorkingIndicator/setFooter/setHeader/setEditorComponent/setToolsExpanded` | yes   | **no-ops**                                   | no-op  | no-op                                  |
| `getEditorText()` / `getToolsExpanded()` / `getAllThemes()` / `getTheme()`                      | real  | `""` / `false` / `[]` / `undefined`          | —      | —                                      |
| `pasteToEditor()`                                                                               | real  | delegates to `setEditorText()` (no collapse) | —      | —                                      |
| `setTheme()`                                                                                    | real  | `{ success: false, error }`                  | —      | —                                      |

— `docs/rpc.md:1184-1205`, `docs/extensions.md:2942-2951`.
**Guard terminal-only features with `ctx.mode === "tui"`, not `ctx.hasUI`.**

### 6.4 Out-of-tool-result UI surfaces

`ctx.ui` (`types.d.ts:69-193`) also offers: `onTerminalInput(handler)`,
`setStatus(key, text)`, `setWorkingMessage`, `setWorkingVisible`,
`setWorkingIndicator({ frames, intervalMs })` (empty `frames` hides it),
`setHiddenThinkingLabel`, `setWidget(key, string[] | factory, { placement })`,
`setFooter(factory)`, `setHeader(factory)`, `setTitle`, `pasteToEditor`,
`setEditorText`/`getEditorText`, `editor(title, prefill)`,
`addAutocompleteProvider(factory)`, `setEditorComponent(factory)`/`getEditorComponent()`,
`notify(msg, "info"|"warning"|"error")`, theme access, and
`custom<T>(factory, { overlay?, overlayOptions?, onHandle? })`.
Overlays support `anchor`, `width`/`height` as `SizeValue`, `margin`, and
`handle.{focus, unfocus, setHidden, hide}` — `docs/extensions.md:2788-2806`.
Dialogs accept `{ timeout }` (auto-dismiss with countdown) or `{ signal }` (AbortSignal)
— `docs/extensions.md:2549-2598`.

---

## 7. Compaction / context management

- **Trigger**: `contextTokens > contextWindow - reserveTokens`. `reserveTokens` default
  **16384**, `keepRecentTokens` default **20000** — `docs/compaction.md:31-35`, `412-416`.
  `enabled` default `true` — `:414`. Per-model `modelOverrides` keyed by exact
  `"provider/modelId"` — `:420-442`; type at `settings-manager.d.ts:8-13`.
- **Checked**: after tools finish and their results are appended, before the next assistant
  response; also before a new user prompt and after a low-level run ends
  — `docs/compaction.md:37`. Skipped between turns when the completed tool batch terminates
  the run and no queued message needs another response.
- **Algorithm**: walk backwards accumulating token estimates to `keepRecentTokens`; extract
  from the previous kept boundary; summarize with the previous summary as iterative context;
  append `CompactionEntry`; rebuild — `docs/compaction.md:43-47`.
- **Tool results are pruned by span, not individually.** Everything before
  `firstKeptEntryId` is replaced by one summary message. Cut points may be user, assistant,
  BashExecution, or custom messages; **never at tool results** ("they must stay with their tool
  call") — `docs/compaction.md:113-119`.
- **Split turns**: a single turn exceeding `keepRecentTokens` cuts mid-turn at an assistant
  message; pi generates **two** summaries (history + turn prefix) and merges them
  — `docs/compaction.md:83-109`.
- **Repeated compaction** starts from the previous compaction's `firstKeptEntryId`, not from
  the compaction entry, and `tokensBefore` is recalculated from the rebuilt context
  — `docs/compaction.md:81`.
- **Tool-result truncation during summarization only**: results are truncated to **2000
  characters** with a marker; that is a _serialization-for-summary_ limit, distinct from the
  50 KB / 2000-line runtime tool limit — `docs/compaction.md:271`.
- **No tool-result offloading to files** is documented anywhere. The only file-adjacent
  behaviour is `BashToolDetails.fullOutputPath` (`bash.d.ts:17`), the `OutputAccumulator`
  temp-file spill (`output-accumulator.d.ts:1-51`, opened when full output must be preserved),
  and the temp-file pattern the docs recommend to extension authors
  (`docs/extensions.md:2239-2246`).
- **Structured summary format** is fixed (Goal / Constraints / Progress / Key Decisions /
  Next Steps / Critical Context + `<read-files>`/`<modified-files>`)
  — `docs/compaction.md:217-255`. File ops accumulate across compactions and nested branch
  summaries — `:181-187`. **Not replaceable** by an extension — only the _summary text_ is.
- **Extension levers**: `session_before_compact` returns `{ cancel }` or a whole
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`
  — `types.d.ts:862-865`, `docs/compaction.md:301-311`. `details` is a free-form slot for
  extension state (`session-manager.d.ts:51`, `docs/compaction.md:139-146`;
  `session_before_tree` has the analogue at `types.d.ts:866-879`).
- **Overflow recovery** is `reason: "overflow"` + `willRetry: true` on
  `SessionBeforeCompactEvent` / `SessionCompactEvent` / `SessionCompactFailedEvent`
  — `types.d.ts:449-476`. Manual compaction **never** retries the interrupted turn
  — `agent-session.d.ts:551-553`.
- **Prompt cache**: compaction and branch-summary requests use fresh routing session IDs and
  disable prompt-cache writes where supported — `docs/compaction.md:23`. Extensions can veto
  warming via `cache_warming_decision` — `types.d.ts:925`, `docs/extensions.md:741-758`.
- **Micro-compaction / per-tool-result summarization: not found** in the installed docs or
  `.d.ts`.

---

## 8. Extension packaging / distribution

### 8.1 The `pi` manifest

`docs/packages.md:118-131`:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/shot.png"
  }
}
```

- Paths are relative to the package root; arrays support **globs and exclusions** (with a
  leading `!`); positive globs discover **visible** paths in lexical order; dot-prefixed paths
  must be listed directly; symlinked resource roots must be listed directly
  — `packages.md:133`.
- `keywords: ["pi-package"]` is for gallery discoverability — `:118`, `:137`.
- `video` is MP4-only, autoplays on hover on desktop; `image` accepts PNG/JPEG/GIF/WebP;
  video wins — `:151-154`.
- **Convention directories** used when no manifest is present: `extensions/` loads `.ts` and
  `.js`; `skills/` finds `SKILL.md` folders and top-level `.md`; `prompts/` loads `.md`;
  `themes/` loads `.json` — `packages.md:160-165`.
- Discovery locations for unpackaged extensions: `~/.pi/agent/extensions/*.ts`,
  `~/.pi/agent/extensions/*/index.ts`, `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts`
  (project ones only after trust) — `docs/extensions.md:115-121`; plus
  `settings.json` `"extensions"` — `docs/settings.md:345`.
- Filtering: object form in settings; omit a key = load all, empty array = load none,
  `!pattern` excludes, `+path`/`-path` force include/exclude an exact path; filters
  **narrow** what the manifest allows — `packages.md:190-216`.
- Deduplication: project entry wins unless `autoload: false`, which applies as a delta
  — `packages.md:222-228`; `PackageSource` type — `settings-manager.d.ts:70-77`.
- CLI: `pi install npm:|git:|https:|ssh:|<path>`, `pi remove`, `pi list`, `-e` for a
  temporary trial install, `-l` to write to project settings — `packages.md:22-50`.

### 8.2 Bundling / externals — the hard rule

Quoting `docs/packages.md:171`: pi bundles core packages for extensions and skills. If you
import any of these, list them in `peerDependencies` with a `"*"` range **and do not bundle
them**: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

- Other pi packages **must** be bundled: `dependencies` + `bundledDependencies`, referenced
  through `node_modules/` paths — `packages.md:173-188`.
- Non-pi third-party runtime deps go in `dependencies`; pi runs `npm install` for installed
  packages — `packages.md:169`.
- Install is `npm install --omit=dev` by default, so `devDependencies` are unavailable at
  runtime — `docs/extensions.md:150`.
- "Pi loads packages with separate module roots, so separate installs do not collide or share
  modules." — `packages.md:173`
- **Bundler config (minify, sourcemaps, externals, format): not found** anywhere in the
  installed docs. pi does not prescribe a build tool. The shipped packages are built with
  `tsgo` (`pi-coding-agent/package.json:41`) and hand-rolled `bun build` for the compiled
  binary (`:44`) — those are pi's own build scripts, not guidance for extension authors.
  `docs/development.md:76-80` describes only a `npm run check:package-install` smoke test and
  a `npm run check` that "rejects excluded development sources pulled into a package's build
  through imports."

---

## 9. Capabilities a PTC-style port could plausibly have missed

1. **Dynamic tool loadout with transcript-backed deltas.** Register N tools, keep a loader
   active, call `pi.setActiveTools()` mid-execution; the model sees the updated list on the
   _immediately following_ request. pi diffs prompt sections and tool sets and persists the
   transition in the transcript — `docs/extensions.md:2404-2514`, `docs/session-format.md:228`.
2. **`terminate: true`** to end the run after a structured-output tool — only honoured when
   _every_ result in the batch sets it — `pi-agent-core/dist/types.d.ts:344-348`,
   `docs/extensions.md:2042-2044`, `2058`.
3. **`prepareArguments`** — a version-migration shim running _before_ schema validation, so
   old resumed sessions keep working without widening the public schema
   — `docs/extensions.md:2072-2117`, `types.d.ts:362-363`.
4. **`promptSnippet` / `promptGuidelines`** — the only supported way to change what the model
   is told about a tool. Without `promptSnippet` a custom tool is **omitted from the
   "Available tools" section entirely** — `docs/extensions.md:1956-1958`, `types.d.ts:352-355`.
5. **Structured system-prompt surgery** via `before_agent_start`'s mutable
   `systemPromptOptions` — change `sections`, `selectedTools`, or `promptGuidelines` and pi
   emits a **delta system message** preserving the cached prefix; only `systemPrompt` /
   `forceSystemPrompt` costs a cache miss — `docs/extensions.md:566`,
   `system-prompt.d.ts:5-44`, `70`.
6. **Per-slot renderer inheritance on tool override** — wrap `read` for access control and
   keep syntax highlighting for free — `docs/extensions.md:2136`.
7. **`renderShell: "self"`** for tools that need stable framing after settling
   — `types.d.ts:360-361`, `docs/extensions.md:2285`, `2396`.
8. **`withFileMutationQueue`** — mandatory for any mutating custom tool, since tool calls run
   in parallel by default — `docs/extensions.md:1964-1991`, `file-mutation-queue.d.ts:1-5`.
9. **Pluggable Operations on every built-in tool** — delegate reads/writes/exec/search to
   SSH, a container, or a micro-VM without reimplementing pi's built-ins; plus `spawnHook`
   and `createLocalBashOperations()` for `user_bash`
   — `docs/extensions.md:2152-2207`, `bash.d.ts:49-69`.
10. **`agent_settled`** — the only event meaning "pi will not do anything else
    automatically". `agent_end` explicitly does not (`extensions.md:572`)
    — `types.d.ts:561-563`.
11. **`ui_prompt_start` / `ui_prompt_end`** — lets an extension report "waiting for user"
    instead of "running" — `types.d.ts:564-578`, `docs/extensions.md:586-602`.
12. **`pi.events` event bus** for inter-extension messaging — `types.d.ts:1089`,
    `event-bus.d.ts:1-4`.
13. **`deliverAs: "nextTurn"`** — a third delivery mode that neither interrupts nor triggers a
    turn — `docs/extensions.md:1475`.
14. **`appendEntry` + `registerEntryRenderer`** — durable, branch-aware, TUI-only state that
    never touches LLM context; plus the documented recommendation to store branching-sensitive
    state in tool-result `details` — `session-manager.d.ts:71-85`,
    `docs/extensions.md:1510-1526`, `1657-1675`, `1920-1949`.
15. **`pi.setLabel`** — persistent, restart-surviving bookmarks on session-tree entries
    — `docs/extensions.md:1547-1562`, `session-manager.d.ts:86-91`.
16. **`before_provider_headers` mutates headers in place; null deletes** — the clean
    injection point for tracing/session attribution, and it does **not** re-fire on retry
    — `types.d.ts:524-532`, `docs/extensions.md:690-706`.
17. **`cache_warming_decision`** — an extension can veto prompt-cache warming; a "stop"
    action ends it until the next real request — `types.d.ts:925`, `docs/extensions.md:741-758`.
18. **`registerMarkdownTransformer`** — a synchronous, display-only Markdown hook with
    `availableWidth` and `isStreaming`; a throw keeps prior output and continues the chain
    — `types.d.ts:885-890`, `docs/extensions.md:1636-1655`.
19. **`registerFlag` + `getFlag`** — an extension can add a CLI flag (`--plan`, `--ssh`,
    `--no-sandbox`) — `types.d.ts:958-969`, `docs/extensions.md:1690-1705`.
20. **`registerShortcut`** with an injected `KeybindingsManager` and `keyHint()` helpers that
    respect the user's keybinding config — `types.d.ts:954-957`, `docs/extensions.md:2357-2384`.
21. **The first-party `subagent` example** is a complete, shipped reference for
    process-isolated dispatch: abort escalation, temp-file prompt hygiene (mode 0600),
    usage accumulation, trust-scoped agent registry — `examples/extensions/subagent/`,
    `docs/extensions.md:3019`.
22. **`AgentHarness` lanes in `@earendil-works/pi-agent-core`** — a named-lane abstraction
    with its own transcript tip, operation admission, typed error results, `DriveOutcome`,
    30+ typed events, and 11 hooks. It is a **virtual module**, so an extension can import it
    today, but it is invisible in `extensions.md` and in the coding-agent barrel
    — `pi-agent-core/dist/harness/agent-harness.d.ts:617-715`, `virtual-modules.js:20`.
23. **`executionMode: "sequential"` per tool** — declare a tool that must not run
    concurrently with siblings — `types.d.ts:364-371`, `pi-agent-core/dist/types.d.ts:370-377`.
    **Undocumented in `extensions.md`.**
24. **`constrainedSampling`** — a provider-side constrained-sampling request per tool
    — `types.d.ts:358-359`. **Undocumented in `extensions.md`.**
25. **`AgentTool.replay?: "never" | "safe"`** — recovery policy for an effect whose durable
    intent exists but whose outcome is unknown — `pi-agent-core/dist/types.d.ts:368-369`.
    **Not surfaced on `ToolDefinition` and not documented in `extensions.md`.**
26. **Renderers ship separately from implementations** — a render-only process can import
    `createAllToolRenderers()` and avoid ~17 MB of module graph — `renderers/index.d.ts:1-7`.
27. **Async extension factories are awaited before `session_start`** — the documented slot
    for remote config or model discovery at startup — `docs/extensions.md:181-218`.
28. **`pi -e` trial install** and `pi config` enable/disable, for testing a package before
    committing to it — `packages.md:45-50`, `218-220`.
29. **The extension is a real dependency, not a shim.** `AgentSession` is itself built on
    pi-agent-core's `Agent` — `agent-session.d.ts:15`, `:106` — so the agent loop, retry,
    steering, and compaction semantics behind the events are all the harness's.

---

## 10. Doc vs .d.ts disagreements (findings in their own right)

| #   | disagreement                                                                                                                                        | doc                                                                                                                                                                                                               | .d.ts / code                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `isError` is not a field of the value `execute()` returns, and the doc says returning it does nothing — yet the shipped subagent example returns it | `docs/extensions.md:2056`: "Returning a value never sets the error flag regardless of what properties you include in the return object."                                                                          | `AgentToolResult` has no `isError` (`pi-agent-core/dist/types.d.ts:337-349`) **but** `examples/extensions/subagent/index.ts:707` returns `isError: true`                                                                                    |
| D2  | `CompactionEntry` / `BranchSummaryEntry` field types                                                                                                | `docs/compaction.md:130-131`, `:197-198`: `parentId: string`, `timestamp: number`                                                                                                                                 | `session-manager.d.ts:17-22`: `parentId: string / null`, `timestamp: string` (ISO) — agrees with `docs/session-format.md:201-207`                                                                                                           |
| D3  | `sm.getPath()`                                                                                                                                      | `docs/sdk.md:847`: `const path = sm.getPath();`                                                                                                                                                                   | **not declared** in `session-manager.d.ts` nor present in `session-manager.js`; the equivalent is `getBranch()` (`:278`)                                                                                                                    |
| D4  | Importable packages for extensions                                                                                                                  | `docs/extensions.md:141-146` lists only `pi-coding-agent`, `typebox`, `pi-ai`, `pi-tui`                                                                                                                           | `packages.md:171` and `virtual-modules.js:13-37` also provide `@earendil-works/pi-agent-core`, `typebox/compile`, `typebox/value`, `@sinclair/typebox`, `pi-ai/oauth`, `pi-ai/providers/all`, and legacy `@mariozechner/*` aliases          |
| D5  | `executionMode` and `constrainedSampling` on `registerTool`                                                                                         | **absent from `extensions.md`** (0 hits for `executionMode`, `ToolExecutionMode`, `constrainedSampling`)                                                                                                          | `types.d.ts:358-371` declares both                                                                                                                                                                                                          |
| D6  | Aggregate tool builders                                                                                                                             | not in `docs/`                                                                                                                                                                                                    | `dist/core/tools/index.d.ts:35-42` exports `createToolDefinition`, `createTool`, `createCodingToolDefinitions`, `createReadOnlyToolDefinitions`, `createAllToolDefinitions`, `createAllTools` — deep import only, not via `dist/index.d.ts` |
| D7  | Built-in renderers                                                                                                                                  | not in `docs/`                                                                                                                                                                                                    | `dist/core/tools/renderers/index.d.ts:10-27` exports `createAllToolRenderers`, `withBuiltInRenderers`, and the six per-tool renderer sets                                                                                                   |
| D8  | `ReplacedSessionContext` is documented as part of the API (`docs/extensions.md:1292`)                                                               | `dist/core/extensions/index.d.ts:9` exports the type, but `dist/index.d.ts:8` **omits** it from the root re-export list, so `import type { ReplacedSessionContext } from "@earendil-works/pi-coding-agent"` fails |

---

## Appendix — Sources

Base: `<repo>/node_modules/@earendil-works/`

**pi-coding-agent 0.86.1**

- `package.json` (exports map, `files`, deps; `"@earendil-works/pi-agent-core": "^0.86.1"` at :56)
- `dist/index.d.ts` (1-36) — 36-line re-export barrel
- `dist/core/extensions/types.d.ts` (1-1360) — the extension contract
- `dist/core/extensions/index.d.ts` (1-11)
- `dist/core/extensions/runner.d.ts` (1-181)
- `dist/core/extensions/loader.d.ts` (1-23)
- `dist/core/extensions/wrapper.d.ts` (1-19)
- `dist/core/extensions/virtual-modules.js` (1-37) · `.d.ts` (1-2)
- `dist/core/agent-session.d.ts` (1-724)
- `dist/core/session-manager.d.ts` (1-379)
- `dist/core/sdk.d.ts` (1-107)
- `dist/core/system-prompt.d.ts` (1-71)
- `dist/core/messages.d.ts` (1-59+)
- `dist/core/event-bus.d.ts` (1-8)
- `dist/core/settings-manager.d.ts` (1-180) — `Settings` at 78-131
- `dist/core/tools/index.d.ts` (1-43)
- `dist/core/tools/{read,bash,edit,write,grep,find,ls,powershell}.d.ts`
- `dist/core/tools/truncate.d.ts` (1-70)
- `dist/core/tools/file-mutation-queue.d.ts` (1-6)
- `dist/core/tools/path-utils.d.ts` (1-10)
- `dist/core/tools/render-utils.d.ts` (1-24)
- `dist/core/tools/output-accumulator.d.ts` (1-52)
- `dist/core/tools/tool-definition-wrapper.d.ts` (1-14)
- `dist/core/tools/renderers/index.d.ts` (1-28) · `bash.d.ts` · `edit.d.ts`
- `dist/modes/interactive/components/tool-execution.js:69` (renderShell default)
- `docs/extensions.md` (1-3037) — 109-152, 154-271, 273-982 (lifecycle 277-349, startup
  351-368, resources 370-387, session 389-526, agent 528-758, model 760-796, tool 798-897,
  user bash 899-931, input 933-982), 984-1137, 1139-1387, 1389-1916, 1918-1950, 1952-2515,
  2516-2934, 2936-2940, 2942-2951, 2953-3037
- `docs/security.md` (1-59)
- `docs/packages.md` (1-228)
- `docs/compaction.md` (1-444)
- `docs/session-format.md` (1-480)
- `docs/tui.md` (1-961)
- `docs/sdk.md` (1-1226)
- `docs/json.md` (1-98)
- `docs/rpc.md` (1-1618; extension UI 1184-1205)
- `docs/containerization.md` (1-156)
- `docs/environment-variables.md` (1-100)
- `docs/settings.md` (1-428; tools 285-303, session dir 315, models 321)
- `docs/development.md` (1-90)
- `docs/usage.md` (1-312; CLI flags 191-245)
- `examples/extensions/subagent/{README.md,index.ts,agents.ts}`
- `examples/extensions/permission-gate.ts` (1-33)
- `examples/extensions/sandbox/index.ts` (1-70+)
- `examples/extensions/tools.ts` (1-60+)
- `examples/extensions/plan-mode/index.ts`
- `examples/sdk/*.ts`, `examples/plugins/pi-example-plugin/*`

**pi-agent-core 0.86.1** (transitive; `node_modules/.pnpm/@earendil-works+pi-agent-core@0.86.1_…`)

- `package.json` (exports incl. `./harness/session`, `./harness/context`, `./experimental/pico3`)
- `dist/index.d.ts` (1-28)
- `dist/types.d.ts` (1-420+) — `ToolExecutionMode`:26, `QueueMode`:33, `AgentToolResult`:337-349,
  `AgentToolUpdateCallback`:350-356, `AgentTool`:358-378, `AgentEvent`:393+
- `dist/harness/agent-harness.d.ts` (1-715)
- `dist/harness/{context,result,events,hooks,types}.d.ts`, `dist/harness/session/*`,
  `dist/harness/pico3/*`

**pi-tui 0.87.0**

- `dist/index.d.ts` (1-33) — full export list
- `dist/components/*` (34 components)
- `dist/tui.d.ts`, `dist/keybindings.d.ts`, `dist/keys.d.ts`, `dist/utils.d.ts`,
  `dist/terminal-image.d.ts`

**pi-ai 0.86.1**

- `package.json` (exports incl. `./compat`, `./oauth`, `./providers/*`, `./api/*`, `./utils/*`)
- `dist/index.d.ts`, `dist/compat.d.ts`, `dist/models.d.ts`, `dist/types.d.ts`

**Host project** (read only, for version confirmation)

- `<repo>/package.json` — :44-48 deps, :63-77 peerDeps,
  :78-83 `pi.extensions`

**Not read, by instruction**: the host project's `src/`, README, docs, `AGENTS.md`, `CONTEXT.md`.
