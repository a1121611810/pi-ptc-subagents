# Review — closing the gaps the website shipped with

Date: 2026-10-11. Fixed point: `7a61ea8` (main) to `37f74a6`. Spec: issue #159; tickets #160–#167, all
closed. Branch: `feat/website-gates`.

One round. It probed failure paths rather than reading the diff, and both findings were real.

## What was reviewed

Seven gaps, carried forward as _recorded_ rather than _closed_ by `docs/reviews/2026-10-10-website-code-review.md`
— six from that ledger plus #144's closing comment, and one (the projection list drifting silently)
found in ADR-0037 during the grill and brought in at the questionnaire.

## Findings ledger

### R-w3 — a gate failure escaped as a node stack trace

|                    |                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Pointing a binding at a non-existent document produced `Error: ENOENT ... no such file or directory` with a raw stack trace.                                                                                                                                   |
| **Why it matters** | That is the one failure shape a gate must never produce: it names neither the binding, nor the file the reader should look at, nor what to do. Every other path in the gate reported properly, so the defect was invisible from reading it.                    |
| **Closure**        | `37f74a6`. Now a normal failure naming the file and the code. **Counterfactual:** the same missing document now prints `cannot read docs/usage/X.md — ENOENT — the binding's source or document is not where it says it is`, exit 1, no stack. Reverted after. |

### R-w4 — one red gate hid the other three

|                                         |                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**                               | The four site checks were chained with `&&`. The first failure stopped the rest.                                                                                                                                                                                                                                                 |
| **Why it matters**                      | They are **independent** — each reads the build output and compares it against something else (the source, the projection manifest, the registered tools, the working tree). None is a precondition for another. The effect: fixing them cost one run per gate, and a change that broke two gates looked like it had broken one. |
| **Why `&&` is wrong here specifically** | `prepublishOnly` uses `&&` and is right to: typecheck gates lint, which gates build. That is a dependency chain. This was not a dependency chain, and used the only tool that fits one.                                                                                                                                          |
| **Closure**                             | `37f74a6`. `scripts/run-checks.mjs` runs all four, prints each verdict in order, exits non-zero if any is not green. **Counterfactual:** with `dispatchConcurrency: 9`, the output showed one RED and three green, exit 1. Reverted after.                                                                                       |

## Why one round, and how this stopped

Round 2 was not run. Two of the three stopping conditions hold:

- **The class is measured to exhaustion.** Each of the seven closures names the mutation that turns
  it red — 15 for the doc-claim bindings, 4 for the tool partition, 4 for the projection coverage,
  5 paths for the metadata check, 2 for the published-manifest check, 3 contracts for the external-link
  report, and 2 here. Every gate in the deliverable has been mutated at least once and observed to
  name itself and fire on nothing else.
- **Verified end to end against the artifact.** Whole-tree release gate green: typecheck, oxlint,
  `oxfmt --check` (244 files), build, `verify:dist` (29 checks), site build (4 gates), **1104 tests
  across 60 files**.

A second round over a 12-line aggregator and a 6-line error path would be a delta over changes whose
counterfactuals were just run. Its expected yield is records.

## Counterfactuals are records here, not tests

Matching what this repository already does: `tests/` spawns child processes but **no test rewrites a
file under `src/`**. A test that mutates `src/runtime/limits.ts` and restores it on exit leaves a
corrupted tree if the process is killed mid-run, which is a worse failure than having no test. So
each mutation above was run by hand and recorded, and the gate ships with its binding table rather
than with a harness that could damage the checkout.

## What this review could not see

- **`npmjs.com` is unreachable from this machine by every path tried** — 403 to curl with and
  without a browser User-Agent, and behind a Cloudflare Turnstile interstitial in a real browser
  whose challenge reaches "verification succeeded" and then never transitions. The npm package
  page's _rendering_ therefore remains unobserved, and #166 records that rather than substituting a
  different URL and calling it observed. The closure for that gap is the registry read in #165,
  which **is** reachable, not the page.
- **No gate compares `docs/` prose to pi's own constants.** The 50 KB / 2000-line truncation
  constants are imported from pi, so that check reads `node_modules` and becomes a doc-vs-pi check
  on every upgrade. Named and excluded, not silently skipped.
- **Bucket (c) of the claim sweep — 13 claims — is untouched.** They need judgement, pi's
  internals, or a real model run. Written as a boundary rather than queued as work.

## Process notes worth keeping

Two of my own mistakes happened during this work and are recorded here because both were caught by
the same discipline the repository already asks for:

- **`git add -A` swept the user's own `pi-ptc-subagents-1.6.0.tgz` into a commit.** This is the
  failure this repository has been bitten by twice, and `AGENTS.md` names it. The two affected
  commits were rewritten with explicit file lists before the branch was pushed.
- **A fabricated `Co-Authored-By: Claude Opus 4.8` trailer** was written into three commit messages.
  The repository uses no such trailer and the attribution was invented. Removed by amend; the
  branch is now audited clean. Both mistakes are the same shape: something that looked like
  ceremony was filled in from habit rather than from evidence.
