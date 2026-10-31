# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.2.0] - 2026-10-31

### Added

- **`timeoutMs` and `projectContext` knobs on task dispatch** (dispatch). `timeoutMs` arms a
  timer only when given: timeout goes through the normal stop path (SIGTERM → SIGKILL),
  `stopReason` records the timeout, terminal state `canceled` — no host-side default; whether
  to use it is the model's call. `projectContext: "none"` loads no AGENTS.md/CLAUDE.md into
  the child (`--no-context-files`, present since pi 0.86.0, so no version gate; default
  `auto` unchanged). Engine-level real-machine probe `scripts/knobs-smoke.mjs` (assertions
  need no model cooperation — timeout reaping, auto/none A/B, report channel, usage fallback)
  passes on eight pi versions 0.86.0 / 0.87.1 / 0.99.0 / 1.0.0 / 1.1.0 / 1.2.0 / 1.3.0 / 1.4.0.
- **Delivery check** (dispatch + entry + routes): the engine extracts the child's real tool
  trajectory from `tool_execution_start/end` into `ChildDelivery` {tool counts, paths
  touched, tool errors, text chars} — measured from the stream, not model self-report —
  attaches it to the task record alongside the report, and the task surface renders a
  one-line check; when the child delivered nothing, the parent is told to re-dispatch or
  name the gap rather than fill in numbers. Verified against real print-mode streams on pi
  0.86.0 and 1.4.0 (parser on real events yields e.g. `tools={read:1}`,
  `paths=["/etc/hosts"]`).
- **`write` — a fifth fs tool in the Kimi face** (`ptc_run_code`): programs can now create
  files, closing the "can't create a file in-program" capability gap found in A/B. Shape
  `{path, content}`, overwrite allowed, parent directory must already exist (clean error, no
  implicit mkdir), 2MB cap counted in bytes, atomic tmp+rename, same realpath jail.
- **Kimi-face adoption guidance from A/B benching**: SKILL.md gains a two-column "when to
  write a program" checklist (≥5 same-shape calls / ≥20-file read-then-reduce / known-anchor
  batch edits, plus four negative examples); when a fulfilled program made calls, the result
  footer shows "N in-program tool calls reduced to 1"; tool mentions use the full-name
  pattern (`mcp__` prefix + `__ptc_run_code` suffix) after the "skill says write a program
  but the tool isn't in my list" perception break; `ptc_run_code`'s description gains a
  quantified trigger line; `web_ds_search` loses its "in-program" demotion box.

### Changed

- **Env pass-through fix, with measured child cost**: the default spawn dropped `env`, so
  `PI_PTC_DEPTH` / `PI_PTC_TASK_ID` never reached the child — children fully assembled as
  depth 0 (whole route book injected, recursion gate ineffective). After the fix children
  take the depth>0 early exit: per-child input −43% (ptc 2830→1607, both 3121→1766).
  Model-side cost multiple corrected to "about 10×" (measured 9–12×; the old 15–22× was
  from before this fix).
- **Report contract**: the old contract block said `"summary" is your deliverable`, so
  children stuffed facts into self-invented JSON blocks that were then dropped (3/12
  affected; parent recomputed → grader flagged hallucinations). Reworded: the report is the
  summary, the deliverable goes in the task's own format, and the parent-side briefing now
  names the child-report JSON block shape. Measured: named shape → 12/12 reports delivered;
  self-invented formats → 0/4.
- **Usage fallback**: a child self-reporting all-empty/zero usage no longer masks the
  host-observed value (the task surface was permanently showing 0).
- **`projectContext: none` docs corrected by measurement** (2026-10-31): none only removes
  the injection — children still read AGENTS.md on their own and apply its conventions
  (none-vs-auto input diff ≈15%, not the "about half" previously claimed; in 6/6 rounds the
  model chose none unprompted).
