# DSH Ground Truth — How PTC results and tool calls are presented

**Axis:** presentation / rendering only. Source of truth: the extracted package tree under
`/tmp/dsh-src/`. Every claim below cites `path:line` relative to `/tmp/dsh-src`.
Where a fact lives in a package that is **not** in the extraction, this document says
**"not found in source"** rather than inferring it.

The extracted `lib/*.js` files are _bundled_ output (rolldown/rollup `//#region` blocks
preserve the original module paths in comments), so line numbers refer to the bundle.

---

## 0. Packages in scope

| Package                        | Bundled entry                  | Lines       |
| ------------------------------ | ------------------------------ | ----------- |
| `dsh-agent-tool-presentation`  | `lib/index.js`                 | 51          |
| `dsh-client-ui-tool`           | `lib/client.js`                | 4581        |
| `dsh-client-ui-trajectory`     | `lib/client.js`                | 8777        |
| `dsh-client-ui-workflow-run`   | `lib/client.js`                | 662         |
| `dsh-client-ui-subagent`       | `lib/client.js`                | 988         |
| `dsh-attachment`               | `lib/index.js` + `lib/types/*` | 344 + types |
| `dsh-attachment-local`         | `lib/index.js`                 | 1079        |
| `dsh-compaction-image-offload` | `lib/index.js` + `lib/types/*` | 154 + types |

`dsh-file-reference/` and `dsh-file-reference-local/` **do not exist** in `/tmp/dsh-src`
(verified: `ls: dsh-file-reference: No such file or directory`). Nothing to report on them.

---

## 1. The full render pipeline for a tool call / PTC run

DSH has **two independent display surfaces** for the same durable events, with **no shared
renderer**:

- **Trajectory** — a virtualized ledger table (developer view). `target: "trajectory"`.
- **Chat conversation** — a nested disclosure tree (user view). `target: "chat"`.

Both consume the same wire event family, but they build their own models.

### 1.1 Wire events

| Event                     | Payload fields read by the UI                                                                           | Citation                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tool/call`               | `data.callId`, `data.name`, `data.arguments`, `data.turn`, `data.step`                                  | `dsh-client-ui-trajectory/lib/client.js:1650-1662`              |
| `tool/result`             | `data.message.source.callId`, `data.message.content`, `data.message.isError`, `data.error`, `data.meta` | `dsh-client-ui-trajectory/lib/client.js:1663-1686`              |
| `tool/ptc-dispatch-start` | `data.rootCallId`, `data.parentCallId`, `data.subCallId`, `data.name`, `data.arguments`                 | `dsh-client-ui-trajectory/lib/client.js:1689-1701`, `1834-1851` |
| `tool/ptc-dispatch`       | same + `data.content`, `data.isError`, `data.error`                                                     | `dsh-client-ui-trajectory/lib/client.js:1702-1720`              |

The PTC dispatch pair is **envelope-checked**: `rootCallId`/`parentCallId`/`subCallId` must
be non-empty, a sub-call's root may never change, and a parent must already belong to the
declared root — otherwise the invariant plugin fails the event
(`dsh-tools/lib/types/invariant.js:23-38`, `dsh-tools/lib/invariant.js:18-32`).

### 1.2 Trajectory pipeline (event -> ledger row)

**Stage A — Event Definition -> view node.**
`trajectoryToolDefinition` matches the four event types, mapping them to a _root call id_
with role `start`/`update` (`dsh-client-ui-trajectory/lib/client.js:1831-1883`).

- `tool/call` starts the definition (`:1650-1662`, `:1852-1860`).
- `tool/result` **replaces** the root entry with a settled `tool-result` block (`:1861-1872`).
- Both `tool/ptc-dispatch*` events run through `updateDispatch` (`:1748-1771`), which
  maintains three maps: `calls` (id -> block), `children` (parent -> ordered child ids),
  `parents` (child -> parent).

**Stage B — Tree projection.** `projectCall` (`:1780-1816`) recursively rebuilds the block
tree, stamping a synthetic interrupted result (`isError: true`, `error: {name:"Interrupted",
code:"interrupted"}`) onto any call that never settled once its enclosing step/turn closed
(`:1798-1815`, boundary computed at `:1775-1778`).
Cycle/edge admission is `acceptsEdge` (`:1720-1746`): self-loops, already-parented re-parenting
and cycles are rejected, and the combined parent-chain + subtree depth is capped by `MAX_DEPTH`.

`buildViewNode` (`:1873-1882`) wraps the result as
`trajectoryNode(context, seq, { kind: "tool", root })` -> `{ key, kind, id, target:"trajectory",
anchorSeq, location, data }` (`:503-514`).

**Stage C — Snapshot.** `TrajectorySnapshotBuilder` (`:1509-1647`) holds `nodes`, `positions`
and an ordered `contributions` list. `apply()` (`:1520-1531`) replaces a node in place and only
rebuilds ordering when a node is new or its `anchorSeq` moved (`structural` flag). Tool
contributions are split into `finalized` (settled) vs `runningCalls` (live) at `:1590-1591`.
The tool schema visible _at call time_ is captured per `callId` by `captureSchemas`
(`:1459-1465`) and shipped as `callSchemas` (`:1622`).

**Stage D — Layout projection -> cells.** `deriveTrajectoryLayout` (`:7398-7716`) folds the
snapshot into `turn -> group -> cell` rows. Per tool cell it produces:

```
{ index, kind: "tool" | "subtool", callId, text, previewMarkdown,
  inputDetail, outputDetail, outputBlocks,
  result, resultPreviewMarkdown, isError,
  timeSeconds, startedAt, toolName, schemaDetail }
