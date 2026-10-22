## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used as label strings directly. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.

### pi compatibility matrix

The package tracks pi releases and declares a peer range the default gate only measures one point
of. `pnpm run compat:pi` runs the gate against the floor and the ceiling. See
`docs/agents/pi-compat-matrix.md` — read it before touching the codemode probes, the binding
contract, or the declared peer range.

## Model-facing text and PTC programs

Each of these has one source. Edit the source, not the copy.

- **Model-facing prose lives in the route registry** (`src/routes/registry.ts`) — every sentence the
  model reads about a tool (what it is, when to pick it, what it returns). Tool files carry
  schemas and behaviour only. Read the "route registry" entry in
  [GLOSSARY.md](./GLOSSARY.md) before changing a tool description, a tool name, or the `<ptc>`
  section.
- **PTC programs run in strict mode** — an undeclared assignment is a `ReferenceError`, top-level
  `this` is `undefined`, a duplicate parameter is a compile-time `SyntaxError`. Read the "strict
  program" entry in [GLOSSARY.md](./GLOSSARY.md) before writing or reviewing a PTC program.

## The website

`packages/website/` is a second workspace member with **its own five checks and its own deployment**,
excluded from the root gate by ADR-0036. Before changing anything under it, read
`packages/website/README.md` — it lists every check, what turns each one red, and where each one
runs. The five site checks run on a pull request (`.github/workflows/website.yml`) as the **same
command** the deploy runs, which is what keeps the merge-gating set and the deploy-gating set from
drifting apart.

## Code review tooling

This repo has both **CodeGraph** and **open-code-review (ocr)** initialized and ready to use:

- **CodeGraph** (index at `.codegraph/codegraph.db` — run `codegraph status` for the current file / node / edge counts and DB size; do not trust a number written here) — `codegraph explore <symbol>` for one-shot symbol source + caller paths + blast radius, `codegraph callers <symbol>` for raw caller list. Use in code review and large refactors; the spec axis of the `code-review` skill relies on this for blast-radius evidence.
- **open-code-review** (`ocr` CLI — run `ocr --version` for the installed build; the version baseline is the behaviour the assertions in `tests/ocr-anchor-coverage.test.ts` pin, not a number written here; configured at `~/.opencodereview/config.json` with `deepseek` provider + `deepseek-flash` model) — `ocr delegate preview --format json` for reviewable files, `ocr delegate rule --format json <paths>` for per-file checklists, `ocr rules check <file>` for one-file resolution, `ocr review --format json --rule .opencodereview/rule.json` for a full default-mode review (uses the configured LLM). Project rule overrides at `.opencodereview/rule.json` (NOT `.ocr/rule.json`); rule docs at `.opencodereview/rules/*.md`. Schema is `ProjectRule` (`rules: [{path, rule, merge_system_rule}]`), not the system-rule `default_rule + path_rule_map` shape. **`rule.json` has no header comment to read** (it is JSON) — the authoring manual is `docs/agents/ocr-rules.md` (schema, ordering, merge semantics, file-type coverage, new-anchor template, all verified against the pinned behaviour baseline).
- **Code review skill** at `.agents/skills/code-review/SKILL.md` — thin orchestrator that runs OCR delegate + CodeGraph + two parallel sub-agents (Standards / Spec). Project rules: `ptc-protocol-pair-correctness` (3a) / `ptc-worker-lifecycle` (3b) / `ptc-bgdispatch-contract` (3d) / `ptc-config-wiring` (3e, read-point evidence) / `ptc-render-bounds` (3c) / `test-discipline` + `test-discipline-oracle` / `doc-sync` (3f), plus `general.md` as the `**` catch-all floor (12 Fowler smells + triggered dimensions). Meta-discipline fixture `tests/test-meta-discipline.test.ts` automatically flags F1 (accept-both regex), F2 (conditional assertion), F3 (opt-in gate + early return), F4 (assertion-free test body) — see `docs/testing-constraints.md` for the 6 testing hard constraints. The fixture MUST stay green; if it goes red, fix the offending test before merging. **This skill is a project-level fork of the upstream `mattpocock/skills` `code-review` skill and does NOT follow upstream automatically** — its baseline commit, the per-change verdicts (adopt / adapt / reject) and the re-sync command live in `docs/agents/code-review-upstream.md`. **评审装置的三层归属(事实层 / 判断层 / 机械层)、层间不交错规则与「新增规则先判层」的路由判据 = `docs/agents/review-layers.md`**(唯一实体;`SKILL.md` 与 `docs/agents/ocr-rules.md` 各留一条指针,不复制那张表)。
- **`rule.json` is strictly first-match-wins.** Order in the array is priority, so the `**` catch-all MUST stay last — anything more specific inserted after it is silently shadowed and its rule never fires. `merge_system_rule: true` merges the generic system checks alongside the project rule; use it for every non-contract file or the generic checks get squeezed out.
- **OCR has a parse layer and a selection layer, and they disagree about `.md`.** `.md` resolves fine at the parse layer (`ocr rules check` and `ocr delegate rule` both return a project group for markdown), but the selection layer drops it: `ocr delegate preview`, `ocr review` AND `ocr scan` all mark every `.md` `will_review: false` with `exclude_reason: "unsupported_ext"` (measured: every `.md` in `ocr scan --preview` is `will_review: false` — the count grows with the repo, so read the flag, not the count). `.yml` is **not** excluded: CI workflows are reviewable. **Docs / ADRs / READMEs cannot be delegated to OCR** — enumerate the changed `.md` paths yourself and pass them to `ocr delegate rule` to get the `doc-sync` checklist, then apply it by hand. `ocr scan` is NOT a workaround for this.
- **`ocr delegate preview` excludes `tests/**` from `reviewable_files` (`exclude_reason: "default_path"`).** The test-discipline project rules still resolve — but only when a test path is passed explicitly, so the oracle audit must enumerate the diff's test files itself and call `ocr delegate rule --format json <those paths>` rather than relying on the preview list. Likewise check every anchored path actually resolves a **project** rule (`Source: project`), not the system built-in: an anchor that no longer matches a moved/renamed file silently degrades the whole audit to the generic checklist. Do not trust a hand-maintained anchor list, and do not trust a single-file `ocr rules check` — it cannot see leaks elsewhere. Run the whole-tree coverage check:

