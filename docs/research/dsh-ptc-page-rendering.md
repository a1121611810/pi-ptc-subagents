# DSH: what the page shows while a PTC program is running

Investigated 2026-09-23 while deciding what pi-ptc's PTC row should render during a `ptc_run_code`
or `ptc_workflow` run, and how it should look after the program returns. The DSH web client is
the only published reference implementation of PTC UI; nothing is visible on the model side
until after the program completes (the `deferContext` channel is purely a model-context
mechanism, see `docs/research/dsh-ptc-image-hoisting.md`).

## Sources

- `https://github.com/deepseek-ai/deepseek-harness` — **now reachable from this machine.**
  Pulled the master tarball (~27 MB) into `/tmp/dsh-research/deepseek-harness-master`; the
  sources below are read from that snapshot. This is a different evidence path than the sibling
  note (which used `registry.npmmirror.com` packages at `@deepseek-ai/dsh-*@0.1.6-alpha.1`),
  because the UI / renderer code is in the `packages/client/*` packages of the repo and is NOT
  shipped to npm — the published `@deepseek-ai/dsh-client-web` builds bundle the compiled JS
  but the React source is in the repo only.
- The earlier sibling sources (`@deepseek-ai/dsh-tools@0.1.6-alpha.1`,
  `@deepseek-ai/dsh-ptc-runtime@0.1.6-alpha.1`, `@deepseek-ai/dsh-workflow-ptc@0.1.6-alpha.1`,
  and `snapshots/web/ptc-round/*` golden files in the repo) were cross-referenced for parity.
- Repo default branch: `master`. Description (from `gh repo view`):
  `"DeepSeek Harness: Everything is a Plugin."` Single-context PR review only.

## Findings

The DSH UI distinguishes a PTC run from a regular tool call at **two levels**: (1) the **process
header** above the turn — a single button that summarises what the agent is doing in plain
English and pulses while work is in flight, and (2) the **tool row itself**, which renders with
a dedicated `code` variant and always-visible nested sub-rows. Neither surface ever streams
`console.log` output from the PTC program body during the run — only structured results from
each binding call are surfaced, and the program's own return value shows up only after the
run settles.

### A. The "process header" — what the page shows above the tool rows

1. **PTC maps to a dedicated `code` activity category** — `packages/client/ui-chat/src/client/conversation-nodes/process-activity.ts:7–19`. The function `activity(name)` is the lookup; line 12: `if (name === 'run_code') return 'code'`. `bash` / `pwsh` / `exec_command` all collapse to `'commands'` (line 11), `read*` collapses to `'read'` (line 8). So a single PTC run is one activity (code); a PTC run that calls `bash` three times is still one `code` activity, plus three `commands` dispatches nested under it.

2. **The header button label while in-flight** — `packages/client/ui-chat/src/client/locale.ts:171`, key `message.stepProcess.code`, English value `'Running code'`. (Sibling categories: `read`→`'Reading files'`, `search`→`'Searching code'`, `commands`→`'Running commands'`, etc.) The header is built at `packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx:104`: `const label = data.closed ? processTitle(data.summary, t) : t(`message.stepProcess.${live.activity}`)` — while the group is `closed: false` it shows the _running_ title; once closed it switches to the past-tense title.

3. **The header button label after the turn completes** — `packages/client/ui-chat/src/client/locale.ts:183`, key `message.stepProcess.done.code`, value `'Ran code'`. The closed-state title is composed by `processTitle()` at `packages/client/ui-chat/src/client/chat/step-process.ts:11–27`, which joins up to three categories with a comma and a trailing `, etc.` if there are more. The text shown in the golden file `snapshots/web/ptc-round/ui.expected.md:13` — `"Ran code, ran commands, read files"` — is `processTitle` joining `code` (from the PTC run itself), `commands` (from the `bash` sub-call), and `read` (from the `read` sub-call).

4. **The header is a shimmer-pulsing button while live** — `ChatGroupSeat.tsx:117` `<TextShimmer active={!data.closed} className={css.label}>{title}</TextShimmer>`. `TextShimmer` is a moving highlight (a CSS keyframe), not a spinner; the title text stays put and the highlight travels across it. The minimum display time per title is 150 ms (`ChatGroupSeat.tsx:27` `PROCESS_TITLE_MINIMUM_MS`, see `useStableLiveProcessTitle` at line 55) so titles do not flicker as state churns.

