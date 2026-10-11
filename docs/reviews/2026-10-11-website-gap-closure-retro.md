# Retro — closing the gaps the website shipped with

Date: 2026-10-11. Spec: issue #159; tickets #160–#167, all closed. Branch `feat/website-gates`,
squashed onto `main` as `732ab68` (PR #168). Review ledger:
[./2026-10-11-website-gap-closure-code-review.md](./2026-10-11-website-gap-closure-code-review.md).
Gap list as carried forward:
[./2026-10-10-website-code-review.md](./2026-10-10-website-code-review.md).

PR #168 already records the technical argument — what each gate catches, the two placement decisions,
the review findings. **This file records the part that does not belong to the change: the decisions
made on the human's behalf, so they can be revisited without reconstructing them from a diff.**

## The two the human asked to be able to revisit

The brief for this run said gaps 5 and 6 were deliberate boundaries with reasons behind them, and
named two things a person might want to argue with. Both turned out to need arguing with, and one of
them did not survive the check.

### Assumption 1 — gap 6 was a boundary, and it became a gate

**What was decided without asking:** the claim that "nothing checks that the prose in `docs/` matches
the code" was treated as a deferral to overturn. `check-doc-claims.mjs` now binds 19 documented
claims to named sources and runs as part of publishing the site.

**Why it is worth arguing with:** ADR-0036 had a section titled _What this does not decide_ that named
this exact gap. Overturning a deferral someone wrote down is the author's call to make, and it was
made here without one. The gate is the reason `docs/usage/structured-results.md` had been quietly
wrong about two keys for a full release.

**What it costs:** a gate whose 19 bindings are a hand-maintained list. It catches only what someone
remembered to bind, and adding a claim to a document does not add a binding. **Retiring this:** not by
removing the gate, but when the binding count stops growing on its own — a document edited and not
re-bound is the failure this cannot see.

### Assumption 2 — the literal two-way tool-name check is wrong

**What was decided without asking:** `check-landing-tool-names.mjs` was not made a two-way set
comparison. It became a partition, `MUST_APPEAR` plus `DECLARED_ABSENT`.

**Why:** `ptc_child_report` is registered but never invoked by a reader — it is what a dispatched child
calls to return its report (ADR-0032). A literal two-way comparison would demand the landing page
mention it, which is a red-on-arrival check encoding a wrong requirement. The partition enforces the
part that actually drifts: nothing is neither required nor excused.

**What it costs:** a name can be excused with `DECLARED_ABSENT` and a reader never learns why. The
partition is only as good as that list's reasoning. **Retiring this:** if a `DECLARED_ABSENT` entry is
ever added without a sentence of justification, the partition has become a suppression list.

### The one that did not hold up — gap 5 had no stated reason at all

The carried-forward gap list said external links are not gated, and called it "a deliberate boundary
with a stated reason, not an oversight". **No record stated one.** Nothing under `docs/adr/` mentions
outbound links; the only other mention in the repository is a comment in the link checker itself. PR
#168 then cited ADR-0036 as the authority that keeps the boundary — an ADR that never mentions
external links at all, and whose _What this does not decide_ section is about gap 2 and gap 6.

So the premise the run started from was half wrong: gap 6's boundary had a written reason, gap 5's
did not. The reason is real (a gate on `pi.dev` or npm's page fails on someone else's outage and on
bot protection) and it is now recorded, but it was first written into a pull-request body.

**Open question for the human:** does the external-links boundary deserve its own ADR? It is currently
a rule enforced nowhere and explained in two places.

## Other decisions made on the human's behalf

| Decision                                                      | Reasoning                                                                                                                                                         | Cost accepted                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `check-repo-metadata.mjs` runs only on `push` to `main`       | The repair for drift is `gh repo edit`, out of band; on a PR every legitimate description change would fail against something the PR author cannot fix in that PR | The gate's first real run was the merge itself, not review                                           |
| It is not in `prepublishOnly`                                 | Every other gate in the release chain is hermetic; this would make publishing contingent on GitHub's API being up                                                 | A release can ship with drift the CI job would have caught                                           |
| `check-published-manifest.mjs` uses `continue-on-error: true` | Publishing is irreversible; a red _Publish_ job reads as a failed release                                                                                         | A manifest that did not carry its promise is reported, not enforced                                  |
| Gap 4 closed by finding, not by observation                   | `npmjs.com` is unreachable from this machine by every path tried. The registry read is reachable and is what determines what the page shows                       | The page's actual rendering is still unobserved. No substitute URL was used to make it look observed |
| Counterfactuals stay in the issue record, not in the suite    | No test in this repository rewrites `src/` files; a killed process leaves a modified tree                                                                         | The counterfactuals do not re-run on regression                                                      |

## Left open on purpose

- **Gap 3 is not closed.** `homepage` reaches npm only at a release. Published `2.0.2` still carries
  the old value, so criterion 3 of #149 remains recorded as unmet rather than ticked. No tag was
  pushed and `publish.yml` was not run — pushing a `v*` tag **is** the release.
- **Gap 4 is closed by substitution, not by seeing the page.**

## Unimplemented, offered and unanswered

Three follow-ups were proposed during the run and not taken up. They are listed so the next reader
does not re-derive them:

1. `.githooks/pre-commit` — run `oxfmt --check` against staged files and refuse a staged set
   containing a packaged tarball.
2. `packages/website/README.md` — the gate table and how the three publication paths relate, plus one
   pointer line in `AGENTS.md`. Three of the site's five gates are currently named in no `.md` file.
3. `packages/website/scripts/counterfactuals/` — the mutation harnesses used to verify each gate,
   committed so they can be re-run by hand. They are deliberately not wired into the suite.