- **Parent-side route book**: new first guidance section — dispatch criteria and cost
  ("lots of material / disjoint topics / each piece needs reading ⇒ dispatch; one computable
  job ⇒ don't"); briefing discipline adds "parent writes it wrong → child executes it
  wrong, consistently".

### Fixed

- `scripts/version-smoke.sh` installed the wrong package: npm's `pi` is
  IonicaBizau/pi-number (no `pi` bin exists), so every shim install failed — the real
  package is `@earendil-works/pi-coding-agent`.
- Kimi-face review round: partial run-ab runs no longer wipe `results.jsonl`; arm-restore
  validates its backup (missing or identical-to-arm → refuse to run); the batch-read grader
  verifies per-file line counts; the `write` cap counts `Buffer.byteLength` (1M CJK chars ≈
  3MB slipped through the character count).

## [7.1.0] - 2026-10-29

### Added

- **Kimi Code plugin face (`ptc-tools`, MCP)** (ADR-0020). One repo now ships two install
  faces: the pi extension (this npm package, unchanged name) and a Kimi Code plugin that
  exposes `ptc_run_code` over MCP — the model writes one TypeScript program, batch-calls a
  fixed fs toolset (read/grep/glob/edit) inside a vm cell, and gets one reduced result back
  (measured context economy 1:138 on a 100-file fan-out). `workdir` is a real trust boundary
  (realpath-jailed; symlink escapes rejected). Verified end-to-end in real Kimi Code: skill
  guidance auto-triggers program writing, both Kimi (K2.8) and MiniMax (M3.1-Flash) models
  answered 12/12 deterministic cases with zero unnecessary tool calls and full jail
  compliance. Ships as `release/kimi/` committed at the tag plus `kimi.plugin.json`; update
  detection verified against the official `MoonshotAI/kimi-code` source (GitHub-source-only,
  needs a GitHub Release object per version).
- **`web_ds_search` in the Kimi face** (P2): the DeepSeek-backed search core (search/open/find)
  is now fully host-neutral and exposed as a second MCP tool; per-process quota with
  fail-soft missing-key behavior. DeepSeek API key resolves env-first, then reuses the key
  already configured in Kimi Code's own `config.toml` (commented-out keys are honored as
  disabled).
- **Kimi-face quality gates** (`tests/kimi`): mechanical registry gates (tools/list ↔ route
  registry bidirectional with verbatim description match, description token budget, argument
  matrix), plus `scripts/kimi-bench.mjs` (21-case diversity/stress probe; floor Node 22.21.0
  verified 21/21) and `scripts/kimi-model-ab.sh` (model A/B harness).

### Changed

- **Host-neutral output core** (`@pi-ptc/output`): run-result shaping (model-visible text,
  ADR-0012 layout + ADR-0015 truncation) split out of the ptc package so both faces share it;
  pi-tui rendering stays pi-side. Test suite split three ways: `tests/pi` / `tests/output` /
  `tests/kimi` (87 cases total, all green).