```

(`summarizeCall` `:8102-8108`, `summarizeResult` `:8109-8117`, `detailResult` `:8125-8133`,
`attachToolSchema` `:7771-7776`.)

**Stage E — Virtualization.** `groupTrajectoryVirtualRows` (`:3731-3758`) attaches
separator-only records to the next content row so the virtualizer never owns a zero-height
item, and assigns a fixed measured height per row (`:3712-3714`). Virtualization turns on above
`VIRTUALIZATION_THRESHOLD` records (`:3996`).

**Stage F — Row render.** `TrajectoryTable` (`:3991-6576`) renders one `<tr data-kind=...>` per
cell. For a tool row the cell text is split on the first `" · "` into **name** and **args**
(`toolCallTextParts` `:4636-4649`, rendered by `RecordListText` `:4679-4698`); a `run_code` row
additionally gets a `IconCodeOutlineRegular` and the `programSummary` typeface
(`:4683-4689`). `recordDisplayText` (`:4622-4635`) for a PTC program emits
`` `${PTC_TOOL_NAME} · ${description}` `` (`:4623-4624`).

**Stage G — Detail pane.** Selecting a row opens a right-hand pane with a resizable width
(`DETAILS_MIN_WIDTH`/`MAX_WIDTH`/resize step, `:4102-4105`) and a tab set built per cell
(`:4568-4617`): `overview`, `payload` (or **`code.source`** when a `run_code` program is
present, `:4605`), `result` (present when `outputDetail` exists _or_ a program exists,
`:4607-4610`), `schema`, `timing`.

### 1.3 Chat pipeline (event -> nested disclosure)

**Stage A' — keyed dispatch.** `dsh-client-ui-tool` registers one `conversation.chat.node`
renderer keyed `tool-call`, whose **child slot** `tool.call.toolview` is `kind: "keyed"`,
`scope: "session"` (`dsh-client-ui-tool/lib/client.js:4552-4563`). The host `home` directory is
injected as a hook purely so POSIX home can render as `~` (`:4542-4546`).

**Stage B' — tree walk.** `ToolCallTree` (`:1904-1926`) reads `node.data.root` (`:1917`) and
hands it to `ToolCallBranch` (`:1868-1902`), which normalizes the block's phase
(`toolCallPhase` `:1804-1814`; `result` / `preparing` / `start`).

**Stage C' — per-call keyed dispatch.** `ToolCall` (`:1819-1866`) resolves the wire name
(`callName` `:1817-1819`), then calls
`renderSlot("tool.call.toolview", owner, { entryKey: toolName, hookContext, fallback: <GenericToolCard/> })`
(`:1862-1865`). **A keyed hit replaces the generic row; a miss falls back to `GenericToolCard`**
— that is the only dispatch path.

**Stage D' — row model.** `toolRowModel` (`:273-295`) is the shared row derivation:

- `classifyTool` / `toolTitleKey` pick the variant and locale key from `TOOL_VARIANTS`
  (`:83-100`) and `TOOL_TITLE_KEYS` (`:102-149`).
- `state` = `preparing | running | stopped | error | ok`, where `stopped` is exactly
  `error.code === "interrupted"` (`:278`).
- `summary` = `"<title> · <abbreviatedSummary>"`, with the path relativized to the session cwd
  and home-`~`-abbreviated (`:279-280`, helpers `relativizeToCwd` `:56-61`,
  `abbreviateHomePath` `:41-49`).
- `output` = `resultText(block)` (`:179-185`): text blocks verbatim, every other block shape
  `JSON.stringify(block, null, 2)`, joined with `\n`; an **empty** content on a failed call
  falls back to `${error.name}: ${error.code}` (`:183`).

**Stage E' — first-party card selection.** `GenericToolCard` (`:1757-1785`) derives, in order:
`toolRowModel` -> `terminalCardModel` -> `readCardModel` -> `diffCardModel` -> `searchCardModel` ->
`webCardModel`, then promotes `ok` to `error` when a terminal card reports a failing exit
(`:1768`, `terminalFailed` `:769-772`). Each of these returns `null` (generic path) unless the
block's _shape_ validates — the code is a strict narrowing of opaque persisted data.

**Stage F' — `ToolRow`.** `ToolRow` (`:1500-1740`) is the single row shell. Card precedence is
first-non-null (`:1519`):
`askQuestion > terminal > diff > read > image > search > web > details > generic IO card`.

- `expandable = state !== "preparing" && (inputRaw || outputText || card)` (`:1518`) — a
  preparing row is never expandable.
- Collapsed row: 2x2 dot separator + shimmer-wrapped summary + optional suffix
  (`:1550-1590`).
- Expanded row renders the chosen card lazily, memoized on `open` (`:1591-1716`).

**Stage G' — primitives.** Card bodies delegate to `@deepseek-ai/dsh-client-ui-primitives`
(`TerminalBlock`, `DiffBlock`, `ReadBlock`, `SearchBlock`, `WebBlock`, `CodeBlock`,
`JsonTree`, `DisclosureRow`, `StateDot`, `TextShimmer`, `MarkdownText`). **Those packages are
not in the extraction** — their own line-windowing / "+N more" arithmetic is
**not found in source**. What the client package does do is _set_ the window (see section 3).

### 1.4 Pipeline, one line per stage

```
tool/call ---------+
tool/result -------+--> trajectoryToolDefinition.match/start/update --> {root, subCalls[]}
ptc-dispatch* ------+          |
                             |-- TRAJECTORY --> buildViewNode {kind:"tool",root} --> SnapshotBuilder
                             |                 (finalized | runningCalls | callSchemas)
                             |                 --> deriveTrajectoryLayout --> cells (kind tool|subtool)
                             |                 --> groupTrajectoryVirtualRows --> <tr> --> detail pane tabs
                             |
                             `-- CHAT --> ToolCallTree(node.data.root) --> ToolCallBranch
                                      --> renderSlot("tool.call.toolview", key=toolName)
                                         |-- hit  -> toolview row (BashRow / ReadRow / ReadImageRow /
                                         |           SearchRow / WebRow / FileMutationRow /
                                         |           DetailsRow / QuestionToolRow / todo)
                                         `-- miss -> GenericToolCard
                                                       --> ToolRow --> DisclosureRow
                                                             `--> primitive card (maxLines=N)
```

---

## 2. Display bounds — every constant table

### 2.1 Trajectory / ledger geometry

| Constant                               | Value                                     | Bounds                                                                            | File:line                                                                                        |
| -------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MAX_DEPTH`                            | `256`                                     | total parent-chain + subtree depth of a PTC dispatch tree                         | `dsh-client-ui-trajectory/lib/client.js:1649`                                                    |
| `CONTENT_ROW_HEIGHT`                   | `30`                                      | px, measured height of one ledger content row                                     | `dsh-client-ui-trajectory/lib/client.js:3712`                                                    |
| `COLLAPSED_SUMMARY_HEIGHT`             | `20`                                      | px, measured height of a fold-summary row                                         | `dsh-client-ui-trajectory/lib/client.js:3713`                                                    |
| `TERMINAL_BOUNDARY_HEIGHT`             | `9`                                       | px, height of a trailing request-boundary spacer row                              | `dsh-client-ui-trajectory/lib/client.js:3714`                                                    |
| `PREVIEW_SOURCE_CHARACTERS`            | `2048`                                    | chars of source text fed into Markdown-to-plain extraction for a one-line preview | `dsh-client-ui-trajectory/lib/client.js:3762`                                                    |
| `PREVIEW_OUTPUT_CHARACTERS`            | `512`                                     | chars kept from the compacted preview, then an ellipsis is appended               | `dsh-client-ui-trajectory/lib/client.js:3763`                                                    |
| `BOTTOM_FOLLOW_THRESHOLD_PX`           | `2`                                       | px from bottom that keeps auto-follow pinned                                      | `dsh-client-ui-trajectory/lib/client.js:3993`                                                    |
| `OLDER_LOAD_THRESHOLD_PX`              | `48`                                      | px from top that triggers older-history paging                                    | `dsh-client-ui-trajectory/lib/client.js:3994`                                                    |
| `HISTORY_LOAD_ROW_HEIGHT_PX`           | `30`                                      | px, the injected "load older" row height                                          | `dsh-client-ui-trajectory/lib/client.js:3995`                                                    |
| `VIRTUALIZATION_THRESHOLD`             | `100`                                     | record count above which the virtualizer engages                                  | `dsh-client-ui-trajectory/lib/client.js:3996`                                                    |
| `VIRTUAL_OVERSCAN_ROWS`                | `12`                                      | overscan rows above/below the viewport                                            | `dsh-client-ui-trajectory/lib/client.js:3997`                                                    |
| `VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX`   | `600`                                     | px, estimated pre-measure viewport height                                         | `dsh-client-ui-trajectory/lib/client.js:3998`                                                    |
| `DETAILS_MIN_WIDTH`                    | `320`                                     | px, min width of the detail pane                                                  | `dsh-client-ui-trajectory/lib/client.js:4102`                                                    |
| `DETAILS_MAX_WIDTH`                    | `720`                                     | px, max width of the detail pane                                                  | `dsh-client-ui-trajectory/lib/client.js:4103`                                                    |
| `TABLE_MIN_WIDTH`                      | `280`                                     | px, min width of the ledger table                                                 | `dsh-client-ui-trajectory/lib/client.js:4104`                                                    |
| `DETAILS_RESIZE_STEP`                  | `16`                                      | px per drag step when resizing the detail pane                                    | `dsh-client-ui-trajectory/lib/client.js:4105`                                                    |
| `TOOL_REQUEST_SHARE`                   | `.58`                                     | fraction of the pane a tool's request column takes while dragging                 | `dsh-client-ui-trajectory/lib/client.js:4106`                                                    |
| `TOOL_REQUEST_MIN_WIDTH`               | `180`                                     | px, min request-column width                                                      | `dsh-client-ui-trajectory/lib/client.js:4107`                                                    |
| `TOOL_REQUEST_MAX_WIDTH`               | `480`                                     | px, max request-column width                                                      | `dsh-client-ui-trajectory/lib/client.js:4108`                                                    |
| `DEFAULT_TOOL_REQUEST_SHARE`           | `.36`                                     | default request-column fraction of the content width                              | `dsh-client-ui-trajectory/lib/client.js:4109`                                                    |
| `DEFAULT_TOOL_REQUEST_OFFSET`          | `56`                                      | px offset backing the default request column                                      | `dsh-client-ui-trajectory/lib/client.js:4110`                                                    |
| `collapsedStringLines`                 | `12` (inline) / `3` (in a section)        | JSON-tree string lines kept before collapsing                                     | `dsh-client-ui-trajectory/lib/client.js:5388` (also `:4507`, `:4534`, `:5157`, `:5179`, `:5219`) |
| `.resultPreview` grid                  | `clamp(180px, calc(36cqw - 56px), 480px)` | CSS request-column width inside a result preview                                  | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| `.details` width                       | `clamp(320px, 38%, 440px)`                | CSS detail-pane width                                                             | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| `.kindTagLabel`                        | `max-width:72px`                          | CSS cap on the kind tag label                                                     | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| `.turnLabelFull` / `.turnLabelCompact` | `max-width:64px`                          | CSS cap on the turn rail label                                                    | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| `subtool` indent                       | `padding-left:26px`                       | CSS indent for a nested PTC sub-dispatch row                                      | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| `details` breakpoint                   | `width<=760px`                            | media query turning the pane into an overlay at `min(92%,420px)`                  | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |
| container breakpoint                   | `width<=620px`                            | container query collapsing the event column to 50px and hiding kind labels        | `dsh-client-ui-trajectory/lib/client.js:3818` (css$3)                                            |

### 2.2 Chat row / card line windows

These are the _only_ explicit "how many lines before collapse" knobs the client package sets.
The arithmetic behind them lives in `@deepseek-ai/dsh-client-ui-primitives` — **not found in source**.

| Prop                   | Value      | Applied to                                                                  | File:line                               |
| ---------------------- | ---------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `maxLines`             | `Infinity` | `TerminalBlock` in `ToolRow` (shell)                                        | `dsh-client-ui-tool/lib/client.js:1598` |
| `maxLines`             | `Infinity` | `TerminalBlock` in `BashRow`                                                | `dsh-client-ui-tool/lib/client.js:2507` |
| `maxLines`             | `9`        | `DiffBlock` in `ToolRow`                                                    | `dsh-client-ui-tool/lib/client.js:1604` |
| `maxLines`             | `8`        | `ReadBlock` in `ToolRow`                                                    | `dsh-client-ui-tool/lib/client.js:1609` |
| `maxLines`             | `8`        | `SearchBlock` in `ToolRow`                                                  | `dsh-client-ui-tool/lib/client.js:1631` |
| `MAX_INSPECTION_ITEMS` | `40`       | inspection-result rows per array level                                      | `dsh-client-ui-tool/lib/client.js:3070` |
| `depth > 4`            | `5`        | nesting depth of `inspectionItems` before the value is rendered as raw JSON | `dsh-client-ui-tool/lib/client.js:3079` |

### 2.3 Chat row CSS height caps

| Selector                                 | Value              | Bounds                                                     | File:line                                                                 |
| ---------------------------------------- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.HZhGha_card` (AskQuestionCard)         | `max-height:360px` | px, question card scroll region                            | `dsh-client-ui-tool/lib/client.js:1197` (css$5)                           |
| `.yj_sLW_list` (ToolDetails list)        | `max-height:320px` | px, detail list scroll region (unbounded inside a `group`) | `dsh-client-ui-tool/lib/client.js:1260` (css$4)                           |
| `.yj_sLW_root .item > .code`             | `max-height:240px` | px, per-item code block                                    | `dsh-client-ui-tool/lib/client.js:1260` (css$4)                           |
| `.Q2dzhW_bodyScroll` (ToolRow code body) | `max-height:260px` | px, the `run_code` CodeBlock scroll region                 | `dsh-client-ui-tool/lib/client.js:1434` (css$3)                           |
| `.Q2dzhW_ioSection` (ToolRow IO section) | `max-height:150px` | px, each of the input / output sections                    | `dsh-client-ui-tool/lib/client.js:1434` (css$3)                           |
| `--dsl-terminal-output-max-height`       | `224px`            | px, terminal output scroll region                          | `dsh-client-ui-tool/lib/client.js:1434` (css$3), `2376` (bash-sample css) |
| `.-gRAhq_ioSection` (bash generic IO)    | `max-height:150px` | px                                                         | `dsh-client-ui-tool/lib/client.js:2376` (bash css)                        |