```bash
ocr delegate rule --format json $(git ls-files 'src/*.ts') | python3 -c "import json,sys;d=json.load(sys.stdin);bad=[f for g in d['groups'] if 'built-in' in g.get('source','').lower() or g.get('source')=='system' for f in g['files']];print('SYSTEM-ONLY:',bad);sys.exit(1 if bad else 0)"
```

Anything left in `SYSTEM-ONLY` is a missing anchor. This check is not optional: before the `**` catch-all existed, **7 of the 33 `src/*.ts` files that existed at the time** had no project rule at all — including `src/runtime/limits.ts`, the single declaration site for every `PtcConfig` key — and they were being reviewed against generic JS/React boilerplate (`React Best Practices`, "prohibiting var", "== is prohibited"). Add the anchor with `merge_system_rule: true` when the file is not contract-specific.

`tests/ocr-anchor-coverage.test.ts` mechanises the invariants: no orphan rule file (a rule nothing references is dead — `general.md` was one for its entire life while SKILL.md and this file cited it as a live source), no dangling anchor target, catch-all last, catch-all merges the system rule, and `Source: Project` + resolved rule title for every sentinel file that test lists. Its `ocr`-dependent assertions use `test.skipIf` so a machine without `ocr` reports SKIPPED rather than passing silently. `tests/code-review-skill-sync.test.ts` mechanises the skill file's own checkable claims, so the skill cannot silently drift away from `rule.json` or the repo again.

## Dispatching sub-agents

Parallel dispatch needs **disjoint ownership**. Two axes reading cost nothing; two builders editing
one file overwrite each other unnoticed, and the half-applied state surfaces later as a diff-review
finding. Name each builder's files before spawning.

**Own only what you changed.** Rewriting neighbouring lines you did not need to touch -- a reformat, a
drive-by fix -- is how your patch becomes someone else's conflict.

A builder that finds its file rewritten **reports the collision and stops**. Measured twice in one
round: the recovery (`git show HEAD` + rebuild) cost more than the collision, and the second rebuild
shipped a commit message whose numbers contradicted the document inside the same commit.

## Stopping a review loop

A review round with no stopping condition becomes a generator, not a detector: the reviewer is asked
to produce findings, so it produces findings, and a round that finds nothing gets read as
insufficient diligence rather than as the signal to stop. Nine rounds over one feature are the
worked example -- rounds 1-5 found two defects that would have shipped (a concurrency gap, a
handle leak), and rounds 6-9 changed **no product behaviour at all**. The defect class being
chased had been measured to exhaustion by round 8. Three things made the drift possible, and all
three are properties of the setup rather than of the reviewer:

- **The reviewer is the author, and shares its model.** There is no external ground truth, so the
  standard mitigations for self-evaluation bias -- blind review, external feedback, a stopping rule
  -- are the only ones available, and the first two are not available here.
- **"Fully resolved" has no external definition**, so the reviewer supplies one, and the one it
  supplies is always "there is one more thing". Write the criterion down before round 1.
- **The loop is closed and has no outside input**: run a review, find something, that finding is
  read as evidence the loop is valuable, run it again. Findings became the loop's own evidence of
  its own worth.

Concretely, stop when **any** of these holds, and say which one:

1. **Two consecutive rounds produce no change in product behaviour.** Records, tests and docs do
   not count. A round that produces only those is a signal, not a finding -- it means the reviewer
   has run out of defects and started manufacturing coverage for correct code.
2. **The class being chased is measured to exhaustion.** Round 8 drew the line: 15 sites, 7
   unpinned, all seven named, all seven pinned. Nothing was left in the class, and round 9 bought
   test coverage for code that was already correct.
