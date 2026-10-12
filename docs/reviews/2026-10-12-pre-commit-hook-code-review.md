# Review — the pre-commit guardrail, twice

Date: 2026-10-12. Fixed point: `825bcc3` to `24ac18d`, then `4e99e13`. Spec: issue #175. Branch:
`docs/site-reference`.

Two rounds, and the second exists because the first round's **fix** turned out to be where the worst
defect was. That is the part worth keeping: the first round's four findings were all real, and acting
on them introduced a fifth that made the hook refuse normal commits, and a sixth that made it pass
the very thing it was written to catch.

## What was reviewed

A commit-time guardrail refusing two things: a packaged artifact, and a staged file the repository's
own formatter would reformat. Deliberately not lint, typecheck or test — a slow hook gets
`--no-verify`'d, and a bypassed hook protects nothing.

Round 1 reviewed `825bcc3` and returned seven findings, four of them blocking. Round 2 reviewed
`24ac18d`, the response, and returned two more blocking.

## Findings ledger

### R-h1 — non-ASCII paths were escaped past the regex

|                    |                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Round 1, blocking. `git diff --cached --name-only` octal-escapes a non-ASCII path, so `笔记.ts` arrived as `"\347\254\224\350\256\260\346\226\207\344\273\266.ts"`, no extension matched, and the commit exited 0. This repository's documents are written in Chinese, so it was the most reachable of the four. |
| **Why it matters** | A hook that reads correctly and refuses nothing looks exactly like a hook that works.                                                                                                                                                                                                                            |
| **Closure**        | `24ac18d`: `-z` with `core.quotePath=false`, read with `read -r -d ''`. **Counterfactual:** a Chinese-named unformatted `.ts` is refused, and the formatter's own output names the path whole.                                                                                                                   |

### R-h2 — a space in a filename word-split the argument

|             |                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 1, blocking. `$CHECKABLE` was unquoted, so `my notes.ts` became two arguments. The formatter reported "nothing to check" and exited 2, which the hook read as the excluded-by-config case, and the commit passed. |
| **Closure** | `24ac18d`, then re-fixed in `4e99e13` after the first fix broke it — see R-h5. **Counterfactual:** a space-named unformatted `.ts` is refused.                                                                          |

### R-h3 — a missing file and an excluded file print the same thing

|                    |                                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | Round 1, blocking. `oxfmt --check` on a path that does not exist prints the same message and returns the same code (2) as "every file I was given is excluded by config". Staging a file and then deleting it without unstaging passed. Both messages are byte-identical and both exit 2. |
| **Why it matters** | The hook's own principle is that ambiguity resolves toward refusing. Inferred from the message, it resolved the other way.                                                                                                                                                                |
| **Closure**        | `24ac18d`: the hook checks existence itself rather than inferring from the formatter's words. **Counterfactual:** stage, then delete from disk — refused, with a message naming the path.                                                                                                 |

### R-h4 — the formatter read the working tree; the commit recorded the index

|             |                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 1, blocking. Stage a file, fix it, then commit: the bytes checked are the fixed ones, and the bytes recorded are the unformatted ones. Spec #175 says "the staged set, not the working tree", so the delivered hook contradicted its own spec here as well as the header. |
| **Closure** | `24ac18d`: refuse on drift, do not guess a verdict from it. **Counterfactual:** a staged, already-formatted file edited on disk is refused by name. `4e99e13` states the `--skip-worktree` case that still escapes it (R-h8).                                                   |

### R-h5 — the fix for R-h2 silently disabled the hook's own exit-2 branch

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**          | On the repair, found by re-testing rather than by review. Routing the paths through `xargs -0` to stop the word-split seemed free. On macOS `xargs` collapses a child's exit 1 and exit 2 to its own exit 1, so `FORMAT_CODE -eq 2` became unreachable — and every commit touching only `packages/website/**` was refused as "not formatted", printing oxfmt's own `excluded by ignore rules` line as the evidence. That is a normal state here, since ADR-0036 keeps that tree out of the root formatter on purpose. |
| **Why it matters** | A branch that can never fire is a guard that reads as protection and is not. And the failure pointed the wrong way: it blocked correct work rather than letting bad work through.                                                                                                                                                                                                                                                                                                                                     |
| **Evidence**       | `printf 'x' \| xargs -0 sh -c 'exit 2'; echo $?` → `1`. `oxfmt --check packages/website/scripts/junk.mjs; echo $?` → `2` directly, `1` through `xargs`.                                                                                                                                                                                                                                                                                                                                                               |
| **Closure**        | `24ac18d`: the paths go to the formatter as a bash array, so the exit code arrives intact. **Counterfactual:** a website-only staged set passes; a broken `.json` exits 1 through the same path; both branches were exercised as reachable.                                                                                                                                                                                                                                                                           |

