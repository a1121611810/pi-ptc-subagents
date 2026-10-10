# Review round 1 — the loadout is read, and the records that said otherwise

Date: 2026-10-10. Fixed point: `43b25c8`, to `HEAD` (`fc756f8`) plus the uncommitted fixes this
round produced. Axes: Standards + Spec, per `.agents/skills/code-review/SKILL.md`.

## What was reviewed

Four commits implementing #133's three tickets:

1. `ab55df2` — #134 + #137. Registration moves from the extension factory to the `session_start`
   handler, and the activation half of surface detection stops reconstructing pi's settings
   resolution and reads `pi.getActiveTools()` instead. The command-line reader, the `defaultTools`
   merge, the precedence replay and the 294-case differential test are deleted.
2. `a603472` — #135. Fifteen `file:line` citations corrected; the review-round record block stops
   carrying line numbers.
3. `fc756f8` — #136. The citation baseline gains per-citation content tokens and a content
   assertion, armed only after #135 landed.

## Tooling state during this round

- Whole-tree OCR rule coverage: **passing**, zero `SYSTEM-ONLY`.
- `codegraph status`: 124 files / 2,565 nodes / 14,398 edges — healthy, index current.
- `ocr --version`: v1.12.11 (skill requires >= 1.9.0). OCR preview chose 4 files;
  `.md` and `tests/**` are excluded by the selection layer, so the ADR and test audits were
  run by hand per the skill's step 8.
- Two files (`src/index.ts`, `src/mode/ptc-mode.ts`) matched blocking-grade project rules, so
  both axes escalated to sub-agent review per the Q9-D hook.

## Anchor

Real pi 1.1.0, the built `dist/index.js`, one project carrying `.pi/settings.json` with
`"defaultTools": ["+codemode"]`, run twice with only the trust decision differing. The probe reads
`pi.getAllTools()` / `pi.getActiveTools()` / `ctx.isProjectTrusted()` from its own `session_start`
handler, deferred one turn of the event loop so every handler has returned.

|                                              | `-na` (declined) | `-a` (trusted)      |
| -------------------------------------------- | ---------------- | ------------------- |
| `ctx.isProjectTrusted()`                     | `false`          | `true`              |
| `codemode` in pi's active set                | **`false`**      | **`true`**          |
| surface this package registered              | `full`           | `subagents`         |
| `ptc_subagent` registered                    | **no**           | **yes**             |
| `ptc_run_code` / `ptc_workflow` model-facing | **yes** (direct) | no (codemode reach) |

Same project file in both runs. Under the previous implementation the `-na` row read that file off
disk, resolved `active`, chose `subagents`, and registered the pair at `codemode` reach — with no
`codemode` running, reachable from nowhere. That is #131, and this is it not happening.

## Findings

### Blocking

| #   | finding                                                                                                                                                                                                                                                                                                              | disposition                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **The working tree failed the gate this diff adds.** Uncommitted comment edits in `src/index.ts` shifted two pinned lines by +4 / +6; the #136 content assertion named both.                                                                                                                                         | **Closed.** Both axes found it independently and gave the same counterfactual. Fixed before this ledger: `src/index.ts:908 → 914` and `859 → 863`, in the ADR text, the baseline and the token table. |
| B2  | `src/index.ts` still documented the deleted reconstruction on the `codemodeActivation` seam — "reads pi's real settings files AND this process's `argv`", "reads `defaultTools` out of `~/.pi/agent/settings.json`". The identical wording _was_ fixed in `tests/helpers/ptc.ts`; this site was missed.              | **Closed.** Rewritten to state what the probe reads now.                                                                                                                                              |
| B3  | **ADR-0029 still presented the mirror as live**, and this diff had edited that file (renumbering its citations). `§Absence of evidence` and `§The mirror` described deleted functions in the present tense; `§We do not make the session_start measurement authoritative` argues for the decision ADR-0035 reverses. | **Closed.** Status line amended; three in-place blockquotes marking each section as amended/reversed by ADR-0035. ADR-0026 got the same treatment in the commit under review.                         |
| B4  | "Registration happens in the factory" survived in four places, all falsified: `src/index.ts` (`registered at factory time`, `off has already returned at the top of the factory`, `after the off early return`) and two test file headers in this diff.                                                              | **Closed.** Root cause named in the code: the registration block was moved verbatim by ADR-0035 and its comments were not updated with it.                                                            |

