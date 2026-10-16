# Spike: the dispatch loop end to end (strict read-only children + child report aggregation)

> Written **before** round 1, stopping criterion included (AGENTS.md「Stopping a review loop」:
> write the criterion down before round 1). Results section appended below after the run.
>
> Date: 2026-10-16. Artifact under test: installed npm package **pi-ptc-subagents 3.2.0**
> (`~/.pi/agent/npm/node_modules/pi-ptc-subagents`, same version as the `v3.2.0` tag at HEAD
> `9eef766`), driven by real **pi 1.2.0** (`~/.bun/bin/pi`), default model
> `MiniMax-M3.1-Flash-Preview` (thinking `max`), `codemode` active in `defaultTools`.
> Workload runs in this repo (`/Users/lilianda/develop/pi-ptc-subagents`) — a real tree with
> real answers to verify against, not a fixture.

## 0. What this spike is for

ADR-0016 (dispatch) → ADR-0032 (child report) → ADR-0039 (agent definition) → ADR-0041
(read-only tier) all answer variations of "how do we make a dispatched child usable, safe
and auditable". The pieces are in. **No ADR has run the whole loop once against a real
task.** This spike does, and measures it.

## 1. The three questions

- **Q1 — closure**: does the loop complete end to end with no manual intervention?
  (3 children dispatched → all fulfilled → child reports aggregated into one answer the
  parent hands back, with the three answers independently verifiable against this repo.)
- **Q2 — cost shape**: where do tokens go? parent vs each child; per-child
  input/output/cacheRead/cacheWrite/cost/turns; wall time; whether children are charged
  by dispatch concurrency cap (8) or by wall time.
- **Q3 — child report shape**: per child — `reportChannel` (tool / prompt-json / none /
  opted-out), findings count vs the 20-finding cap, whether evidence is independent,
  `files_touched`; and whether a `strict` child ever hits a wall (tries to write, hits
  the read-only tool list, reports `none`).

## 2. Stopping criterion (fixed before the run)

- **One round.** If any child fails (`failed` / `rejected` / `canceled`), record the exact
  failure shape and allow **at most one** retry, whose only purpose is to tell flake from
  defect. **No third round.**
- If all three children fulfil: record the full data and **stop**. Do not add workloads,
  do not tune parameters, do not "improve" the prompts — this measures the loop as it
  ships, not the loop as it could be.
- The run counts even if the parent chooses a different orchestration shape (e.g. does
  not use `codemode`): what it chose is the finding. Do not steer a second run to match
  this design except when the shape prevents measuring Q1/Q3 at all, which counts as the
  one allowed retry.

## 3. Workload (three narrow, independently verifiable questions)