5. **An icon rides next to the title text** — `ChatGroupSeat.tsx:36–49` `PROCESS_ICONS` table; `code: <IconCodeOutlineRegular size={14} />` at line 42. Other categories use `IconApiOutlineRegular` (commands), `IconBrowseOutlineRegular` (read), etc. So even before any text reads, the user sees the code/angle-bracket glyph next to the pulsing label.

6. **The `liveDetail` (after the colon) is one-line task detail extracted from args** — `process-activity.ts:21–39` `normalizeLiveToolDetail` clamps to 160 graphemes; the key preference list at lines 23–26 ranks `title, description, objective, task, task_name, name, question, questions, prompt, message, command, cmd, queries, query, pattern, url, uri, file_path, path, target, action, status`. For a `run_code` call whose first-ranked key is `description`, the header reads `Running code: <description>`. If no tool is running, `liveReasoningDetail()` (`process-activity.ts:51–66`) falls back to the latest assistant reasoning paragraph.

7. **Turn-level status badge** — `locale.ts:205–208`: `'Worked'` / `'Failed'` / `'Took {duration}'` / `'Deep diving for {duration}'`. `ui.expected.md:11–12` shows both: `status: Worked` (a visually-hidden label announced to AT) and `button "Took {{duration}}" [expanded]`. The expanded duration pill is independent of the activity header — the activity title is the "what", the duration pill is the "how long".

### B. The "tool row" — what the page shows for the `run_code` call itself

8. **PTC has its own variant** — `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:18` declares `type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'`. Line 64 maps the wire name: `run_code: 'code'`. Every other tool falls into one of the other six buckets or `'others'`.

9. **The code variant's summary is the `description` argument** — `tool-call-model.ts:175`: `code: ['description']` in `SUMMARY_KEYS`. The summary derivation at lines 180–194 picks the first non-empty string from those keys; if the PTC call was issued with no `description` arg, it walks all string-valued args. The golden file `ui.expected.md:15` shows the row text `"Code Run bash echo and catch missing file read"` — `"Code"` is the variant title (locale `tool.title.code`, line 34), and the rest is the description that came in as the `description` argument.

10. **The variant title is `Code`** — `VARIANT_TITLE_KEYS` at `tool-call-model.ts:32–36` maps `code: 'tool.title.code'`. Verified at `packages/client/ui-tool/tests/chat-ptc-subcalls.client.spec.tsx:161`: `expect(view.getByText('Code')).toBeTruthy()`.

11. **Running-state chrome** — `tool-call-model.ts:241` derives `state: ToolRowState` from the block shape: `const state: ToolRowState = !done ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'`. While the program is in flight the row is `'running'`. The CSS attribute is set at `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:335`: `<div ... data-variant={variant} data-tool={toolName} data-state={state}>`. Tests confirm: `tests/chat-ptc-subcalls.client.spec.tsx:251` `expect(running).not.toBeNull()` where `running = ...querySelector('[data-variant="code"][data-state="running"]')`.

12. **The summary text is also a shimmer while running** — `ToolRow.tsx:212, 222, 226` wrap the summary (and the title, and the suffix) in `<TextShimmer active={running}>...`. So while the PTC program is in flight, the row reads "Code" + description, and both halves shimmer in lockstep with the process-header shimmer.

13. **The expanded body of the code row is the program source** — `tool-call-model.ts:222–225`: when `variant === 'code'`, `formatToolBody` returns `parsed.code` (the `code` field of the args) instead of the whole args JSON envelope. The body is rendered through `CodeBlock` with `lang="typescript"` at `ToolRow.tsx:289–293`. The row is expandable (it has a body) but is collapsed by default — the test `tests/chat-ptc-subcalls.client.spec.tsx:200–214` shows clicking the row exposes `<pre class="shiki">` containing the program source.