Also fixed while closing B4, and reported rather than absorbed because it is outside the diff:
`src/runtime/background-runtime.ts` claimed the background surfaces are "built ONCE, at
extension-factory time". The holder is; the tool definitions capturing it no longer are.

### Not blocking

- `CodemodeActivationSource` still carries `"invalid"` and `error` documents "a settings file that
  could not be read" — no producer sets either now. **Left open**, recorded here: the member and
  the doc are consistent with each other, so this is dead surface rather than a false claim, and
  removing it is a contract change belonging to its own ticket.
- `scripts/verify-dist-render.mjs` — two header comments still said activation reads
  `<agentDir>/settings.json`. **Closed** with B2's wording.
- Fowler: `src/mode/ptc-mode.ts` has three consecutive floating JSDoc blocks with no declaration.
  **Left open** — they are the tombstones for the deleted machine, and a tombstone is the one case
  where a comment without a declaration is the point.
- The meta-discipline fixture (`tests/test-meta-discipline.test.ts`) walks only `*.test.ts`, so
  `tests/helpers/ptc.ts` — which now decides whether `session_start` fires at all — is outside
  every F1–F4 scan. **Recorded, not fixed**: this is a gap in the fixture's scope, not a defect in
  the diff, and widening the scan is its own change.

## Counterfactuals run

Each mutation in a `git worktree`, never in the tree under test, per the rule #137 added; the
source file's `sha256` checked before and after.

| ticket | mutation                                                            | went red                                                 |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------- |
| #134   | settings read put back into `readCodemodeActivation` (the #131 bug) | the #131 case                                            |
| #134   | the loadout argument ignored, `active` hardcoded                    | four cases                                               |
| #136   | five lines of churn above the constants block                       | the content assertion, naming both newly-wrong citations |
| #136   | one token deleted                                                   | "every baseline entry carries an identifier"             |
| #136   | the check stubbed to return no offenders                            | the counterfactual                                       |

`src/mode/ptc-mode.ts` and `src/tools/render.ts` were byte-identical after their rounds.

### Round 2 — delta over the fix commit

Per this repository's closure discipline the next round reviews the fix commits rather than the
whole change. Scope `fc756f8..HEAD`: nine files, and all but the ledger are comments or prose.

**No new findings in the deliverable.** The two named-but-unfixed sites this round closed were the
ones round 1 listed as "same class, outside the diff": `ADR-0033` asserted the activation probe
"reads the developer's own `settings.json`" — a sentence written during this very change and
falsified by the next commit in it — and `ADR-0030` carried the inference ADR-0035 exists to
correct ("the filesystem, at factory time, because it is the only moment the answer can be used").
Both now state what is true and keep the old claim visible rather than deleting it.

Anchor re-taken on the **rebuilt** artifact, because the fixes touched `src/index.ts` even though
only its comments changed: declined → `codemodeActive: false`, no `ptc_subagent`, no subagent face;
trusted → `codemodeActive: true`, `ptc_subagent` registered and model-facing. Same two rows as
before the fixes, as expected of a comment-only change, and measured rather than assumed.

## Verdict

Round 1 **advanced**; round 2 **passed** with the anchor green, which is the stop condition. the four blocking findings are closed, the anchor is green,
and no finding was raised against the deliverable that this round's own fixes did not introduce.
Whole-tree gate green at close: `typecheck`, `lint`, `fmt:check`, `build`,
`1104 passed · 5 skipped (1109)`, `verify:dist 29/29` on the rebuilt artifact.

One observation worth carrying forward rather than a finding: **three of the four blocking
findings, and the two ADR ones, were the same defect** — a record asserting behaviour the code no
longer has, produced by moving code without moving its account of itself. #135 and #136 exist to
catch exactly that class in citations; nothing catches it in prose, and this round is the evidence
that the class is still the expensive one here.