Prompted to the parent as one natural-language task ("run these three questions in
parallel read-only children and give me one aggregated answer"):

1. In `src/runtime/dispatch.ts`, which function acquires and releases the dispatch
   concurrency slot? (verifiable: `DispatchSlotCounter`, `dispatch()`)
2. Which ADRs in `docs/adr/` carry a `withdrawn`/`amended` banner, and on what line?
   (verifiable: `grep -n "withdrawn\|amended" docs/adr/*.md`)
3. Which test pins the `readOnly` string-enum validation, and on what line?
   (verifiable: the ADR-0041 coercion test)

A `strict` read-only child gets `--tools read,grep,find,ls` plus `ptc_child_report`
(`dispatch.ts:288,1511`) — exactly the capability these questions need, so a child that
cannot answer has hit a real wall (Q3).

## 4. Measurement checklist (what gets recorded)

Per child: `status`, `exitCode`, `durationMs`, `usage{input,output,cacheRead,cacheWrite,cost,turns}`,
`reportChannel`, findings count, `files_touched`. Parent: turn count, own usage, wall time,
model, which orchestration path it took, any `rejected`/limit/warn text. Plus: the three
answers themselves, checked against this repo.

## 5. Results

**One round, no retry** (stopping criterion §2: all three fulfilled → stop). Wall 392s,
parent exit 0. Transcript `/tmp/dispatch-spike-run1.jsonl` (480 events), TaskRecords under
`~/.pi/agent/sessions/--Users-lilianda-develop-pi-ptc-subagents--/tasks/`.

### 5.1 What the parent chose

`pi_subagent` ×3 (NOT a codemode script): `pi.dispatch({ background: true, readOnly:
"strict" })`, `depth=1`, each labelled `q1-|q2-|q3-`. So the **subagent surface** line is
what a one-shot parent actually uses, and the codemode→`pi.dispatch` seam stayed
unexercised this round. Waiting was `bash sleep 45 / 60 / 75` between
`ptc_task_list` / `ptc_task_output` polls — a headless one-shot parent has no interactive
notification to wake it, so polling cost 7 bash calls, ~180s of the 392s wall.

### 5.2 The three children

| child                 | status            | duration   | channel    | findings | files_touched | child usage (in/out/turns) |
| --------------------- | ----------------- | ---------- | ---------- | -------- | ------------- | -------------------------- |
| q1-dispatch-counter   | succeeded, exit 0 | 49.5s      | `tool`     | 3        | `[]`          | 21 720 / 1 840 / 5         |
| q2-adr-banners        | succeeded, exit 0 | **219.8s** | **`none`** | —        | —             | **not captured**           |
| q3-readonly-enum-test | succeeded, exit 0 | 60.4s      | `tool`     | 5        | `[]`          | 33 385 / 5 263 / 13        |

Parent: 11 turns, `input=42 349 output=3 388 cacheRead=404 608 cacheWrite=0`,
model `MiniMax-M3.1-Flash-Preview` on `minimax-cn-512k`. PTC-side overhead is noise next
to model turns: `ptc_subagent` 138ms, `ptc_task_list` 21ms, `ptc_task_output` 1–18ms.

### 5.3 Q1 answered — yes, with all three answers verifiable

Spot-checked in this repo after the run, all exact:

- `DispatchSlotCounter` `src/runtime/dispatch.ts:88`, `tryAcquire:115`, `release:127` ✓
- readOnly enum tests `tests/bindings.test.ts:251 / :319 / :719` +
  `tests/e2e/subagent-smoke.test.ts:257` ✓
- withdrawn banners `docs/adr/0025…md:3` and `docs/adr/0030…md:3` ✓
  (amended list `0026 / 0028 / 0029 :3` parent-spot-checked, not re-verified here)

The parent volunteered the correction that the question's "acquire" is really
`tryAcquire(holder?)` — evidence the aggregated answer was read, not copied.

### 5.4 Q2 — cost shape

Token volume tracks **turn count of the child**, not wall time: q3 spent 13 turns /
59k tokens on a question q1 did in 5 turns / 23k. Parent `cacheRead` (404k across 11
turns) dominates its own cost — a polling parent pays full context re-read every sleep.

### 5.5 Q3 — child report shape, and one finding worth an issue

- `files_touched: []` on both reporting children: strict tier held, no write attempted.
- findings 3 and 5 — under the 20 cap; **the cap itself was not stressed** by this
  workload, so the cap's behaviour stays unmeasured.
- **q2 skipped the report contract → `reportChannel: "none"`,** the exact state ADR-0032
  names, and the parent flagged it unprompted and fell back to prose + its own spot-check.
  Detection works. **But `usage` lives inside `report.usage`, so a non-reporting child
  leaves no usage on its TaskRecord at all** — the spike cannot cost-account the child
  that misbehaved. Candidate issue, not filed by this spike.
- q2 was also 3.6× slower (219.8s vs 49.5s) — it read 42 ADR files instead of grepping one
  file. Non-compliance and cost co-occurred; one data point, not a claim.

## 6. Round 2 — the codemode → `pi.dispatch` seam

Round 1 answered §5.1's open end: the parent used `ptc_subagent` directly, so the seam
where a **QuickJS codemode script reaches `pi.dispatch`** (the reason the `subagents`
surface keeps the PTC pair at `codemode` reach — CONTEXT.md, _subagent surface_) was never
exercised. Round 2 steers at it deliberately; it is a **new question**, not a retry of §5.

- **Q1** — can a codemode script call `tools["pi.dispatch"]` at all, three times
  concurrently, and get three settled records back?
- **Q2 (the seam's payload)** — what does the script see per child: `reportChannel`,
  `usage`, the answer text? Foreground `DispatchResult` carries `usage` independently of
  the report channel (`dispatch.ts:2454`), so this is also the **empirical check of issue
  #199's asymmetry claim**: if the same ADR-banners question again produces a
  `reportChannel: "none"` child, its usage should be _present_ here and _absent_ on a
  background record.
- **Q3** — same three verifiable answers as round 1, for comparability.

Same three questions as round 1 (identical workload, so the child cost numbers are
comparable). Foreground `Promise.allSettled` composition is what the prompt asks for,
since that is the shape a script naturally takes.

**Stopping criterion (fixed before the run)**: one run. If the parent refuses the codemode
path or reports that the script cannot reach dispatch, **that is the finding** — record it
and stop. No re-prompting, no fallback re-run.

### 6.1 Results

**One run, no retry.** Wall 482s, parent exit 0. Transcript `/tmp/dispatch-spike-run2.jsonl`.
The run's headline is a correction of §6's own premise.

#### The seam as framed does not exist — by design

The script's first two `codemode` calls both failed identically:

```
TypeError: tools.pi.dispatch does not exist. ALL_TOOLS lists every tool; …
```

Enumerating the sandbox's own tool table settles it: **44 tools, no `pi.dispatch`**; the
`ptc_*` entries are `ptc_run_code`, `ptc_workflow`, `ptc_subagent`, `ptc_task_list`,
`ptc_task_output`, `ptc_task_stop`. So a QuickJS script cannot call the parallel binding
**directly** — exactly what CONTEXT.md (_Registration is not the same question as being
offered_) says: `pi.dispatch` is reachable "**underneath** `codemode`", i.e. through a
`ptc_run_code` / `ptc_workflow` program, not as a codemode tool. The brief asked for the
direct call; the product is right and the brief was wrong. Recorded, not retried.

#### What the parent did instead

It fell back to `ptc_subagent` (present in the table), self-recorded
`"dispatchBindingUsed": "ptc_subagent"`, and aggregated per child: `status`, `exitCode`,
`readOnlyTier`, `reportChannel`, `usage` (e.g. Q1 `input=21636 output=3514 cost=0`), the
report summary and the answer. So the **aggregation half** of the seam is proven; the
**binding half** (`codemode → ptc_run_code → tools["pi.dispatch"]`) remains unmeasured.

The fallback script carries a comment claiming "a pi install with the extension on the
top-level surface does not register the parallel binding" — a misreading of the design
above, and a good example of why the composition path needs its own doc sentence: a
sandbox-level user cannot see the binding's existence from the tool table.

#### Cost: iteration, not product

The model's own script had an index bug (`normalizeOutcome` on an undefined question),
so it ran **two** batches of three children: `ptc_subagent` 35.3 / 46.3 / 85.5s, then
50.5 / 91.5 / 130.4s. Parent: **32 turns, input 52 629, output 13 366, cacheRead
1 516 544** — 3.7× round 1's cacheRead, all of it the price of a failed first attempt
inside the agent's own program. Round 1's single-batch parent was 11 turns / 404 608.

#### Reports, and #199 not re-tested

All six children returned `reportChannel: "tool"` (findings 8/6/6 and 7/4/9, still under
the 20 cap — the cap stays unmeasured). The `reportChannel: "none"` case did **not**
recur, so §6 Q2's empirical check of #199's asymmetry claim **did not happen this round**.
It stays a code-level claim only (`dispatch.ts:2154-2168` vs `:2454`).

#### Answers: same questions, different granularity

Round 2's Q1 asked "which **function**", and the child answered at function level
(`dispatch()` declared `:2259`, `slots.tryAcquire()` `:2313`, `slots.release()` `:2382`),
where round 1's child answered at counter level (`DispatchSlotCounter` `:88`, `:115`,
`:127`). Both correct; the question wording differed. The parent spot-checked all three
answers against the files itself — `:2313`/`:2382`, the two `withdrawn` status lines, and
`tests/bindings.test.ts:251` all verified in-run.

#### Artifact

The model wrote `scripts/dispatch-three-questions.codemode.js` into the repo and ran
`oxfmt` over it; moved out to `/tmp/dispatch-spike-run2-codemode-script.js` so the spike
leaves no unowned file in `scripts/`.

## 7. Round 3 — the seam that actually exists: `codemode` → `ptc_run_code` → `pi.dispatch`

Round 2 proved the sandbox cannot reach the binding **directly** (§6.1) and that the
aggregation half works via `ptc_subagent`. The untested path is the one CONTEXT.md
describes: the PTC pair sits at `codemode` reach, so a codemode script can call
`tools["ptc_run_code"]` with a program that itself calls `tools["pi.dispatch"]` — the
binding lives in the **Node worker**, not the sandbox.

- **Q1** — can the PTC program reach the parallel binding? (expected: yes; the binding is
  in the worker table per `bindings.ts:393` + ADR-0016.)
- **Q2 — the double hop's payload**: what crosses each hop? The program's completion value
  back through `ptc_run_code` into the codemode script, and from there to the model. Does
  the aggregation inside the program see `status` / `reportChannel` / `usage` per child?
- **Q3 — parallelism at the inner level**: are all three children genuinely in flight
  together? Measurable: the `ptc_run_code` tool's own `durationMs` versus the sum of the
  three child durations. Parallel ⇒ near the max, not near the sum.
- **Q4** — the same three answers, verified again in-repo.

Same workload as rounds 1 and 2. The prompt forbids the `ptc_subagent` fallback: the
target is the inner path, and round 2 already banked the fallback.

**Stopping criterion (fixed before the run)**: one run. Whatever path the parent ends up
taking is the result — including "it could not reach the binding from inside the program",
which would be a **product** finding rather than a brief finding. No retry.

### 7.1 Results

**One run, no retry, no fallback** — `ptc_subagent` call count: **0**. Wall 366s, parent exit 0.
Transcript `/tmp/dispatch-spike-run3.jsonl`.

#### Q1 — the binding is reachable from inside the PTC program

The codemode script made exactly one call, `tools["ptc_run_code"]({ code: program })`, and
the program fanned out `Promise.allSettled(QUESTIONS.map(q => tools["pi.dispatch"]({ task,
cwd: ".", readOnly: "strict", label: q.child })))`. Three children, all fulfilled, exit 0,
`readOnlyTier: "strict"`, `files_touched: []`, `reportChannel: "tool"` on all three. So the
seam CONTEXT.md describes is real: **sandbox → `ptc_run_code` → worker → binding**.

#### Q2 — what crossed each hop

Per child, the program had `status`, `started`, `exitCode`, `readOnlyTier`,
`reportChannel`, `durationMs`, `usage`, plus the parsed report (summary, findings,
`files_touched`) and the answer text; the program's return value carried that aggregation
back through `ptc_run_code` into the codemode script, which printed it verbatim (script
161.6s ≈ tool 161.5s — no reshaping cost). `usage` per child:

| child                 | durationMs | input  | output | cacheRead | turns |
| --------------------- | ---------- | ------ | ------ | --------- | ----- |
| q1-dispatch-counter   | 93 552     | 12 114 | 4 333  | 214 016   | 10    |
| q2-adr-status         | 161 375    | 51 665 | 9 343  | 208 097   | 10    |
| q3-readonly-enum-test | 81 190     | 22 278 | 3 700  | 167 040   | 8     |

The parent also flagged the API subtlety the program had to respect: `pi.dispatch` never
throws, so a refusal is a **fulfilled** promise carrying `status: "rejected"` — real
`allSettled` semantics means checking `.status`, not `settled.status`.

#### Q3 — parallelism, proven by wall time

`ptc_run_code` wall **161 468ms**; children 93.6s / 161.4s / 81.2s → sum **336.1s**, max
**161.4s**. Wall = max + ~100ms. The three children were genuinely in flight together
across two hops of orchestration; the composition cost the slowest child, not their sum.

#### Q4 — answers verified in-repo

All three verified against the files after the run:

- `dispatch()` `:2259`, acquire `:2313`, releases `:2319/:2354/:2382` ✓ — **and the child
  corrected the question's premise**: `dispatchBackground()` (`:1914–2227`, acquire `:1942`)
  owns the same counter too.
- Banner classification ✓: `0025:3`, `0026:3`, `0028:3`, `0029:3`, `0030:3` on the status
  line; `0018:18`, `0022:9` as `> Amended by` notes; and it explicitly **excluded**
  near-misses — `0031:3` "Amends", `0040:3` "Not an amendment", `0016:7` "Amendment".
- `tests/bindings.test.ts:251` ✓.

One claim did not survive checking: the child's file inventory said "41 files (40 ADRs +
README)". Actual: 40 `.md` files in `docs/adr/` = **39 ADRs + README** (0001 and 0006 have
no file). The substantive answer is exact; the inventory count was off by one — and the
same child type got the count wrong in round 1 (said 42). Cheap to catch only because the
claim was checkable, which is the point of the evidence column.

