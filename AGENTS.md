## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used as label strings directly. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.

## Code review tooling

This repo has both **CodeGraph** and **open-code-review (ocr)** initialized and ready to use:

- **CodeGraph** (`.codegraph/codegraph.db`, 4.32 MB SQLite, 851 nodes / 4 398 edges) — `codegraph status` to confirm health, `codegraph explore <symbol>` for one-shot symbol source + caller paths + blast radius, `codegraph callers <symbol>` for raw caller list. Use in code review and large refactors; the spec axis of the `code-review` skill relies on this for blast-radius evidence.
- **open-code-review** (`ocr` CLI v1.12.9, configured at `~/.opencodereview/config.json` with `deepseek` provider + `deepseek-flash` model) — `ocr delegate preview --format json` for reviewable files, `ocr delegate rule --format json <paths>` for per-file checklists, `ocr review --format json --rule .opencodereview/rule.json` for a full default-mode review (uses the configured LLM). Project rule overrides at `.opencodereview/rule.json` (NOT `.ocr/rule.json`); rule docs at `.opencodereview/rules/*.md`. Schema is `ProjectRule` (`rules: [{path, rule, merge_system_rule}]`), not the system-rule `default_rule + path_rule_map` shape.
- **Code review skill** at `.agents/skills/code-review/SKILL.md` — thin orchestrator that runs OCR delegate + CodeGraph + two parallel sub-agents (Standards / Spec). Project rules cover ptc-protocol-pair-correctness / ptc-worker-lifecycle / ptc-render-bounds / ptc-bgdispatch-contract / test-discipline (-oracle). Meta-discipline fixture `tests/test-meta-discipline.test.ts` automatically flags F1 (accept-both regex), F2 (conditional assertion), F3 (opt-in gate + early return) — see `docs/testing-constraints.md` for the 6 testing hard constraints. The fixture MUST stay green; if it goes red, fix the offending test before merging.
- **`ocr delegate preview` excludes `tests/**` from `reviewable_files` (`exclude_reason: "default_path"`).** The test-discipline project rules still resolve — but only when a test path is passed explicitly, so the oracle audit must enumerate the diff's test files itself and call `ocr delegate rule --format json <those paths>` rather than relying on the preview list. Likewise check every anchored path actually resolves a **project** rule (`Source: project`), not the system built-in: an anchor that no longer matches a moved/renamed file silently degrades the whole audit to the generic checklist. Do not trust a hand-maintained anchor list — read `.opencodereview/rule.json` and run the coverage check on the diff under review:

```bash
ocr delegate preview --format json --from <fixed> --to HEAD > /tmp/pv.json
python3 - <<'PY'
import json, subprocess
files = [f["path"] for f in json.load(open("/tmp/pv.json"))["reviewable_files"]]
d = json.loads(subprocess.run(["ocr","delegate","rule","--format","json",*files],
                              capture_output=True, text=True).stdout)
print("SYSTEM-ONLY:", [f for g in d["groups"] if g["source"] != "project" for f in g["files"]])
PY
```

Anything important left in `SYSTEM-ONLY` (other than config/JSON) is a missing anchor — add it, with `merge_system_rule: true` when the file is not contract-specific so the generic checks survive alongside the project rule.

## Review rounds and closure discipline

A review of a large change is one round; its findings are recorded in a ledger under `docs/reviews/` (finding → evidence → disposition → the commit that closed it), and the next round is a **delta** over the fix commits. Two rules come from real over-claims in this repo:

- **A closure is only genuine when reverting the fix turns a named test red.** "The wire exists" is not closure, and neither is a green suite: the first review-1 pass marked R-m12 closed on a grep that found the new helper, but the helper had **zero production callers** and a test even asserted the field was `undefined`. Cite the test by name and state the counterfactual, or leave the row open.
- **A diff review cannot see a gate the diff breaks but does not live in.** Run the whole-tree release gate before calling a change done: `pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run build && pnpm exec vp test --run --coverage && pnpm run verify:dist`. The background-dispatch feature passed three review rounds and 696 tests while `scripts/verify-dist-render.mjs` still asserted exactly **two** registered tools, so `pnpm run build` + `verify:dist` failed on the release artifact, and three files tripped the repo-wide `fmt:check` even though their authors had run oxfmt over a hand-picked file list. Both were invisible to every diff-scoped review.
- **When a reviewer challenges a finding you wrote, measure or refute with evidence, and record the correction in the ledger.** A parent-side O(N²) claim against `FileTaskStorage.appendEvents` was refuted by a counting-fs test (50 subscriptions → exactly 1 read) and the ledger now marks that row `REFUTED` rather than quietly dropping it. Over-claimed closures and un-refuted findings both cost the next round more than they save.

## Testing constraints

All new / modified tests must satisfy the 6 hard constraints in `docs/testing-constraints.md`:

1. IO 边界成功/失败双路径都有单测。
2. Mock / fixture 来自真实样例(响应快照、字面量、第三方文档)。
3. 失败路径有 warn 或显式错误状态 — 不留静默失败。
4. 期望值能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分)。
5. 反事实判据:把实现改成显然错误但符合该断言的版本,测试必须红。
6. characterization vs specification 区分:防回归 ≠ 防错误。

F1/F2/F3 (accept-both regex, conditional assertion, opt-in gate early-return) are mechanically scanned by the meta-discipline fixture.
