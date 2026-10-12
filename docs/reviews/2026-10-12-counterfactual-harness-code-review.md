# Review — the site gates' counterfactuals

Date: 2026-10-12. Fixed point: `0ece3a5` to `4e99e13`. Spec: issue #176. Branch:
`docs/site-reference`.

One round. The harness exists to answer "does this gate still have teeth", and the review's two
blocking findings are both cases of it answering **yes** when the answer was no.

## What was reviewed

`packages/website/scripts/counterfactuals/run.mjs`, plus `packages/website/scripts/checks.mjs`, which
was extracted so the runner and the harness read one list of gates instead of two copies.

## Findings ledger

### R-c1 — it measured `HEAD`, not your working tree

|                    |                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Blocking. `makeWorkdir()` ran `git archive HEAD`. With `check-style-scope.mjs`'s own detection disabled in the working tree and uncommitted, the harness still reported `✓ caught (exit 1)` and exited 0. The gate in front of the maintainer had no detection at all; the gate it was testing was the committed one.                                           |
| **Why it matters** | Spec story 1 is "a maintainer who suspects a site gate has stopped working". The working tree is where that person is. `docs/testing-constraints.md` requires the self-proof to establish "the run tested _this_ tree", and it did not. The copy was incoherent as a boundary besides: `HEAD` for sources, working-tree `dist/` and `docs/` for build products. |
| **Evidence**       | Reproduced here independently: `sed -i 's/leaking.length > 0/false \&\& leaking.length > 0/' …` leaves `git status` showing the gate modified; the gate then detects nothing; the harness printed `✓ caught` and exited 0.                                                                                                                                      |
| **Closure**        | `4e99e13`: the copy is `cpSync(REPO_ROOT, …)` with a filter, not `git archive`. **Counterfactual:** the same disabled gate now yields `✗ NOT CAUGHT` and exit 1. The build output comes along with it, which `git archive` never had.                                                                                                                           |

### R-c2 — a gate killed by a signal was credited with catching the mutation

|                    |                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Blocking. `runGate` returned `run.status`, which is `null` when the child dies on a signal, and `null !== 0` read as caught. Reproduced here with a gate that `SIGKILL`s itself once the mutation is present: `✓ caught (exit null)`, exit 0.        |
| **Why it matters** | An OOM, a `SIGSEGV` and a `SIGKILL` are the most likely ways a gate dies by accident, and each was silently converted into a successful proof. `run-checks.mjs` already treats the same case as `-1` — "which is not a pass".                        |
| **Closure**        | `4e99e13`: `run.error` and `status === null` are separated out as `died`, and reported by name. **Counterfactual:** the self-killing gate now prints `✗ the gate did not finish — killed by signal SIGKILL. A crash is not a detection` and exits 1. |

### R-c3 — a case did a step that changed nothing, and hid it

|             |                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Non-blocking. The projection case re-ran `project-docs.mjs` and discarded the result, under a comment asserting the gate "reads the manifest, not the directory". Measured: file-only goes red (exit 1), and the re-run alone changes nothing at all. A broken projection step reported nothing — `docs/testing-constraints.md` constraint #3. |
| **Closure** | `4e99e13`: the step and the false comment are gone. **Counterfactual:** the case still catches, from the file alone.                                                                                                                                                                                                                           |

### R-c4 — `treeDigest` claimed three things it did not do

|             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Non-blocking, and the most useful finding in the round because all three are records that were wrong about code sitting right next to them. It followed symlinks while documenting that it did not (`readFileSync` resolves the target, and a regular file and a symlink to identical content hashed the same); empty directories were invisible, so "byte-identical" really meant "same non-empty path set"; and path and content were concatenated with no delimiter, so `["ab","c"]` and `["a","bc"]` collide. |
| **Closure** | `4e99e13`: link targets and entry kinds go into the hash, directories are hashed, entries are NUL-separated. **Counterfactual:** each of the three now produces a different digest.                                                                                                                                                                                                                                                                                                                               |

### R-c5 — the `.git` prune left `.git/hooks` reachable

|             |                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Non-blocking. The repository digest pruned `.git` wholesale, justified only by `node_modules`' size. A mutation that also wrote into the real `.git/` and `node_modules/` reported `the repository is unchanged` and exited 0, leaving `.git/PROBE-HOOK` on disk. The positive control (an ordinary write) does fire, so the hole is narrow — but `.git/hooks` is its sharp end. |
| **Closure** | `4e99e13`: `.git/objects` is pruned and the rest of `.git` is hashed — tens of files. **Counterfactual:** a write into `.git/hooks` is now detected.                                                                                                                                                                                                                             |

### R-c6 — a missing input surfaced as a stack trace and leaked a directory

|             |                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Non-blocking. With `packages/website/docs/` absent, `cpSync` threw a raw `ENOENT … lstat` after `mkdtempSync` had already created a workdir that nothing cleaned up — a plain mistake reported as a crash, contradicting the file's own "checked up front, by name" and `check-style-scope.mjs`'s handling of the same class. Reachable in practice: `project-docs.mjs` removes its output directory. |
| **Closure** | `4e99e13`: both required inputs are named before any workdir exists, and a copy that fails part-way is removed rather than left to look like a clean starting point. **Counterfactual:** with `docs/` moved away, the run prints what is missing and how to produce it, exits 1, and leaves nothing in the temporary directory.                                                                       |

## Per-case audit

Each mutation checked against what its gate actually reads, and whether the gate went red for **its
own** reason rather than an incidental one.

| Gate                        | Mutation touches what the gate reads                            | Red for its own reason                       | Meaningful      |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------------- | --------------- |
| `check-landing-tool-names`  | `dist/index.html`, the gate's `BUILT_INDEX`                     | names `ptc_not_a_real_tool`                  | yes             |
| `check-internal-links`      | the same HTML, scanned for `href`                               | names the unbuilt route                      | yes             |
| `check-style-scope`         | `theme/landing.css`, the gate's `STYLESHEET`                    | names the chrome rule                        | yes             |
| `check-doc-claims`          | `src/runtime/limits.ts`, `configDefault('dispatchConcurrency')` | names binding `dispatch-concurrency-default` | yes             |
| `check-projection-coverage` | `docs/usage/`, which the gate enumerates itself                 | names the probe document                     | yes, after R-c3 |

## The four claimed properties

| Property                                                    | Verdict                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1. a case that changed nothing is refused                   | holds                                                                              |
| 2. a gate already red on the unmutated copy is not credited | holds                                                                              |
| 3. a gate with no case is listed as unproven                | holds, list now read from `checks.mjs`                                             |
| 4. the repository is unchanged when the run finishes        | holds; R-c4, R-c5 narrowed it from "byte-identical" to what it actually guarantees |

## Stopping

One round, and the class being chased — false passes — was measured rather than sampled: two of the
four properties a false pass could hide (2 and 3) were tested adversarially and both held, and the two
that did not fail are now closed by construction and re-verified by counterfactual. A second round
would be looking for more of the same shape in a file whose remaining surface is five cases and one
digest.