14. **Output section appears next to the program body once the run returns** — `ToolRow.tsx:295–314` (`ioCard`): if the program returned a result, the row's expanded view shows two stacked sections labelled (locale `row.input` / `row.output`) — the input section is suppressed for the `code` variant (`ToolRow.tsx:199` `const cardBody = variant === 'code' ? null : bodyText`), so the program body fills the upper part and the return value (flattened text) fills the lower part. This matches `snapshots/web/ptc-round/trajectory.expected.md:7–15`, where the trajectory's "Output" tab shows the JSON-shaped return value as a `<tree>` (TreeItem widget).

15. **Per-variant icon and styling** — `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` (sibling of `ToolRow.tsx`) supplies the variant-specific class hooks. The `data-variant` / `data-state` attributes are the public contract that CSS uses; tests pin the rendered attribute (`tests/chat-ptc-subcalls.client.spec.tsx:159`, `:251`, `:269`, and `tests/tool-row.client.spec.tsx:506,528,541,554`).

### C. Sub-calls — what the page shows inside the PTC row

16. **Sub-calls are always visible** — `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:77`: `<div className={css.subCalls} data-subcalls>` is mounted whenever `block.subCalls.length > 0`. It is **not** inside the disclosure; even when the PTC row is collapsed, the sub-call rows render underneath. This is pinned by the test at `tests/chat-ptc-subcalls.client.spec.tsx:106`: `const nest = page.locator('[data-subcalls]').first(); await nest.waitFor()` (no `expand` step before it). The behaviour is asserted at the `data-subcalls` selector regardless of parent row's `aria-expanded`.

17. **Each sub-call uses its own row variant** — `ToolCallTree.tsx:62–95` recurses through `block.subCalls`, mounting a fresh `ToolCall` for each. The wire name of the sub-call (e.g. `bash`, `read`, `grep`) feeds back through `classifyTool` at `tool-call-model.ts:92–94` into the same `TOOL_VARIANTS` table — so a `bash` sub-call is rendered with `data-variant="bash"`, a `read` sub-call with `data-variant="read"`, and so on. Cross-referenced: `tests/chat-ptc-subcalls.client.spec.tsx:166` `expect(nest!.querySelector('[data-sample="bash"]')).not.toBeNull()`.

18. **Some sub-call tool views register a dedicated sample with `data-sample="<name>"`** — `packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx:93` sets `data-sample="bash"` and `data-variant="bash"` together. The `data-sample` is a hook for tests / quick targeting; the variant drives the chrome. Other variants reuse the generic `ToolRow` and don't add a `data-sample` attribute (only `data-variant` + `data-state`).

19. **Bash sub-calls get a terminal card inline** — `bash-sample.tsx:115–124`: when expanded, the row reveals a `TerminalBlock` with the recorded stdout/stderr lines. `ui.expected.md:16–17` shows this in the snapshot: `button "Bash Echo CODE_ROUND_OK" [expanded]` then `text: Done workspace echo CODE_ROUND_OK` — the bash tool's recorded stdout rendered inside the terminal card.

20. **Sub-calls inherit `running` / `error` states independently** — verified at `tests/chat-ptc-subcalls.client.spec.tsx:216–224` (`sub-call with isError=true renders with data-state="error"` at the nested level) and `:258–271` (a `grep` sub-call issued but not yet settled gets `data-state="running"` while the parent `run_code` is also still running). So each sub-row wears its own lifecycle state, and a failing sub-call shows red even if the parent `run_code` ultimately returns OK.

21. **Failed sub-calls render the same error row chrome as a failed native call** — `tool-call-model.ts:181–182`: `const settledWithCue = state === 'error' || state === 'stopped'`; `:218–220` adds `css.errorSummary` / `css.stoppedSummary` class hooks; `:172` `failureLine = state === 'error' ? errorSummary ?? normalSummary : null`; the collapsed summary switches to the first line of the error. Golden: `ui.expected.md:21–22` shows `text: Failed` followed by `button "Read Error: cannot read \"{{cwd}}/workspace/missing.txt\": not found"` — the read tool's error message becomes the row's collapsed summary.