### 2.4 Attachment / image bounds

Declared in `LocalAttachmentStore.Config` (`dsh-attachment-local/lib/index.js:971-982`) with
frozen runtime values in the constructor (`:998-1019`).

| Constant                                 | Default                     | Bounds                                                                        | File:line                                                 |
| ---------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `DEFAULT_MAX_IMAGE_BYTES`                | `20 * 1024 * 1024`          | bytes of one **submitted** image (refused, not shrunk)                        | `dsh-attachment-local/lib/index.js:896`                   |
| `DEFAULT_MAX_IMAGES_PER_MESSAGE`         | `20`                        | images in one prompt (batch-level)                                            | `dsh-attachment-local/lib/index.js:898`                   |
| `DEFAULT_MAX_MESSAGE_IMAGE_BYTES`        | `200 * 1024 * 1024`         | aggregate image bytes in one prompt                                           | `dsh-attachment-local/lib/index.js:900`                   |
| `DEFAULT_MAX_IMAGE_PIXELS`               | `64e6`                      | intrinsic pixels of one submitted image                                       | `dsh-attachment-local/lib/index.js:902`                   |
| `DEFAULT_MAX_IMAGE_DIMENSION`            | `8192`                      | per-side pixels of one submitted image                                        | `dsh-attachment-local/lib/index.js:904`                   |
| `DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS`    | `2048 * 2048`               | total pixels of the stored normalized image (downscale, not refuse)           | `dsh-attachment-local/lib/index.js:912`                   |
| `DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION` | `8192`                      | long-edge cap of the normalized image                                         | `dsh-attachment-local/lib/index.js:914`                   |
| `DEFAULT_NORMALIZED_IMAGE_MAX_BYTES`     | `4 * 1024 * 1024`           | encoded-byte target of the normalized image                                   | `dsh-attachment-local/lib/index.js:916`                   |
| `DEFAULT_IMAGE_COMPRESSION_CONCURRENCY`  | `2`                         | simultaneous native transforms per store                                      | `dsh-attachment-local/lib/index.js:918`                   |
| `MAX_IMAGE_COMPRESSION_CONCURRENCY`      | `8`                         | hard ceiling on that concurrency                                              | `dsh-attachment-local/lib/index.js:920`, enforced `:1017` |
| `mediaTypes`                             | png/jpeg/webp/gif           | accepted admission types                                                      | `dsh-attachment-local/lib/index.js:1003-1008`             |
| `IMAGE_MEDIA_TYPES` (client mirror)      | same 4                      | media types the **image card** will render; anything else declines to generic | `dsh-client-ui-tool/lib/client.js:2690-2695`              |
| `ID_PATTERN`                             | `/^sha256:([a-f0-9]{64})$/` | durable image id form                                                         | `dsh-attachment-local/lib/index.js:275`                   |
| `FILE_ID_PATTERN`                        | same shape                  | durable file id form                                                          | `dsh-attachment-local/lib/index.js:618`                   |
| `REQUEST_IMAGE_TRANSFORM_VERSION`        | `"request-image-v6"`        | cache key namespace for request-image derivatives                             | `dsh-attachment-local/lib/index.js:750`                   |

Batch admission order (`AttachmentStore.validateImageBatch`,
`dsh-attachment/lib/index.js:217-222`): count -> aggregate bytes -> per-image media type.
Per-image validation (`dsh-attachment-local/lib/index.js:193-194`, `:329`) then checks
decoded pixels -> per-side pixels -> encoded bytes.

### 2.5 Tool-result caps that reach the display