### R-h6 — a rename carried an unformatted file into history

|                    |                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Found**          | Round 2, blocking. `--diff-filter=ACM` drops status `R`, and git detects renames by default. A `git mv` plus a formatting-breaking edit in one commit put the moved-in path outside the checkable set entirely; the hook exited 0. Reproduced here independently at `R097`: `git show :src/final.ts` held `export const   value10   =   999;` while `oxfmt --check` on that file exited 1. |
| **Why it matters** | This is the failure the file exists to prevent, reached through the one operation a refactor performs constantly — and it is a silent pass, in direct contradiction of the header's own sentence that every ambiguous case resolves toward refusing.                                                                                                                                       |
| **Closure**        | `4e99e13`: `--no-renames`, which turns the move into an ordinary add plus a delete. `-M0` does not work — it yields an empty set, which would have made the hook vacuously pass. **Counterfactual:** the same staged set at `R097` is now refused, and the rename scenario is in the standing scenario list.                                                                               |

### R-h7 — the drift guard cost more than the check it was guarding

|              |                                                                                                                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**    | Round 2, blocking. One `git diff --quiet` per staged path. On a 250-file `git add -A`: 32.7 s total in the hook, of which 16.9 s was the guard and 6.3 s was the formatter. The header's stated reason for refusing to run lint at commit time is that a slow hook gets `--no-verify`'d — and the guard was the slow part. |
| **Evidence** | Per-component timing in a throwaway clone: 258 git spawns for the per-path loop, 0.063 s for one batched `git diff --name-only -z`.                                                                                                                                                                                        |
| **Closure**  | `4e99e13`: one batched `git diff --quiet -- "${CHECKABLE[@]}"` answers "did anything move"; the per-path loop runs only to name a culprit, which is to say only on refusal. **Counterfactual:** re-measured on the same 242-file set, the guard is 0.185 s against 16.9 s — 91×.                                           |

### R-h8 — two limits that were silently false

|             |                                                                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Found**   | Round 2, non-blocking. `git update-index --skip-worktree` makes `git diff --quiet` report no difference for a path regardless of what is on disk, so the drift guard of R-h4 can be disabled per-path; sparse checkout sets it implicitly. Separately, `git add -p` is unconditionally refused, which the file did not say. |
| **Closure** | `4e99e13`: both stated in the header next to the newline-in-filename limit that was already there. Deliberately **not** engineered around — nothing in this repository sets either flag, and engineering around them would mean intercepting git's own index state.                                                         |

## Claims audit

Each claim the header makes, and whether it held when tested.

| Claim                                         | Verdict                                      |
| --------------------------------------------- | -------------------------------------------- |
| non-ASCII paths are refused                   | holds                                        |
| paths with spaces are refused                 | holds                                        |
| exit 2 is distinguished from a missing file   | holds                                        |
| drift is refused                              | holds, except under `--skip-worktree` (R-h8) |
| no `xargs`, so the exit code survives         | holds                                        |
| every ambiguous case resolves toward refusing | **did not hold** — R-h6 was a silent pass    |
| a slow hook gets bypassed                     | **the hook was the slow part** — R-h7        |

## Stopping

Round 2 produced no change in behaviour that a third round would be expected to find: the two blocking
findings were a rename filter and a cost measurement, both closed by construction and both re-measured.
Round 2 also produced two statements about what does **not** bypass the hook (`--no-verify`, a clone
without `core.hooksPath`), which are out of scope by the spec's own boundary and were not filed.
