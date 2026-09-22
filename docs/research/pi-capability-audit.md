# Audit: our code vs pi's extension API

Written 2026-09-22 after the DSH image-hoisting work raised the question _"isn't pi natively supporting
this — why are we implementing it ourselves?"_. Method: read pi 0.87's `docs/extensions.md` (API list at
"ExtensionAPI Methods", events chapter), `dist/index.d.ts` exports, and `dist/core/tools/*` for how the
built-ins behave; then walk this package's `src/` and ask, per feature, whose job it is.

## The rule

Maximize what pi already provides; hand-roll only where pi has no surface — and when we do, say why in
the code and (if it is a decision) in an ADR. A second implementation of something pi ships is a bug
waiting to drift.

## pi's surfaces we use (nothing reimplemented)

| Feature                                      | pi surface                                                                                    | Where we use it                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Tool definition, schema, snippet, guidelines | `pi.registerTool` + `defineTool`                                                              | `src/tools/run-code.ts`, `workflow.ts`                        |
| TUI rendering                                | `renderCall` / `renderResult` + `@earendil-works/pi-tui` (`truncateToWidth`, `visibleWidth`)  | `src/tools/render.ts`                                         |
| Tool loadout narrowing                       | `pi.getActiveTools()` / `setActiveTools()`                                                    | `src/mode/ptc-mode.ts`                                        |
| The bound tools themselves                   | `createReadTool` … `createLsTool` + `validateToolArguments`                                   | `src/runtime/bindings.ts`                                     |
| System-prompt sections                       | `pi.on("before_agent_start")` → `event.systemPromptOptions.sections`                          | `src/index.ts` (skills restoration, ADR-0011)                 |
| Mode briefing                                | `before_agent_start` handler returning `{ message: { customType, content, display: false } }` | `src/index.ts`                                                |
| Command, status, notifications               | `pi.registerCommand`, `ctx.ui.setStatus/notify/theme`                                         | `src/index.ts`                                                |
| Durable mode record                          | `pi.appendEntry` + `ctx.sessionManager.getEntries`                                            | `src/index.ts`                                                |
| Model context edits                          | `context` / `context_with_system` events (0.87)                                               | not needed — `sections` is the lighter seam for _adding_ text |
| Config location                              | `getAgentDir()`                                                                               | `src/mode/ptc-mode.ts`                                        |
| Images in tool results                       | `AgentToolResult.content` image blocks, per-model `inputLimits.images.resize`                 | `src/tools/common.ts` (ADR-0014)                              |
| Output truncation                            | `truncateTail` / `formatSize` / `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`                     | `src/tools/common.ts` (ADR-0015)                              |

## What is ours because pi has no surface for it

| Ours                                                                            | Why pi cannot do it                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The code-mode runtime: fresh `worker_threads`, wire protocol, dispatch, budgets | pi ships no `run_code` tool at all (0.87 built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`). DSH's identical machinery is what we are matching.                                                                                                                                                                                          |
| Nested-call provenance (image hoisting)                                         | Bindings call `tool.execute()` directly — by design, ADR-0005 — so pi's `tool_execution_*` events never fire for them and its agent loop never sees the nested result. Something must lift the images into the outer tool result; DSH does the same (`exec.deferContext`). If pi ever exposes a nested-dispatch or "attach context after a run" seam, this collapses. |
| ANSI/binary sanitisation of the model-facing text                               | pi sanitises _inside_ each built-in tool (`core/tools/render-utils.js`, `bash-executor.js`) and exports neither helper; the agent loop does not sanitise extension tool results. Upstream ask: export `stripAnsi`/`sanitizeBinaryOutput`.                                                                                                                             |
| The char-based per-line cap (ADR-0012/0015)                                     | pi's `truncateLine` is byte-based; 200 bytes ≈ 66 CJK characters, which is not the readability we want. Four lines, reason recorded in ADR-0015.                                                                                                                                                                                                                      |
| Reading the _default-mode_ config, loadout snapshots, mode entry policy         | pi has no "mode" concept beyond `setActiveTools`; the snapshot exists because narrowing the loadout would otherwise empty our own binding table.                                                                                                                                                                                                                      |
| DSH-parity limits (64 MiB output, 128 pending calls, timeouts)                  | Numbers come from DSH's resolver (R1 §3), not from pi.                                                                                                                                                                                                                                                                                                                |

## What we deliberately did **not** take from pi

- **`pi.sendUserMessage([…images])` / `pi.sendMessage({content: […images]})`** for the hoist
  (ADR-0014). Both accept image content, and the prototype in
  `docs/research/prototype-image-delivery-ab/` measured what they really do: called from inside a tool
  execute, a steer-queued message lands in the _same_ LLM request as the tool result with **no extra
  turn**, and `sendMessage` reaches the provider as a **user** message exactly like `sendUserMessage`
  (its `customType`/`display` are local concerns). Rejected because the tool result keeps provenance
  (one call = one result), is what pi's own `read` does, and does not share the steer queue.
- **`context_with_system`** for the skills section and briefing: it hands over the whole transcript
  (system message included) and expects the handler to keep index 0 valid — a heavier hammer than
  writing `systemPromptOptions.sections`, the seam pi documents for adding a section.
- **`tool_result` handlers** for anything we do: our results are already built correctly at the source;
  a middleware pass would only split one decision across two places. (It remains the right hook for
  _other_ extensions that want to post-process a PTC result.)

## Upstream asks this audit produces

1. Export the text sanitisation helpers (`stripAnsi`, `sanitizeBinaryOutput`) — an extension that
   assembles its own tool-result text currently has to mirror them (ADR-0012).
2. A nested-dispatch or "attach context to this tool execution" seam — the PTC image hoist and any
   future nested-result feature would then use pi instead of re-deriving it.