| Constant                         | Value                                                                                   | Bounds                                                                                | File:line                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `maxInlineTokens`                | _deployment config, no default_                                                         | estimated tokens of a retained tool result before spill; omission disables the plugin | `dsh-spill-policy/lib/index.js:127`, `138-141`    |
| `RAW_OUTPUT_MAX_BYTES`           | `2e7`                                                                                   | raw rg/grep output bytes                                                              | `dsh-tool-fs-search/lib/index.js:33`              |
| `SEARCH_TIMEOUT_MS`              | `3e4`                                                                                   | search tool timeout                                                                   | `dsh-tool-fs-search/lib/index.js:39`              |
| `SEARCH_STDERR_MAX_BYTES`        | `64 * 1024`                                                                             | stderr excerpt                                                                        | `dsh-tool-fs-search/lib/index.js:45`              |
| `SEARCH_GRACE_MS`                | `3e3`                                                                                   | post-timeout grace                                                                    | `dsh-tool-fs-search/lib/index.js:47`              |
| `SEARCH_META_MAX_BYTES`          | `65536`                                                                                 | serialized `meta` size; overflow sets `meta.truncated = true`                         | `dsh-tool-fs-search/lib/index.js:58`, `383-409`   |
| `GLOB_MAX_RESULTS`               | `100`                                                                                   | glob results retained                                                                 | `dsh-tool-fs-search/lib/index.js:537`             |
| `GREP_MAX_MATCHES`               | `250`                                                                                   | grep matches retained                                                                 | `dsh-tool-fs-search/lib/index.js:884`             |
| `GREP_MAX_LINE_BYTES`            | `2e3`                                                                                   | one grep match line                                                                   | `dsh-tool-fs-search/lib/index.js:889`             |
| `READ_LIMIT`                     | `2e3`                                                                                   | default **and** maximum `limit` of a `read` call                                      | `dsh-tool-fs/lib/index.js:223`, `242-243`         |
| `READ_MAX_LINE_LENGTH`           | `2e3`                                                                                   | chars of one returned line; suffix `... (line truncated to N chars)`                  | `dsh-tool-fs/lib/index.js:16`, `28-30`            |
| `READ_MAX_BYTES`                 | `50 * 1024`                                                                             | bytes across the selected window                                                      | `dsh-tool-fs/lib/index.js:18`                     |
| `WEB_SEARCH_MAX_RESULTS`         | `8`                                                                                     | search sources                                                                        | `dsh-tool-web/lib/index.js:25`                    |
| `WEB_SEARCH_MAX_QUERIES`         | `4`                                                                                     | queries per `web_search`                                                              | `dsh-tool-web/lib/index.js:27`                    |
| `DEFAULT_FETCH_MAX_OUTPUT_CHARS` | `2e5`                                                                                   | `web_fetch` output chars                                                              | `dsh-tool-web/lib/index.js:844`                   |
| `DEFAULT_WEB_TOOL_TIMEOUT_MS`    | `3e4`                                                                                   | web tool timeout                                                                      | `dsh-tool-web/lib/index.js:838`                   |
| `OUTPUT_TRUNCATED` marker        | `"\n[output truncated]"`                                                                | literal recognized/stripped by the `job_output` detail card                           | `dsh-client-ui-tool/lib/client.js:3166`           |
| `MENU_VIEWPORT_MARGIN`           | `16`                                                                                    | px, subagent catalog menu viewport inset                                              | `dsh-client-ui-subagent/lib/client.js:341`        |
| catalog menu width               | `Math.min(336, innerWidth - 2*16)`                                                      | px, subagent lineage popup width                                                      | `dsh-client-ui-subagent/lib/client.js:345`        |
| popup top offset                 | `5`                                                                                     | px gap between trigger and popup                                                      | `dsh-client-ui-subagent/lib/client.js:347`        |
| duration refresh tick            | `1e3` ms                                                                                | subagent lineage elapsed-time tick while any child is running                         | `dsh-client-ui-subagent/lib/client.js:164-174`    |
| `.Z0Zh9q_menu`                   | `width:336px; max-width:min(400px, 100vw - 32px); max-height:min(560px, 100vh - 140px)` | CSS bounds of the subagent lineage popup                                              | `dsh-client-ui-subagent/lib/client.js:12` (css$2) |
| `.Z0Zh9q_switcherTrigger`        | `max-width:244px`                                                                       | CSS cap on the lineage trigger title                                                  | `dsh-client-ui-subagent/lib/client.js:12` (css$2) |
| `.Z0Zh9q_row`                    | `min-height:44px`                                                                       | CSS min height of one lineage tree row                                                | `dsh-client-ui-subagent/lib/client.js:12` (css$2) |
| `.Z0Zh9q_children`               | `margin-left:16px; padding-left:3px`                                                    | CSS indent of one nesting level                                                       | `dsh-client-ui-subagent/lib/client.js:12` (css$2) |

### 2.6 The two standardized omission sentences (exact strings)

`describeOmitted` is duplicated in three packages with identical output
(`dsh-output-retention/lib/index.js:261-268`, `dsh-spill-policy/lib/index.js:11-16`,
`dsh-client-ui-tool/lib/client.js:652-659`):

- `kind: "none"` -> `""` (empty string)
- `kind: "exact"` -> `` `Omitted ${count} ${unit}.` `` — e.g. `Omitted 3 bytes.`
- `kind: "unknown"` -> `` `More ${unit} were omitted.` `` — deliberately **no** count.

`unit` is one of `items | bytes | chars | lines` (`dsh-output-retention/lib/index.js:256-260`).

The **spill notice** is a fixed-shape parenthesised footer
(`dsh-spill-policy/lib/index.js:7-27`, mirrored for recognition at
`dsh-client-ui-tool/lib/client.js:660-704`):

```
( <omission clause>[ Omitted N images.] Full formatted result stored at: <locator>. <retrievalHint> )
```

with literal separators `OPEN="("`, `CLOSE=")"`, `LOCATION=" Full formatted result stored at: "`,
`GUIDANCE_SEPARATOR=". "` (`dsh-spill-policy/lib/index.js:7-10`). The client's recognizer
(`hasSpillNotice`, `dsh-client-ui-tool/lib/client.js:691-703`) is what decides whether a
shell call may claim a real exit status or must fall back to the generic path
(`isSpilledShellCall` `:866-874`).

---

## 3. Image and binary handling

### 3.1 How a tool-produced image becomes an attachment

1. The tool returns an image; the `read_image` tool is the reference case. Its result is
   **two ordered content blocks** (`imageReadContent`, `dsh-tool-fs/lib/index.js:952-960`):
   a `text` block with the model-facing envelope, then an `image` block carrying the
   durable reference.
2. The durable reference (`imageRefFromValue`, `dsh-tool-fs/lib/index.js:916-928`) is exactly:

   ```json
   {
     "attachmentId": "<branded id>",
     "mediaType": "image/png",
     "bytes": 12345,
     "width": 800,
     "height": 600,
     "name": "optional",
     "originalDimensions": { "width": 1600, "height": 1200 }
   }
   ```

   (`originalDimensions` is present only when the read was downscaled.)

3. The model-facing envelope is an exact text shape (`formatImageReadOutput`,
   `dsh-tool-fs/lib/index.js:936-950`):

   ```
   <path>DISPLAY_PATH</path>
   <type>image</type>
   <content>
   image/png image, 800x600 px, 12345 bytes (downscaled from 1600x1200 px; multiply coordinates by 2.00 to locate features in the original file)
   </content>
   ```

   The `(downscaled ...)` clause is omitted when `originalDimensions` is absent. The client
   recognizes the envelope with the regex `IMAGE_ENVELOPE`
   (`dsh-client-ui-tool/lib/client.js:2684`).

### 3.2 Admission and storage

- `AttachmentStore` is the immutable storage seam (`dsh-attachment/lib/index.js:205-342`).
- Browser uploads arrive base64 and must be **canonical** (re-encoding must round-trip) or are
  rejected with `INVALID_IMAGE_BASE64` / `INVALID_FILE_BASE64`
  (`dsh-attachment/lib/index.js:73-80`).
- `admitPromptContent` replaces each uploaded image part with its durable reference and
  leaves text/file parts untouched (`dsh-attachment/lib/index.js:242-266`).
- Files are stored byte-for-byte and carry **no** admission limits
  (`dsh-attachment/lib/index.js:291-301`); streaming variants require the provider to
  apply backpressure (`dsh-attachment/lib/index.js:302-323`).
- Local storage root is `<dshHome>/attachments/v1`, with a derivative cache under the DSH
  cache path (`dsh-attachment-local/lib/index.js:996-997`).