22. **The wire events that produce a sub-call row** — `apps/web/tests/ptc-round.e2e.ts:69–96` (`the durable log carries run_code with full-content sub-dispatches`) asserts that the session log carries `tool/ptc-dispatch-start` and `tool/ptc-dispatch` events with `rootCallId` = the `run_code` call's id, `parentCallId` = same on the first level / nested id on deeper levels, and a `content` array carrying the binding's text/image/etc. blocks. The UI builds the `block.subCalls` tree from these events; a `start` event yields a `RunningToolCall` row, the matching `dispatch` (settle) event replaces it with a `ToolResultNode` row. See `packages/client/ui-chat/src/client/contract/chat-nodes.ts:116–127` (`isSettledTool` / `isRunningTool`) for the discriminant.

### D. Trajectory view — the post-hoc inspector

23. **Clicking the PTC row opens the trajectory view, which has its own Code tab** — `apps/web/tests/ptc-round.e2e.ts:156–195` walks the flow: click the `run_code` row → trajectory tab opens with tabs `[Summary, Code, Output, Schema, Timing]`. The Code tab is the source code (with Wrap lines / Original JSON / Copy buttons); the Output tab is the return value as a JSON tree. `snapshots/web/ptc-round/trajectory.expected.md:7–15` shows the Output tab as a `<tree>` named `"Result JSON"` with `treeitem` rows per property.