#### Parent cost and artifact hygiene

Parent: 16 turns, `input=15 742 output=11 174 cacheRead=759 424` — one-shot success, no
retry tax (round 2 was 32 turns / 1.52M cacheRead after its own script bug). The program
was written to `.scratch/ptc-three-questions.ts`, which the parent justified as gitignored
so it could not turn `fmt:check` red — better citizenship than round 2's `scripts/` file.

## 8. Three rounds, one table

|                          | round 1                        | round 2                             | round 3                                      |
| ------------------------ | ------------------------------ | ----------------------------------- | -------------------------------------------- |
| path taken               | `ptc_subagent` ×3 (background) | codemode script → `ptc_subagent` ×6 | codemode → `ptc_run_code` → `pi.dispatch` ×3 |
| binding reached          | n/a                            | no (not in sandbox table)           | **yes**                                      |
| children                 | 3 (1 report channel `none`)    | 6 (all `tool`)                      | 3 (all `tool`)                               |
| parent turns / cacheRead | 11 / 404 608                   | 32 / 1 516 544                      | 16 / 759 424                                 |
| child wall, sum vs max   | 330s sum, 219.8s max           | —                                   | 336s sum vs 161.5s max ⇒ wall = max          |
| retry tax                | none                           | one failed script ⇒ 2 batches       | none                                         |