- **Worker `execArgv` is now empty** — worker threads no longer inherit the host's exec
  flags. Found by real-machine testing: the Kimi Code host passes `--max-semi-space-size=16`,
  which Node's worker flag validation rejects, killing every program run. Blacklist
  filtering (pi's eval flags) could never keep up with host-specific flags.
- **Truncation temp files now self-clean**: first truncation in a process sweeps own-prefix
  temp files older than 24h (previously only grew forever).
- SKILL.md documents exact argument/return shapes for the four fs tools (removes the #1
  model-side friction found in A/B testing); README explains the npm-name vs plugin-name
  split.

### Fixed

- `grep` with a file path (`ENOTDIR`), unreadable files killing the whole grep, stale build
  chunks leaking into shipped plugin artifacts, raw `ENOENT` for missing workdir, and
  commented-out DeepSeek keys being picked up as active.

## [7.0.0] - 2026-10-28

### Changed

- **BREAKING: PTC programs run in a dedicated vm cell** (spec 决策 30, ADR-0019). Each run
  now executes inside a fresh `vm.createContext`. The host injects only three thin bridges;
  an **IIFE preamble** builds `tools` / `console` / `args` (frozen) / the four `workflow.*`
  helpers **inside the cell (context realm)** and then drops the bridges — the IIFE matters:
  script-level `var` in a vm context lands on the cell's global, and a leaked bridge name
  (`__bridge`) was empirically reachable and escapable during review (fixed, regression-tested).
  Prototype-chain escapes of the `x.constructor.constructor("return process")()` class find
  no host object, and tool results cross the boundary as JSON strings so no host
  Promise/object is ever exposed. `process`, `fetch`, `require`, dynamic `import()`, and all
  `node:*` modules are unreachable — previously a program could `await import("node:fs")`
  and bypass pi's tool pipeline (permissions/approvals) entirely. Programs that used those
  escape hatches will break; programs that only use `tools.*` and `Date`/`Math` are
  unaffected. Worker reset is now "drop the cell" — the globalThis baseline sweep, its known
  prototype-pollution shortcut, and the console patch/restore dance are all gone.
  Tool-call arguments and results are now pure JSON at the cell boundary: `undefined` values
  in arguments are dropped, a `BigInt` argument rejects the call (old structured-clone
  semantics differed; pinned by tests).
- **Changed: `console.log` of objects prints JSON** (`{"a":1}`) instead of `util.inspect`
  (`{ a: 1 }`) — deterministic, and a side effect of the cell's no-host-object rule.
  Measured cost: none measurable (n=50, fresh-spawn medians ~35–37ms, same as before the
  cell). Accident-surface reduction, **not** a security boundary (trust posture unchanged;
  Node's `vm` is not a sandbox against determined adversaries — see ADR-0019 for the
  residual cosmetic leaks). Deliberately not adopted from the reference designs: determinism
  bans (no replay/journal to serve), process-per-run (warm pool is an asset), QuickJS (WASM
  dependency with no matching gain). 35 new test cases cover visibility, the escape battery
  (13 cases, incl. preamble-internal names), cross-realm semantics, isolation, and protocol
  edges — each proven live by mutation probes (3 mutations, each turning exactly its own
  cases red).

## [6.2.0] - 2026-10-28

### Added

- **Lean child process argv**: children are now spawned with `--no-extensions --no-skills`
  (extension discovery noise — user skills, host-side prose, discovered extensions — no longer
  rides into every child), and `--no-mcp` when the host pi is ≥ 1.1.0 (the flag first appears
  there; `EngineContext.piVersion` is resolved once at session start). Measured on real
  children: worst-case per-child input drops 86% (32524 → 4356 tokens).
- **Cache-aware usage observation**: the JSONL stream parser now carries pi ≥ 1.4.0's
  `usage.cacheRead` / `usage.cacheWrite` into the observed usage (absent on older pi, floor-safe).

### Changed

- **Tighter child report contract prose**: summary is the deliverable, findings carry
  load-bearing evidence only, no recapping read content, no report .md files. JSON shape
  unchanged. Measured output reduction: -57% on recap-prone tasks, -9~23% on mixed tasks.
- `create-a-task.md` gains briefing discipline (exact paths, state what the final message
  must carry, merge same-domain work into one serial child).
- `docs/pi-version-matrix.md`: `--no-mcp` first-appearance (1.1.0) and 1.4.0 usage cache
  fields recorded.

## [6.1.0] - 2026-10-27

### Added

- **Task traces have a capacity boundary and a compressed archive** (spec decision 29).
  Terminal records are capped at the newest 500 (`taskTraceKeep`, evicted oldest-first
  by `(finishedAt, taskId)`; non-terminal records are never evicted). Runtime evictions
  are archived — record and output gzip-compressed (3.4x measured on real child
  streams) on an async event-loop chain the main path never waits on; boot-time
  history is deleted directly. Archived traces stay retrievable by exact id through
  `ptc_task_output` for 30 days from archival (`archiveTtlDays`; archive files are
  purged at boot, 500 per pass). All three knobs live in `~/.pi/agent/ptc.json`;
  `archiveEnabled: false` restores immediate delete.
- **`outputTruncated` on task records and results.** Child stdout now has a 16MB
  tail cap (the stderr cap's long-missing twin), so a runaway child can no longer
  exhaust the host's memory; the record says when the trace is tail-only.

### Fixed

- **The task door no longer advertises a `cwd` parameter nothing consumed** (audit F1).
  It was pre-planted in the shared parameter table, but neither entry point forwarded
  it and no engine layer accepted it; the schema now tells the truth.
- **Search memory keeps pages opened directly** (audit F5). `open` on a URL that
  never appeared in search results previously had its text silently dropped, so a
  later `find` on the same page re-fetched and double-spent quota; a fallback bucket
  (same 400K budget) now holds it.
- **Value-tree rendering enforces the frozen contract** (audit F7, ADR-0016): at most
  6 children per level with an explicit `…（余 N 项）` marker, and line width back to
  the contracted 120 — previously a 100k-element array rendered in full before the
  downstream truncator threw the work away.
- **Pooled workers drop their per-run listeners when returned** (audit F8); dozens of
  programs in one turn no longer pile dead closures on the reused workers.
- **The task face no longer removes user-pinned tools** (audit F9): visibility sweeps
  with zero records now retract only tools the session added itself.
- **Dead code removed** (audit F6): `listAgentNames`, `drainGraceMs`, a duplicated
  `pi-tui` devDependency; three rich-row renderer bounds formally de-registered via
  [ADR-0016](docs/adr/0016-render-bounds-cleanup.md) instead of being deleted as junk.

### Changed

- **Value-tree lines narrow from 200 to the contracted 120 characters** — a
  model-visible shortening of oversized render lines.

## [6.0.3] - 2026-10-26

### Fixed

- **The route index fits its token budget again.** Every route line carried the
  detail file's absolute path; in an installed package that pushed the index to 695
  tokens against the 560 ceiling, so every turn's system prompt ended with a
  `> WARNING: index over token budget` line — and the warning told the model to
  move the details into the directory they were already in. The directory is now
  stated once and each line keeps only the file name: 481 tokens.
- **`/ptc mode` no longer claims it is narrowing.** PTC mode stopped narrowing the
  tool loadout in 6.0.1, but the command's reply still read `mode=on（收窄中）`.
  It now reads `on（引导层）`.
- **A tool result that is an image no longer carries its base64 into the program.**
  pi's `read` returns `{type:"image", data:<base64>}` for image files, so the whole
  image ended up in the program's return value as text — while the image itself was
  already handed to the model as an image block. The bridge now returns the
  readable note instead.
- **The binding scope no longer lists tools the session cannot call.** The fallback
  to "every registered tool" now applies only to the pi versions without a
  nested-call channel (0.86/0.87). On 0.99+ the session's own active set is used,
  so a session that narrowed its tools no longer sees bindings that would be
  rejected on the first call.

### Changed

- The seven route detail files live in one place now
  (`packages/routes/docs/routes/`); the identical copy at the repository root is
  gone, and the copy `prepack` drops there is now git-ignored.
- ADR-0015 records the reversal of its "no absolute path in the index" decision,
  the token ruler it actually uses, and the cost of the PTC-mode switch.

## [6.0.2] - 2026-10-26

### Fixed

- **Program-internal tool calls work across the whole supported range.** The tool
  execution context sits in a different argument slot on older pi releases, so the
  bridge now identifies it by "whoever carries `executeTool`" instead of a fixed position.
- **Tools return text to programs on every version.** pi 0.99–1.0.3 hand back a
  content-block array where 1.0.4+ hands back a string; the bridge normalises both into
  text, so `tools.read` reads the same way everywhere.
- **The binding scope is read from the session's own tool set.** On pi 0.86 and 0.87
  `getActiveTools()` lists only an extension's own tools, so the built-in tools are taken
  from `getAllTools()` there; on 0.99+ the active set is the declared set and is used as is.
- **A clear message where the platform has no channel at all.** pi 0.86 and 0.87 expose no
  nested tool execution API; a program's `tools.*` call now says so — "this pi version has
  no in-program tool channel (needs pi ≥ 0.99)" — instead of failing vaguely.

## [6.0.1] - 2026-10-26

### Fixed

- **Programs can call the session's tools again.** The binding bridge looked for
  `ctx.executeTool` on the session context. pi 1.4.0 exposes it on the **tool execution
  context** — `execute(toolCallId, params, signal, onUpdate, ctx)` — with the signature
  `executeTool(name, args, options)`. Every `tools.*` call inside a program failed with
  "executeTool 不可用". Measured on a real pi: a program that reads `/etc/hosts` now gets
  its length back.
- **Route details ship with the package and resolve.** The seven `docs/routes/*.md` files
  are in the npm tarball now, and the route index points at their absolute path inside the
  installed package, so the model's `read` finds them instead of a path relative to the
  user's project.

### Changed

- **PTC mode no longer narrows the tool loadout.** On pi 1.4.0 a tool is callable from a
  program only while it is active, so narrowing took `tools.read` away from programs too
  ("Tool read not found"). A built-in tool's exposure is not an extension's to set, so the
  two cannot both hold. PTC mode is now a routing lead in the system prompt: the built-in
  tools stay visible and callable, from the model and from programs.

## [6.0.0] - 2026-10-26

### Changed

- **Clean-room rewrite.** The package is rebuilt as seven packages — `entry`, `ptc`,
  `dispatch`, `task`, `tui`, `routes`, `search` — and ships as one self-contained
  artifact. The previous implementation is preserved on `backup/main-legacy-20261026`.
- **Two surfaces, detected.** `full_ptc` keeps the PTC pair model-facing; `codemode_ptc`
  registers underneath pi's codemode and exposes the task door to scripts. There is no
  setting.
- **Subagent dispatch is a task engine.** Every dispatch gets a record, a slot, and its
  own `pi` process. Busy means queue, not reject. Reports arrive through
  `ptc_child_report` first, with the trailing-JSON channel as fallback.
- **The task face** (`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`) appears only
  while there is a task to see.
- **Web search lives in children.** `web_ds_search` registers only inside dispatched
  children and is off by default.

### Compatibility

- pi `>= 0.86.0`. Real-machine smoke tests cover 0.86.0, 0.87, 0.99, 1.0, 1.1, 1.2,
  1.3, and 1.4 — including a program that dispatches a real child process.