24. **The Code tab label is determined per-record** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:999–1006`: when `codeProgram(record.cell) !== undefined` (i.e. this is a `run_code` call), the second tab's `labelKey` is `'code.source'`; otherwise it's the generic `'tab.payload'`. The trajectory view also adds a Code-bracket icon to `run_code` rows in the list (`TrajectoryTable.tsx:1114` `<IconCodeOutlineRegular className={css.programIcon} size={12} />`).

25. **`code-program.ts` is the per-record extractor** — `packages/client/ui-trajectory/src/client/code-program.ts:47–62` resolves `{rawInput, source, description, arguments, language}` from the recorded tool arguments and schema. The schema text is regex-matched (`recordedLanguage` at lines 31–40) for "TypeScript" or "Python" to drive syntax highlighting. PTC programs in `code-mode` (TypeScript) and `code-mode-python` (Python) both render through this path.

### E. Things the page does **NOT** show

26. **No streaming `console.log` output from the program body** — `process-activity.ts` only tracks named tool calls (`tool.call.toolview`); there is no `console.log` event type in the wire format. The runtime hooks `console.log` (visible in `packages/ptc-runtime/ptc-runtime-node/src/`) and pipes the lines into the program's collected `logs` array, which is part of the program's return value (or the result envelope) and only flows to the model — not to the page. The page surfaces `console.log` only by accident, if a binding call (`bash`, `read`) happens to include those bytes in its own `content` blocks.

27. **No "Running PTC program" indicator separate from the row chrome** — there is exactly one visual signal that the program is in flight: the `data-state="running"` + `TextShimmer` on the row and its parent header (Findings 4, 12). There is no per-program progress bar, no step counter, no elapsed-time spinner attached to the row itself; the duration pill (Finding 7) is part of the surrounding turn header, not the tool row.

28. **No "intermediate" / streaming row for partial results** — `ToolCallTree.tsx` only mounts a sub-row when a `tool/ptc-dispatch-start` event has been emitted. Until a sub-call actually starts, the PTC parent row stands alone with its description and `data-state="running"`.

29. **No "Inspect" affordance on the parent row by default** — `ToolRow.tsx:93, 318–327`: the `inspect` button is only shown when an `inspectCall` callback was wired in. In the chat context it is wired in (`ToolCallTree.tsx:33`), so the user can jump to the trajectory Code tab. In the trajectory context (which IS the trajectory view) it is not.

## What I could not establish

- **Whether DSH caps the height of the sub-call nest visually** — `ToolCallTree.tsx` recurses without bound; if a PTC program issues 1000 binding calls, the nest is 1000 rows tall. I found no max-depth / virtualization hint in the code or in the e2e tests. The `chat-ptc-subcalls` tests only assert up to depth 2 (a code parent → sub-calls).

- **Whether the Code-block expanded body is collapsed by default in all viewports** — `ToolRow.tsx:139` `useDisclosure()` is the React Aria pattern with no policy argument visible at this layer; the chat-default collapse behaviour comes from a presentation-policy provider (`usePresentation` is mentioned at `ChatGroupSeat.tsx:98` for `liveProcessDetail`, but the tool-row disclosure is a local one). I did not trace which presentation policy controls it.

- **Behaviour when the PTC program errors** — the rendered row's `state` becomes `'error'` and the `output` slot carries the error message, but I did not find an e2e snapshot covering a `run_code` whose **own** execution threw (vs. a sub-call that threw). The model-facing path (`exec.deferContext` for hoisted images) is documented in `docs/research/dsh-ptc-image-hoisting.md`; the row-side path is not pinned by an existing golden.

- **Exact threshold for the "etc." truncation in `processTitle`** — `step-process.ts:27` says `summary.counts.length > 3` triggers `{title}, etc.`; the live activity (`running` field) is not subject to truncation, only the closed summary is. Whether the live activity is constrained to a single category or can show multiple `Running code, running commands` is **not implemented** — line 100 of `ChatGroupSeat.tsx` says `activity: data?.summary.running ?? 'thinking'`, which is a single value, not an array. So while live, the user sees at most one activity; after closing, the user sees up to three.

- **What happens to `console.log` lines that the program writes _before_ any sub-call starts** — by rule 26 those never reach the page. The page has no UI affordance to expose them (no "show logs" toggle, no body-card). This is consistent with the model-side contract (only the return value + final logs go to the model) but it means the human user is blind to console output entirely.

## Implications for pi-ptc

The DSH UI design resolves three things pi-ptc's PTC row has to handle. Mirroring the design (rather than improvising) keeps users who have used both harnesses oriented.

1. **Give `ptc_run_code` and `ptc_workflow` a dedicated row variant in `renderCall` / `renderResult`**, distinct from the existing bash / read / grep variants. DSH's mechanism is a per-tool-name table at `tool-call-model.ts:47–74`; pi-ptc's row picker (`renderCall.ts` in `src/mode/`) can do the same — `ptc_run_code` and `ptc_workflow` → `code` variant, every other tool → the existing branch. The variant drives the icon, the row colour, and the summary string. The summary is taken from `args.description` (DSH's `SUMMARY_KEYS.code` = `['description']` at `tool-call-model.ts:175`), not from the program source.

2. **Render sub-tool calls as nested rows under the PTC row, always visible (not gated by expansion)**. DSH's seam is `data-subcalls` (`ToolCallTree.tsx:77`) mounting sibling rows under the PTC parent even when the parent is collapsed. pi-ptc's `details.subCalls` (or the equivalent in the PTC payload assembled by `runPtcProgram`) should drive this. The sub-rows carry their own `running` / `ok` / `error` state, and a failing sub-call shows red even if the parent returns OK. The status badge per sub-row maps naturally onto pi-ptc's `bindingStatus` shape.

3. **Pulse the row text while the program is in flight**. DSH uses a `TextShimmer` (a moving highlight, not a spinner) on both the row summary and the process-group header above it (`ToolRow.tsx:212,222,226`; `ChatGroupSeat.tsx:117`). pi-ptc's TUI can use a `█`-trailing suffix or a `▓▒░` shimmer glyph on the title and summary fields while `state === 'running'`. The minimum-display-time of 150 ms (DSH's `PROCESS_TITLE_MINIMUM_MS`) is also worth borrowing if pi-ptc ever shows a live activity title that updates mid-run.

Two more things to consider, less load-bearing:

- **Add an "Inspect" / "Code" affordance on the code-variant row that jumps to a dedicated tab showing the program source and the return value as JSON**. DSH's trajectory view (`TrajectoryTable.tsx:999–1006`) gives `run_code` its own `code.source` tab label distinct from the generic `tab.payload`; pi-ptc's `details.code` field already carries the program source separately from the args envelope, so this is a free upgrade.
- **A running turn header that says "Running code" / "Ran code"** (DSH `message.stepProcess.code` / `message.stepProcess.done.code` at `locale.ts:171,183`). pi-ptc currently does not expose this layer at all; the closest analogue is the TUI's top-of-turn chip. Adding a one-line "Running <tool>" headline while a binding row is in flight (and a past-tense "Ran code" when it settles) would close the gap with DSH's chat-header UX without needing the process-group bookkeeping DSH has.