**What is now measured**: both dispatch surfaces work end to end on a real task; the
double-hop seam carries structured reports and per-child usage; concurrency is real across
the hop; `strict` held on all 12 children dispatched across the three rounds.

**What is still not measured**: the 20-findings cap (max observed 9), and issue #199's
channel asymmetry (no `reportChannel: "none"` child recurred in rounds 2–3).

## 9. Round 4 — the two remaining unmeasured claims, on purpose

Both open ends from §8, one run:

- **Q-cap (ADR-0032's 20-finding bound)**: one background child is asked for **one finding
  per ADR file** (~39 expected) instead of a summary. Then: does the **TaskRecord keep all
  of them**, and does the **model-facing render** (via `ptc_task_output`) show 20 with the
  withheld count stated in-band, as ADR-0032 claims ("Bounded at 20 findings for a
  model-facing render, withheld count stated in-band like the value tree")?
- **Q-optout (issue #199's asymmetry, deterministically)**: an agent definition with
  `childReport: false` (`.pi/agents/spike-opted-out.md`, `agentScope: "project"`) makes
  `reportChannel: "opted-out"` — the same `extraction.report === undefined` branch that
  `"none"` takes, but without depending on the model's compliance. Dispatch it twice, same
  question: **foreground** (does `DispatchResult.usage` still carry the tokens?) and
  **background** (does the TaskRecord carry usage?). #199 predicts: foreground yes,
  background no.

**Stopping criterion (fixed before the run)**: one run, three children, no retry. Expected
shapes are named above; any deviation is recorded as measured-shape-plus-deviation, not
re-run.

### 9.1 Results

**Aborted first attempt**: MiniMax returned 429 "已达到 Token Plan 用量上限" on every
attempt (pi auto-retried 3×), zero tool calls, zero children — external quota, not
product. The rerun ran on **`deepseek/deepseek-flash`** (parent `--model`, children via the
dispatch `model` argument, `dispatch.ts:1537`), because both remaining claims are
product-deterministic (a render bound; a persistence branch) and do not depend on the
model. Recorded because it changes the run's conditions: **round 4's parent transcript is
plain text, not JSON** — the rerun command omitted `--mode json`, so no per-turn parent
usage exists for this round; every claim below rests on TaskRecords and rendered tool
results, which are complete.

#### Q-cap — confirmed, and it surfaced a wording divergence

Child 3 (`01M51W7G9S2T0QVNNB4C9ND75G`), asked for one finding per ADR file:

- **Record**: `findings` length **39**, exactly the 39 `docs/adr/*.md` files (README
  excluded), one-to-one — the parent diffed the lists itself.
- **Render** (`ptc_task_output`): 20 rows, then `…+19 more findings not shown`. 39−20=19 ✓,
  withheld count stated in-band ✓. ADR-0032's bound holds.
- **Wording divergence** (found by the parent, not asked for): the background render says
  `…+N more findings not shown` (`ptc-task.ts:373`), the foreground render says
  `…+N more findings withheld (a report renders at most 20)` (`render.ts:698`). Same event,
  two wordings. Recorded here; not filed.

#### Q-optout — #199 confirmed, on two surfaces

The fixture `.pi/agents/spike-opted-out.md` (frontmatter `childReport: false`, and — my
mistake — **no `name:` key**) did not dispatch at all at first:

```
ptc_subagent refused the call: unknown agent: spike-opted-out (agentScope=project, …)
```

…while the same refusal message listed `spike-opted-out` as registered. Root cause verified
in-repo: the roster falls back to the filename on a null parse
(`dispatch.ts:1258`, `parsed?.name ?? fallback`) while discovery requires
`parsed.name === name` (`:978`) with no fallback (`:921-922` returns null when `name:` is
absent). Filed as **#201**. The parent patched the fixture to proceed and flagged the edit.

With the fixture fixed:

- **Background opted-out** (`01M51W7G9S2T0QVNNB4C9ND75F`): record carries
  `reportChannel: "opted-out"` only — no `report`, no `usage`. The predicted hole,
  deterministic.
- **Foreground opted-out**: `reportChannel: "opted-out"`; the model-facing text and
  `structuredContent` carry `{status, exit_code, report_channel}` and **no usage**, even
  though `DispatchResult.usage` is assigned unconditionally (`:2454`) — the projection
  drops it. Contrast in the same run: the report-bearing child's render carried
  `usage: input=31995 output=5888 cost=0.01763178 turns=8`. Commented on **#199** with this
  second surface.

The answers stayed clean: 15 `PtcConfig` keys, matching `limits.ts`; all children `strict`,
`files_touched` none.

The parent asked two questions and both are answered here: (1) the fixture edit is
accepted and the fixture is removed afterward — the reproducer is one nameless file;
(2) no fourth dispatch is needed — the binding path's usage was measured in round 3, and
the live claim is only about the surfaces that drop it.