3. **The thing was verified end to end against the built artifact.** Round 7 walked five cases
   on real pi, including one with no codemode at all. That is a finished verification, not a start.

Two anti-patterns this repo paid for directly, both recorded in the rounds above: a **round that
produces only records and tests is a signal to stop, not a round to build on**, and a **reviewer
that finds something is not evidence the review process is working** -- a green suite is, and that
signal needs re-establishing rather than assuming.

**"The suite is flaky" is not a diagnosis, and this line used to stop there.** The measured case is
`tests/unit/dist-surface-decision.test.ts`: it is the only test that `await import()`s the built
bundle, the first import pays Vite's transform of a ~137 kB artifact, and under load that exceeds
vitest's default 5 s. It fails as `Error: Test timed out in 5000ms`, which reads like a broken
export and is not one -- two separate review passes hunted a stale `dist` and a missing
`detectedSurfaceMode` before anyone read the error text. It now carries an explicit timeout, and
the lesson generalizes: **read the failure text before naming the failure "flakiness"**, because a
flake is a cause nobody has found yet, and the name ends the search.

The corollary for the reviewer itself: **a round that finds a defect in the previous round's fix is
the expected rate, not an alarm.** Five rounds in a row found one, which reads as "review is
catching real problems" and is equally consistent with "each fix is landing in unpinned ground".
The way to tell them apart is the counterfactual discipline above: a round-9 finding was refuted by
running it, and a round-7 finding about a log turned out to be _less_ unpinned than the sweep
claimed. Findings rate is not defect rate.

## Review rounds and closure discipline

A review of a large change is one round; its findings are recorded in a ledger under `docs/reviews/` (finding → evidence → disposition → the commit that closed it), and the next round is a **delta** over the fix commits. Two rules come from real over-claims in this repo:

- **A closure is only genuine when reverting the fix turns a named test red.** "The wire exists" is not closure, and neither is a green suite: the first review-1 pass marked R-m12 closed on a grep that found the new helper, but the helper had **zero production callers** and a test even asserted the field was `undefined`. Cite the test by name and state the counterfactual, or leave the row open.
- **A diff review cannot see a gate the diff breaks but does not live in.** Run the whole-tree release gate before calling a change done: `pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run build && pnpm exec vp test --run --coverage && pnpm run verify:dist`. The background-dispatch feature passed three review rounds and 696 tests while `scripts/verify-dist-render.mjs` still asserted exactly **two** registered tools, so `pnpm run build` + `verify:dist` failed on the release artifact, and three files tripped the repo-wide `fmt:check` even though their authors had run oxfmt over a hand-picked file list. Both were invisible to every diff-scoped review.
- **When a reviewer challenges a finding you wrote, measure or refute with evidence, and record the correction in the ledger.** A parent-side O(N²) claim against `FileTaskStorage.appendEvents` was refuted by a counting-fs test (50 subscriptions → exactly 1 read) and the ledger now marks that row `REFUTED` rather than quietly dropping it. Over-claimed closures and un-refuted findings both cost the next round more than they save.
- **The gate audits claims it can recognise a _shape_ for; review audits prose about control flow.** `doc-integrity` 断言四 pins the in-repo `file:line` citations and fails when one is added, until a human re-confirms it line by line -- and it works: a citation added in review round 5 pointed at a line the immediately preceding comment edit had turned into a comment rather than the `new DispatchSlotCounter(...)` it claimed to name, and the baseline caught it on its first outing. The F1-F4 meta-discipline fixture is the same kind of checker over test bodies. Neither can see a _correct_ citation carrying a wrong verb, and three review rounds over one feature each found the code right and a record wrong that way -- not one of those claims was a citation that failed to resolve. **There is no cheap filter for the rest, and an earlier version of this guidance listing three verbs (`owns`, `per-run`, `always`) was deleted at round 6 for exactly that reason: those three cover 168 of 829 candidate claims, and an "unqualified universal" filter catches 674 of 829, mostly correct titles and rationale.** Do not file the meta-observation "the gate does not check claims" -- it is answered -- but do report any _specific_ claim that drifted, and name the claim a gate gap is said to hide, or it is theoretical. Do not file a doc defect the previous round already fixed; round 5 did. Reasoning, the measurements, and what would retire this decision: `docs/testing-constraints.md`, "What the gate does not check".

## Testing constraints

All new / modified tests must satisfy the 6 hard constraints in `docs/testing-constraints.md`:

1. IO 边界成功/失败双路径都有单测。
2. Mock / fixture 来自真实样例(响应快照、字面量、第三方文档)。
3. 失败路径有 warn 或显式错误状态 — 不留静默失败。
4. 期望值能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分)。
5. 反事实判据:把实现改成显然错误但符合该断言的版本,测试必须红。
6. characterization vs specification 区分:防回归 ≠ 防错误。

F1/F2/F3/F4 (accept-both regex, conditional assertion, opt-in gate early-return, assertion-free test body) are mechanically scanned by the meta-discipline fixture. F4 exists because three guards in this repo's review ledger kept their test name and their comments while asserting nothing, and vitest reports that as passed.