- `readImageRequest` derives (or reuses) a **request variant** for the model, keyed by
  `REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v6"` and de-duplicated in-flight per
  variant id (`dsh-attachment-local/lib/index.js:750`, `1053-1081`).
- Image admission error codes (the machine-routing vocabulary a port must copy):
  `TOO_MANY_IMAGES`, `IMAGES_TOO_LARGE`, `UNSUPPORTED_IMAGE_TYPE`, `INVALID_IMAGE_BASE64`,
  `INVALID_IMAGE`, `IMAGE_TYPE_MISMATCH`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`,
  `IMAGE_DIMENSION_TOO_LARGE` (`dsh-attachment/lib/index.js:5-15`).

### 3.3 Offload mechanism (`dsh-compaction-image-offload`)

This is **not** a truncation — it is a permanent, durable _exclusion from the model request_.

- Trigger: a route rejects a request with `IMAGE_OFFLOAD_REQUIRED` and supplies
  `failure.offloadImages` (a count) (`dsh-compaction-image-offload/lib/index.js:141-145`,
  `146-151`).
- Action: `offloadOldestImages` walks the **input message events in request order**, skipping
  Assistant nodes, and marks the oldest _retained_ image occurrences; already-offloaded
  occurrences still consume an index but are not re-selected
  (`dsh-compaction-image-offload/lib/index.js:14-44`).
- Durable record: one `image/offload` event per decision:
  `session.append('image/offload', { targets: [{ seq, imageIndexes: number[] }] })`
  (`dsh-compaction-image-offload/lib/index.js:42`).
- Replay: `imageOffloadProjection` validates that `data` has **exactly one** key, that
  `targets` is non-empty, that no `seq` repeats, that each `seq` is a current surface node of
  type `user/message` or `tool/result`, and that `imageIndexes` are strictly increasing
  non-negative safe integers (`dsh-compaction-image-offload/lib/index.js:97-121`).
- Effect: selected blocks gain `offloaded: true` on a frozen copy
  (`dsh-compaction-image-offload/lib/index.js:55-84`). **The bytes stay in the durable log**;
  the route sends placeholder text for those occurrences thereafter
  (`dsh-compaction-image-offload/lib/index.js:124-132`).
- Accounting: `IMAGE_OFFLOAD_REQUIRED_CODE` / `LlmError` come from `@deepseek-ai/dsh-llm`
  (**not found in source**), as does the placeholder text actually substituted on the wire.

### 3.4 Display of images and binaries

- **Image card (`read_image`).** `imageCardModel`
  (`dsh-client-ui-tool/lib/client.js:2800-2838`) returns
  `{ label, images: [{ attachment: ref }, ...], text }`. The label is
  `abbreviateHomePath(relativizeToCwd(path, cwd), home)`. It declines (-> generic card) unless:
  the call is `read_image` with a non-empty `file_path` (`:2801-2804`); every block is a text
  or image object (`fullyRendered` `:2780-2792`); every image reference validates
  (`imageReferences` `:2725-2773` — `attachmentId` non-empty string, media type in the 4-member
  set, positive integer `bytes`/`width`/`height`, optional `name`, optional
  `originalDimensions` with positive integer sides); and at least one text block matches
  `IMAGE_ENVELOPE` (`imageTexts` `:2775-2790`). The attachment id is checked for **existence
  only** — never pattern-matched — so a non-local store's ids still render
  (`:2712-2723`).
- A **nested** `read_image` (dispatched from inside `run_code`) persists no `meta`, so its
  label falls back to its own `file_path` argument (`:2805`).
- Rendering: `ReadImageRow` declares a child slot `tool.call.images`
  (`kind: "single"`, `scope: "session"`) and `ToolRow` dispatches
  `renderSlot("tool.call.images", { images, loadImage, align: "start" })`
  (`dsh-client-ui-tool/lib/client.js:1618-1623`, declared `:2875-2877`).
  The gallery component itself lives in `ui-primitives` — **not found in source**.
- **Image URL minting (trajectory).**
  `loadImage: Object.assign(a => ctx.uiConversation.imageUrl(sessionId, a),
{ peek: a => ctx.uiConversation.peekImageUrl(sessionId, a) })`
  (`dsh-client-ui-trajectory/lib/client.js:8763`). The URL minting itself is **not found in
  source** (it lives in the conversation engine).
- **Binary/file blocks (trajectory).** `recordAttachments`
  (`dsh-client-ui-trajectory/lib/client.js:4767-4784`) turns every `attachment`/`file` block
  into a row whose metadata is
  `` `${mediaType | EXT} · ${fileSizeText(bytes)} · ${width} × ${height}` ``
  (the `W x H` part is image-only). Images are rendered through the
  `conversation.trajectory.images` slot with `thumbnail: true`; non-images get a generic icon
  tile (`dsh-client-ui-trajectory/lib/client.js:4786-4805`). The file icon box is
  `48px x 48px` in CSS (`dsh-client-ui-trajectory/lib/client.js:3818`).
- **Counting only.** In the ledger, images and files are usually _counted_, not rendered, on
  the summary line: `imageBlockCount` / `fileBlockCount`
  (`dsh-client-ui-trajectory/lib/client.js:7961-7966`) feed `t("layout.imageCount", {count})`
  and `t("layout.fileAttachments", {count})` (`:7379-7380`, `:8116`, `:8130`).

---

## 4. Sub-calls / nested PTC programs

### 4.1 Wire and tree

- A dispatch start carries `rootCallId`, `parentCallId`, `subCallId`, `name`, `arguments`
  (`dsh-client-ui-trajectory/lib/client.js:1689-1701`). A dispatch result carries the same
  plus `content`, `isError`, `error` (`:1702-1720`).
- `updateDispatch` (`:1748-1771`) keeps insertion order in `children`, so sub-calls display in
  **start order**, and a repeat `...-start` for an already-known child is a no-op (`:1762`).
- Tree admission `acceptsEdge` (`:1720-1746`) rejects self-edges, re-parenting a child that
  already has a parent, cycles, and anything whose `parentDepth + subtreeDepth > MAX_DEPTH (256)`.
- `projectCall` (`:1780-1816`) recurses and, at `depth > MAX_DEPTH` or on a revisit, keeps the
  block but **drops its `subCalls` to `[]`** (`:1783-1786`).

### 4.2 Chat: an indented tree, no counters

`ToolCallBranch` renders children in a nested `div` with `data-subcalls`, indented by a left
border and `margin-left:22px; padding-left:8px` (`dsh-client-ui-tool/lib/client.js:1888-1901`).
Children are rendered for **every** phase except `preparing`, and there is **no** counter, no
"+N more", and no depth cap in the renderer — the cap lives in the projection (see above).
A preparing parent shows **no** children at all (`:1888`).
Each call row carries `data-chat-anchor-key="call:<callId>"` and `data-chat-call-id`
(`:1858-1859`) for scroll/anchor contracts.

### 4.3 Trajectory: interleaved flat rows with counters

Sub-calls are **flattened into the parent's row run**, not nested:
`withSubCalls` interleaves `expandSubCalls(subs, index, t)` immediately after the parent and
renumbers every follower (`dsh-client-ui-trajectory/lib/client.js:8046-8063`);
`expandSubCalls` recurses depth-first, emitting one `kind: "subtool"` cell per child
(`:8066-8101`).

- A sub-call still in `phase: "preparing"` is **skipped entirely** (`:8071`).
- A running sub-call has `timeSeconds: null` (`:8096`).
- Indentation is CSS-only: `tr[data-kind=subtool] .content { padding-left: 26px }`
  (`dsh-client-ui-trajectory/lib/client.js:3818`).

**Counters exist only in the fold summaries:**

- Turn fold: `summarizeTurn` (`:4321-4326`) emits
  `"<steps> · <toolCalls>"` using `summary.steps.one/other` and `summary.toolCalls.one/other`.
- Assistant fold: `summarizeAssistantTools` (`:4371-4379`) emits
  `"<count> tool calls · <distinct names joined by ', '>"` — the names are the cell text up to
  the first `" · "` (`:4372-4377`).
- A turn folds only when it has **more than one** content record
  (`if (contentRecords.length <= 1) return [record]`, `:4338`).
- An assistant folds only when at least one following `tool`/`subtool` cell exists
  (`:4388-4390`).
- Fold rows are 20px tall and carry `data-collapsed-summary="turn" | "assistant"`
  (`:3713`, `5922`).

**There is no "+N more" string anywhere in the extracted presentation code.** The only
"N-more" affordances found are:

- `t("detail.moreInInspect", { count: value.length - MAX_INSPECTION_ITEMS })` for inspection
  arrays over 40 (`dsh-client-ui-tool/lib/client.js:3074-3078`) — a _line in the card_, not a
  disclosure.
- Per-primitive `expandRest` / `expandAria` label callbacks with an `n`/`count` argument
  (`dsh-client-ui-tool/lib/client.js:727-728`, `1131-1133`, `1151-1153`, `1176-1178`).
  The **wording** of those strings lives in the `conversation` locale namespace, which is
  **not found in source** (the trajectory and workflow-run packages ship their own
  `zh`/`en` dictionaries; the shared `conversation` one is not in the extraction —
  `dsh-client-ui-tool/lib/client.js:1950-1952` names the namespace only).

### 4.4 PTC program presentation

`codeProgram(cell)` (`dsh-client-ui-trajectory/lib/client.js:3802-3815`) only fires when
`cell.toolName === "run_code"` (`PTC_TOOL_NAME`, `:3778`) and the recorded `inputDetail`
parses to an object with a string `code`. It returns
`{ rawInput, source, description, arguments, language }`.
`recordedLanguage` (`:3789-3800`) resolves the language **from the recorded tool schema's
`parameters.code.description`**, never from the source text or current runtime:
mentions `TypeScript` -> `"typescript"`, otherwise `"python"`, and returns `undefined` when both
or neither are mentioned.
The `description` falls back to the first non-blank source line (`:3811-3812`).

The program panel (`ProgramInput` `:5283-5364`, `ProgramOutput` `:5365-5404`) offers a
wrap-lines toggle (persisted as a per-view default through `jsonStringWrapping`, `:5301`),
a "show original JSON arguments" toggle, and a copy button whose `data-state` becomes
`"failed"` when the clipboard write fails (`:5266-5281`). Errors tint the whole output block
(`programError` first-line colour, `:5390` / css `dsh-client-ui-trajectory/lib/client.js:3818`).

> Note: the **chat** row for a `run_code` call renders the body as a `CodeBlock` with
> `lang: "typescript"` **hard-coded** (`dsh-client-ui-tool/lib/client.js:1649`) — the chat row
> does _not_ do the schema-based language resolution the trajectory pane does.

---

## 5. Status / state visualisation

### 5.1 Tool row states

`toolRowModel` computes exactly five states (`dsh-client-ui-tool/lib/client.js:278`):

| state       | condition                                       | colour class                                                   | a11y label                     |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| `preparing` | block has no `kind` and `phase === "preparing"` | —                                                              | `t("row.preparing")` (`:1487`) |
| `running`   | block has no `kind`, `phase === "start"`        | shimmer                                                        | `t("row.running")` (`:1488`)   |
| `ok`        | settled, no error                               | —                                                              | none                           |
| `stopped`   | settled and `error.code === "interrupted"`      | `.stoppedSummary` -> `--dsw-alias-state-warn-label` (`:1434`)  | `t("row.stopped")` (`:1490`)   |
| `error`     | settled and `isError`                           | `.errorSummary` -> `--dsw-alias-state-error-primary` (`:1434`) | `t("row.failed")` (`:1489`)    |

Two extra rules:

- `GenericToolCard` promotes `ok` -> `error` when the derived terminal card reports a non-zero
  exit or a terminating signal (`:1768`, `terminalFailed` `:769-772`) — because a failing
  `bash` command settles with `isError === false` (exit status is _result data_).
- The output section is tinted with `data-error` when `state === "error"` (`:1679`).
- A settled-with-cue row (`error`/`stopped`) **drops** its diff stat suffix and its file link
  (`:1537-1538`, `:1543-1553`) and swaps in the error summary line (`:1529-1531`).
- The visually-hidden status span is rendered at the row root (`:1721-1724`), so the colour
  cue is not colour-only.

Animation model: `TextShimmer` wraps the collapsed summary
(`:1556`, `:1568`, `:1574`); the bash row drives it with `active={running}`
(`dsh-client-ui-tool/lib/client.js:2485-2488`). Row/chevron transitions are `0.1s`, and
`bash-sample` disables them under `prefers-reduced-motion: reduce`
(`dsh-client-ui-tool/lib/client.js:2376`). No spinner or progress bar exists in these packages.

### 5.2 Workflow-run states

`STATUS_KEYS` covers five run/member statuses — `running | completed | failed | cancelled |
interrupted` (`dsh-client-ui-workflow-run/lib/client.js:49-55`) with localized text
(`:456-495`).

`dotState` maps them onto a `StateDot` state (`:56-66`):
`running -> "ongoing"`, `completed -> "done"`, `failed -> "error"`,
`cancelled | interrupted -> "warning"`.
`StateDot` itself is in `ui-primitives` — **not found in source**; only these
five string inputs (`"ongoing" | "done" | "error" | "warning" | "idle"`) are observable here
(also used at `dsh-client-ui-subagent/lib/client.js:277`, `558`).

**Auto-collapse is the interesting part.** Each run and each phase derives a _facts_ triple
`{ mode, activityCount }` (`:89-100`) where `mode` is one of `clean | running | abnormal`, and
`advanceDisclosureState` (`:108-135`) drives the disclosure from it:

- enter `abnormal` (or from `clean`) -> **force open** (`:125-129`);
- become `clean` while open -> **defer** collapse if focus is inside the region, and collapse on
  the next blur (`pendingCleanCollapse` + `settleRunBlur`/`settlePhaseBlur`, `:108-135`,
  `:380-405`; header mousedown is swallowed while pending, `:154-159`, `:269`);
- any new activity restarts a cycle and re-opens the run (`:331-345`).

`phaseStatusSummary` (`:160-172`) prints per-status counts, forcing `completed` to the front
when an `interrupted` member coexists with completed ones.

### 5.3 Subagent lineage states

Per child entry: `StateDot state = activity === "running" ? "ongoing" : completed ? "done" : "idle"`
(`dsh-client-ui-subagent/lib/client.js:277`), where `completed` means
`activity === "inactive" && subagentTiming.lastTurnCompleted === true` (`:200`).
The activity label joins `title . mode . activity` (`:202-206`). A child is a "known leaf"
only once its own authoritative catalog has loaded **empty** (`isKnownLeaf` `:160-162`); until
then a disclosure chevron is reserved (`:177`, `:265`). A `role="treeitem"` row carries
`aria-level`, `aria-current`, and `aria-expanded` (only when not a known leaf) (`:252-258`).
Catalog load failure renders an error row with a refresh button rather than inventing membership
(`:180-190`).

### 5.4 Trajectory row states

`stateOf(record)` (`dsh-client-ui-trajectory/lib/client.js:4406-4411`):
`isError -> "error"`; a `compacted` cell with `timeSeconds === null` -> `"running"`;
a `tool`/`subtool` cell with `outputDetail === undefined` -> `"running"`; else `"complete"`.
`statusLabel` maps to `status.failed` / `status.pending` / `status.completed` (`:4412-4415`).
Error rows tint the turn rail and selection rail
(`tr[data-error=true]` rules, `dsh-client-ui-trajectory/lib/client.js:3818`).
Assistant request status is `"complete" | "error" | "running"`, where `error` also covers
"a retry happened or the boundary closed" (`:894-897`).

---

## 6. Incremental / streaming vs one-shot rendering

### 6.1 The `publication` contract

Each Definition may declare a `publication(match)` returning
`"none" | "animation-frame" | "immediate"`. Only three declarations exist in the extraction:

| Definition                  | `publication`                                                                                                                                                                     | File:line                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `trajectory-assistant-step` | `"none"` for `step/start` and `assistant/attempt`; `"none"` for `usage`/`finish` live-chunks; `"animation-frame"` for every other live chunk; `"immediate"` for settlement events | `dsh-client-ui-trajectory/lib/client.js:962-967` |
| compaction request header   | `() => "none"`                                                                                                                                                                    | `dsh-client-ui-trajectory/lib/client.js:1216`    |
| `tool-todo-write`           | `() => "none"`                                                                                                                                                                    | `dsh-client-ui-tool/lib/client.js:4242`          |

`trajectoryToolDefinition` declares **no** `publication`, so the default applies (default value
is **not found in source** — the engine that interprets the field is not in the extraction).
Observed consequence: tool dispatch events are published per event, while assistant text
streams coalesce to one animation frame.

### 6.2 Incremental surface (assistant streaming)

`updateChunk` (`:735-806`) folds each chunk into `{ blocks[], visibleBlocks, firstVisibleSeq,
firstVisibleTime, firstTokenTime }`:

- `block-start` seeds an empty block via `emptyAssistantBlock` (`:633-652`);
- `text-delta` / `reasoning-delta` append text (`:750-768`);
- `tool-call-delta` appends `argumentsDelta` and latches `callId`/`name` (`:770-786`);
- `block-end` replaces the accumulated block with the finalized one (`:788-792`);
- `visibleBlocks` is maintained incrementally so "first visible output" is exact
  (`:715-719`, `:798`).

`blockIsVisible` (`:710-713`) treats a `tool-call` block and whitespace-only text/reasoning as
**not visible**.

A still-streaming step publishes a `partial` node (`:973-977`), and the layout marks it
`{ streaming: true }`, which **suppresses duration and absolute time**
(`:7837-7840` — `messageDuration`/`nodeAbs` become `null`) so the row does not flicker a bogus
elapsed value. The partial is appended to an already-finalized layout by
`appendTrajectoryPartialLayout` (`:7725-7770`) rather than rebuilding the whole ledger.

A step that never produces an `assistant/message` still yields a node when the boundary
closes **and** at least one block carries evidence (`hasInterruptionEvidence`, `:720-724`),
flagged `interrupted: true` and anchored at `boundary.seq - .9` (`:884-889`).

### 6.3 Incremental surface (tool lifecycle)

Tool events are **state-replacement, not streaming**: `tool/call` creates a
`{ phase: "start" }` block and `tool/result` **replaces** it with a `tool-result` block
(`:1841-1851`). There is no partial-output channel for a tool result in the extraction.
The nearest thing to streaming for a call in flight is the **argument** subscription:

`bindToolCallArgumentsPartial` (`:1930-1949`) is a call-scoped `useSyncExternalStore` bound to
the assistant step source; it returns the **raw accumulated argument prefix** for one `callId`.
It is used by the preparing write/edit row to render a live size hint
`t("tool.preparing.content", { kilobytes: Math.ceil(raw.length / 1024) })`
(`dsh-client-ui-tool/lib/client.js:2570-2579`). That is the only character count the chat UI
computes on a live tool call.

### 6.4 One-shot surfaces

- `TrajectorySnapshotBuilder.replace/apply` (`:1514-1531`) is the incremental engine; a
  structural change (new node or moved `anchorSeq`) rebuilds the contribution ordering, a
  content-only change replaces the contribution in place.
- The ledger's own diffing is at the DOM level: `@tanstack/react-virtual` with
  `VIRTUAL_OVERSCAN_ROWS = 12`, plus a `data-scroll-more` bottom mask on the preview region
  (css, `:3818`).
- `groupTrajectoryVirtualRows` (`:3731-3758`) is pure: given the final record list it returns
  measured rows, so row height is never derived from a live measurement race.

### 6.5 Replay determinism

Every definition carries a `fallbackState(context)` that re-folds _all_ matches from scratch
when no live state exists, so a detached replay produces byte-identical nodes
(`trajectoryToolDefinition.fallbackState` `:1817-1829`; assistant `fallbackState$1` `:835-861`).

---

## 7. Things that are explicitly **not found in source**

- `@deepseek-ai/dsh-client-ui-primitives` — `TerminalBlock`, `DiffBlock`, `ReadBlock`,
  `SearchBlock`, `WebBlock`, `CodeBlock`, `JsonTree`, `DisclosureRow`, `StateDot`,
  `TextShimmer`, `MarkdownText`, `Tooltip`, `extractMarkdownPlainText`, `diffTotals`,
  `fileSizeText`, `fileExtension`. Every `maxLines` / `expandRest` / dot-colour rule therefore
  bottoms out here.
- The `conversation` locale namespace dictionary (all `row.*`, `tool.title.*`, `read.expandRest`,
  `search.matches*`, `terminal.*`, `detail.*` strings).
- The chat-target producer that supplies `node.data.root` to `ToolCallTree`
  (`dsh-client-ui-tool/lib/client.js:1917`). Only the trajectory definition is in the
  extraction.
- `IMAGE_OFFLOAD_REQUIRED_CODE`, `LlmError`, and the placeholder text substituted for an
  offloaded image (from `@deepseek-ai/dsh-llm`).
- `ctx.uiConversation.imageUrl` / `peekImageUrl` (URL minting).
- The engine that interprets `publication` and the default value when it is absent.
- `dsh-file-reference/` and `dsh-file-reference-local/`.
- The **`+N more`** collapsed-subtree affordance: no such string or threshold exists in any
  extracted presentation package. Sub-calls render in full; the only caps are
  `MAX_DEPTH = 256` (trajectory tree) and the CSS indent of 26px.
- The concrete colour values behind `--dsw-alias-state-*` tokens.

---

## 8. Sources appendix

### `dsh-agent-tool-presentation`

- `lib/index.js:23` — plugin `name = "tool-presentation"`
- `lib/index.js:29` — `inject = ["tools"]`; `ptcRuntime` deliberately **not** injected
- `lib/index.js:31-35` — `Config = { mode: "native" | "ptc" | "both" }` (required)
- `lib/index.js:41-49` — `apply`: `native` applies immediately; `ptc`/`both` wait for
  `ctx.inject(["ptcRuntime"], ...)`
- `dsh-tools/lib/index.js:2810-2826` — `presentAs(mode)` refuses a second, conflicting
  declaration in the same scope

### `dsh-client-ui-tool`

- `:83-100` `TOOL_VARIANTS`; `:102-149` `TOOL_TITLE_KEYS`; `:155-157` `classifyTool`;
  `:163-165` `toolTitleKey`
- `:179-185` `resultText`; `:186-192` `parseArgs`; `:193-196` `firstLine`;
  `:204-220` `SUMMARY_KEYS`; `:221-233` `deriveSummary`; `:235-248` file-path derivation
- `:255-264` `formatToolBody` (the `code` variant renders `parsed.code` raw)
- `:273-295` `toolRowModel`; `:278` the five-state derivation
- `:297-331` `parsedToolCall` (WeakMap-cached per immutable block); `:333-339`
  `singleResultText`; `:341-353` `validEscalationFields`
- `:355-436` `readCardModel`; `:437-545` `diffCardModel`; `:546-659` `searchCardModel`
- `:652-659` `describeOmitted`; `:660-704` spill-notice recognizer
- `:705-969` `terminalCardModel` family; `:769-772` `terminalFailed`;
  `:866-874` `isSpilledShellCall`; `:896-931` `parseExitStatus`
- `:970-1050` `webCardModel`; `:1051-1075` auto-review denial
- `:1091-1195` primitive label adapters (`terminal.*`, `diff.*`, `read.*`, `search.*`, `web.*`)
- `:1294-1432` `ToolDetails`; `:1500-1740` `ToolRow`; `:1518` expandability;
  `:1519` card precedence; `:1598/1604/1609/1631` the four `maxLines` values; `:1649` hard-coded
  `lang: "typescript"` for the code variant
- `:1742-1786` `GenericToolCard` (dispatch fallback)
- `:1802-1928` `ToolCallTree` / `ToolCall` / `ToolCallBranch`
- `:1929-1949` `bindToolCallArgumentsPartial`
- `:2561-2619` `FileMutationRow`; `:2570-2579` the preparing-row kilobyte hint
- `:2620-2673` `read-family-row` / `ReadRow`
- `:2674-2841` `imageCardModel` family; `:2842-2881` `ReadImageRow`
- `:2926-3164` `detail-model-shared`; `:3070` `MAX_INSPECTION_ITEMS`; `:3079` depth cap
- `:3165-3492` `control-details-model`; `:3166` `OUTPUT_TRUNCATED`
- `:3493-3747` `inspection-details-model`; `:3748-3974` `details-card-model`
- `:3975-4228` `DetailsRow` + keyed registrations
- `:4229-4284` `todo-history` (the second `publication: "none"`)
- `:4540-4566` `apply`: the `tool-call` chat node and its keyed `tool.call.toolview` child slot
- `:1197`, `:1260`, `:1434`, `:2376` — the four inlined CSS module payloads carrying the height caps

### `dsh-client-ui-trajectory`

- `:448-494` assistant-stream first-token measurement
- `:495-515` `trajectoryNode` envelope
- `:516-686` `trajectory-event-projection`; `:601-619` `toAssistantBlock`;
  `:633-652` `emptyAssistantBlock`; `:660-673` `displayFailure`
- `:687-994` `trajectory-assistant-definition`; `:735-806` `updateChunk`;
  `:962-967` `publication`; `:963-967` frame coalescing
- `:1420-1647` `trajectory-snapshot-builder`; `:1459-1465` `captureSchemas`
- `:1648-1892` `trajectory-tool-definition`; `:1649` `MAX_DEPTH`;
  `:1720-1746` `acceptsEdge`; `:1748-1771` `updateDispatch`; `:1780-1816` `projectCall`;
  `:1834-1851` `match`; `:1852-1872` `start`/`update`; `:1873-1882` `buildViewNode`; `:1817-1829` `fallbackState`
- `:3677-3710` trajectory record identity and duration formatting
- `:3710-3759` `trajectory-virtual-rows`
- `:3760-3775` `trajectory-preview` (2048 / 512)
- `:3776-3816` `code-program` (schema-derived language)
- `:3991-6576` `TrajectoryTable`; `:3993-3998` virtualization constants;
  `:4102-4110` pane/column geometry; `:4321-4409` fold summaries;
  `:4406-4415` `stateOf`/`statusLabel`; `:4622-4698` record display;
  `:4767-4805` `recordAttachments`; `:4568-4617` `detailTabs`; `:5266-5404` program panels
- `:6703-6830` `timeline` (three lanes: tool/subtool = lane 2, message/compacted = 1, else 0)
- `:7352-8147` `layout`; `:7398-7716` `deriveTrajectoryLayout`;
  `:8046-8063` `withSubCalls`; `:8066-8101` `expandSubCalls`
- `:8691-8777` plugin `apply`; `:8763` `loadImage` / `peek` URL minting
- `:3818` — the inlined `TrajectoryTable.module.css` payload carrying every geometry value

### `dsh-client-ui-workflow-run`

- `:49-55` `STATUS_KEYS`; `:56-66` `dotState`; `:89-100` disclosure facts;
  `:101-147` `initialDisclosureState` / `advanceDisclosureState` / `collapsePending`;
  `:160-172` `phaseStatusSummary`; `:182-213` `RunHeader`; `:214-265` `MemberRow`;
  `:266-313` `PhaseSection`; `:315-378` `WorkflowRunPanel`
- `:456-495` zh/en dictionaries
- `:504-582` `workflow-definition`; `:507-514` `statusFromStopReason`; `:516-527` `statusFromOutcome`;
  `:529-582` `projectWorkflow`

### `dsh-client-ui-subagent`

- `:53-648` `SubagentHeaderLineage`; `:57-63` `formatTokens`; `:65-67` `tokenTotal`;
  `:69-79` `activityDuration`; `:81-125` duration formatting;
  `:160-162` `isKnownLeaf`; `:164-338` `CatalogRows`; `:277` `StateDot` state;
  `:341-350` `catalogMenuPosition`; `:12` (css$2) popup geometry

### `dsh-attachment` / `dsh-attachment-local`

- `dsh-attachment/lib/index.js:5-29` error codes; `:39-52` `AttachmentError`;
  `:73-80` canonical base64 decode; `:217-222` `validateImageBatch`; `:228-234` `saveImages`;
  `:242-266` `admitPromptContent`; `:291-301` `saveFile`; `:338-341` `readImageRequest`
- `dsh-attachment/lib/types/request-projection.js:12-48` `requestImageDimensions` /
  `longEdgeDimensions`
- `dsh-attachment-local/lib/index.js:193-194` pixel/dimension validation; `:213` passthrough
  predicate; `:275` `ID_PATTERN`; `:329` byte validation; `:618` `FILE_ID_PATTERN`;
  `:750` `REQUEST_IMAGE_TRANSFORM_VERSION`; `:896-920` all defaults;
  `:971-982` `Config`; `:996-1019` storage root + frozen runtime limits; `:1053-1081` request
  variant cache

### `dsh-compaction-image-offload`

- `lib/index.js:14-44` `offloadOldestImages`; `:42` the durable `image/offload` append
- `lib/index.js:55-84` `offloadMessageImages` (sets `offloaded: true`, deep-freezes)
- `lib/index.js:97-121` `imageOffloadProjection` validation rules
- `lib/index.js:139-152` the two recovery listeners

### Cross-package

- `dsh-spill-policy/lib/index.js:7-27` notice format; `:39-120` `fitText` / `retainContent`
  (head/tail split at `budget/2`); `:127-141` `maxInlineTokens`; `:179-238` `bound`
- `dsh-output-retention/lib/index.js:47-95` `ItemRetainer`; `:252-282` `describeOmitted` /
  `formatRetentionNotice`; `:295-300` surrogate-safe truncation
- `dsh-tool-fs/lib/index.js:16/18` `READ_MAX_LINE_LENGTH` / `READ_MAX_BYTES`;
  `:29-30` line-truncation suffix; `:101-113` `formatReadOutput`;
  `:223` `READ_LIMIT`; `:242-243` limit validation; `:936-960` `formatImageReadOutput` /
  `imageReadContent`; `:1181-1185` `Config`
- `dsh-tool-fs-search/lib/index.js:33/39/45/47/58` raw-output, timeout, stderr, meta caps;
  `:383-409` `meta.truncated` derivation; `:537` `GLOB_MAX_RESULTS`;
  `:884/889` grep caps
- `dsh-tool-web/lib/index.js:25/27` search caps; `:568` truncation footer;
  `:838/844` fetch defaults
- `dsh-tools/lib/types/invariant.js:23-38` PTC dispatch envelope validation
- `dsh-tools/lib/invariant.js:18-32` the shipped copy of the same validation

---

## 9. Audit checklist for a third-party port

Derived from the ground truth above; each item is falsifiable against `/tmp/dsh-src`.

1. Does the port have **two** surfaces (nested chat tree + virtualized ledger) or one? DSH has two,
   with independent models.
2. Does the tool definition declare a `publication`? Assistant streaming must be
   `"animation-frame"` with `usage`/`finish` chunks suppressed; tool events have no declaration.
3. Are the four chat card windows `TerminalBlock=Infinity`, `DiffBlock=9`, `ReadBlock=8`,
   `SearchBlock=8` present verbatim?
4. Is `MAX_DEPTH = 256` enforced on the dispatch tree, and is over-depth handled by emptying
   `subCalls` rather than throwing?
5. Are `preparing`-phase calls non-expandable, and are `preparing` sub-calls omitted from the
   ledger entirely?
6. Does a non-zero bash exit surface as `error` even though `isError` is false?
7. Are the two omission sentences byte-exact (`Omitted N bytes.` / `More bytes were omitted.`)?
8. Is the spill notice the exact parenthesised shape with `" Full formatted result stored at: "`
   and a trailing `")"`?
9. Is image offload a **durable exclusion** (`image/offload` + `offloaded: true`) rather than a
   byte cap?
10. Does the chat `run_code` body hard-code `lang: "typescript"` while the ledger resolves
    language from the recorded schema description? (They genuinely differ in DSH.)
11. Does the workflow panel force-open on abnormal and defer-collapse clean on blur?
12. Is there a `+N more` collapsed subtree? (DSH has none — do not invent one.)
