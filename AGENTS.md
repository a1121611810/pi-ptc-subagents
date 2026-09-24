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
- **`ocr delegate preview` excludes `tests/**` from `reviewable_files` (`exclude_reason: "default_path"`).** The test-discipline project rules still resolve — but only when a test path is passed explicitly, so the oracle audit must enumerate the diff's test files itself and call `ocr delegate rule --format json <those paths>` rather than relying on the preview list. Likewise check every anchored path actually resolves a **project** rule (`Source: project`), not the system built-in: an anchor that no longer matches a moved/renamed file silently degrades the whole audit to the generic checklist. As of 2026-09-24 the anchors are `src/runtime/protocol.ts`, `src/runtime/worker-*.ts`, `src/runtime/task-*.ts`, `src/runtime/child-process-lifecycle.ts`, `src/runtime/notification-pipeline.ts`, `src/runtime/dispatch.ts`, `src/runtime/dispatcher.ts`, `src/runtime/output-storage.ts`, `src/tools/render.ts`, `src/tools/ptc-task.ts`, `src/tools/task-panel-render.ts`, plus `tests/dispatch-*.test.ts`, `tests/unit/dispatch-*.test.ts`, `tests/e2e/**`, `tests/integration/**`, `tests/**`.

## Testing constraints

All new / modified tests must satisfy the 6 hard constraints in `docs/testing-constraints.md`:

1. IO 边界成功/失败双路径都有单测。
2. Mock / fixture 来自真实样例(响应快照、字面量、第三方文档)。
3. 失败路径有 warn 或显式错误状态 — 不留静默失败。
4. 期望值能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分)。
5. 反事实判据:把实现改成显然错误但符合该断言的版本,测试必须红。
6. characterization vs specification 区分:防回归 ≠ 防错误。

F1/F2/F3 (accept-both regex, conditional assertion, opt-in gate early-return) are mechanically scanned by the meta-discipline fixture.
