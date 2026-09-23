# 08: Code review + TDD fix loop

**What to build:** run the two-axis code review (Standards + Spec) against
the diff of tickets 01–07, fix any findings with TDD, and re-review. The
loop terminates when both axes are clean (zero hard findings on Standards,
zero missing-from-spec findings on Spec).

**Blocked by:** 01, 02, 03, 04, 05, 06, 07 (all implementation tickets).

**Status:** ready-for-agent

- [ ] Identify the fixed point (commit SHA / branch tip / `main` etc.)
      and the diff range (`git diff <fixed-point>...HEAD`).
- [ ] Run code-review skill in two parallel sub-agents (Standards + Spec).
      Standards sub-agent reads the smell baseline from the skill plus
      `AGENTS.md` / repo standards. Spec sub-agent reads this spec
      (`docs/specs/0020-0021-ptc-row-pulse-and-sub-call-tree.md`) plus
      ADRs 0020 and 0021.
- [ ] Aggregate findings into a single review report.
- [ ] For each finding (Standards or Spec): if it's a missing-from-spec or
      a hard standard violation, write a failing test in the appropriate
      `tests/...` file (per the `tdd` skill's red-green loop), then
      implement the smallest change that turns it green.
- [ ] Re-run code-review after each batch of fixes.
- [ ] Loop terminates when both axes are clean.
- [ ] Commit the fixes to the current branch (per `implement` skill).
- [ ] Final state: `pnpm typecheck`, `pnpm lint`, full test suite pass.
