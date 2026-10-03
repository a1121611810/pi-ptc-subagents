# Open source: public repository, write authority, publish authority

Status: accepted (2026-10-03). Amends ADR-0018 §6 and §7. No change to the release _mechanism_ —
ADR-0018's tag-triggered OIDC publishing stays exactly as it is; what this ADR fixes is who is
allowed to invoke it, and what the repository is open about.
The repository was private while the npm package was already public. That is a state worth
naming precisely, because it is the thing this ADR changes: `dist/` — the minified bundle plus
67 KB of type declarations — has been downloadable from npm since 0.1.0, under a package that
declares `license: Apache-2.0` and points `homepage` / `repository` at a private GitHub. Anyone
installing it could read the entire public API and the minified logic, and could not read the
source, the ADRs, the tests, or the design decisions. Ten releases were shipped in that state
(0.1.0 by hand; 0.1.1–1.4.0 through CI — see §B).

## Boundary with ADR-0018

This ADR amends ADR-0018 by reference, on two points only:

- **§6 (token access).** ADR-0018 defers restricting token access "until the first successful
  OIDC publish". That condition has been met nine times over, so the deferral is now resolved:
  see §B control B. The ordering rationale in §6 is unchanged and still correct.
- **§7 (no provenance).** ADR-0018's §7 claim — that versions carry no attestation because
  the source repository is private — is now false. The repository is public, and under trusted
  publishing npm generates the attestation automatically, with no workflow change. Versions
  released from here carry `dist.attestations` for the first time.

Where the two ADRs read differently, this one governs. ADR-0018's text is deliberately not
rewritten beyond the two amendment pointers it carries; the release mechanism, the tag-identity
rule, and the `prepublishOnly` duplication argument all remain as specified there.

## §A — The repository is public, and `main` is owner-writable

The repository moves from private to public. The source, the ADRs, `CONTEXT.md`, the tests and
the research notes all become readable, and the npm `homepage` stops being a dead link.

`main` is then governed by a repository ruleset:

| Rule                                                 | Effect                                                                             | Why                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `update` (`update_allows_fetch_and_merge: false`)    | Only bypass holders may push to `main`. Everyone else goes through a pull request. | This is the enforcement, not a convention.                                                                               |
| `pull_request`, `required_approving_review_count: 1` | A PR cannot merge without an approving review.                                     | Closes the gap `update` alone leaves open: a collaborator with write access could otherwise open and merge their own PR. |
| `required_status_checks`                             | CI must be green on the PR head.                                                   | A red test surfaces on the PR, not at release time.                                                                      |
| `non_fast_forward`, `deletion`                       | No force-push, no deleting `main`.                                                 |                                                                                                                          |

The maintainer (`a1121611810`, user id 26902911) is the sole bypass actor, `bypass_mode: always`.

**The asymmetry is deliberate and will be read as a bug if it is not stated here.** The
maintainer can push straight to `main` and can merge their own PR without an approval; nobody
else can do either. Without that asymmetry, every small fix becomes a PR the maintainer has to
review in order to review it themselves.

Note also what the `update` rule is _not_ protecting against: a fork contributor never had push
access, so this rule is not what stops them. It is what stops the **next** collaborator the
maintainer grants write access to. Read that way, "only the owner can push `main`" is a
statement about the future grant list, not about the present one.

## §B — Publish authority

The release mechanism is untouched: pushing annotated tag `v<version>` runs
`.github/workflows/publish.yml`, which checks the tag against `package.json`, runs the gates, and
exchanges a GitHub OIDC token for a short-lived npm credential. It has done so ten times, twice
failing first (runs `35810906655`, `35811391152`) and once failing later on the gates
(`36738552842`, the 1.2.0 release). **Deleting it and publishing from a laptop was considered and
rejected**: the laptop path cannot produce an npm provenance attestation at all, because
provenance requires a supported cloud CI provider, so it would forfeit the attestation that
making the repository public was partly for.

Because the workflow's only trigger is a tag push, _"who can push a `v*` tag" is exactly "who can
release"_. That gives three controls:

- **Control A — tag ruleset (primary).** A ruleset on `refs/tags/v*` restricting creation,
  update and deletion, with the maintainer as sole bypass actor. Only the maintainer can create,
  move or delete a release tag, therefore only the maintainer can trigger a publish. This is the
  control; A and B are both required for it to hold, and neither is a policy statement.
- **Control B — npm package access (defence in depth, no friction).** The package is set to
  **"Require two-factor authentication and disallow tokens"**. npm documents that this affects
  only traditional token authentication and that trusted publishers continue to work normally,
  because they authenticate with OIDC. So the CI release path is untouched, while the
  long-lived `_authToken` still sitting in the maintainer's `~/.npmrc` from the 0.1.0 manual
  release — a token that has not been used for nine releases but is account-scoped and
  therefore technically still a live publish path — loses the ability to publish this package.
  "Only the maintainer can release" stops depending on where a secret file is kept.
- **Control C — a GitHub deployment environment (deliberately not adopted).** An `npm-publish`
  environment with a required reviewer would add a second gate on the publish job. It is not
  adopted: for a single-maintainer project it costs an approval click on every release, and A
  and B already give double enforcement. It is the right control the day a second maintainer
  arrives, and ADR-0018's "Considered options" already reserved that revisit.

**Residual, stated rather than hidden.** With C absent, a maintainer who merges a PR that
rewrites `publish.yml`, then pushes a tag, publishes whatever that PR made the workflow do.
Controls A and B do not stop that — the tag push is the maintainer's own, and the trusted
publisher is bound to this repository and this workflow filename by design. What closes it is
review discipline on workflow changes, which is a human control and should be recorded as one.

## §C — Attribution, and the citation baseline

DSH is public and MIT (Copyright (c) 2026 DeepSeek), so the research notes' line-by-line
citations are permissible. MIT still requires the notice to travel with substantial portions,
which is why `THIRD_PARTY_NOTICES.md` is new, and why it is added to the npm `files` whitelist so
it ships inside the tarball rather than only on GitHub.

Every `/tmp/dsh-src/...` citation in `docs/research/` was repointed to a path in
`deepseek-ai/deepseek-harness`, pinned to tag **`dsh-v0.2.0-rc.2`**.

That tag is not the one this repository previously named, and the correction is worth its own
note. `src/runtime/limits.ts:4` described its constants as DSH's from `dsh-v0.1.6-alpha.2`, and
`docs/research/ptc-upstream-parity-audit-20260930.md` had already recorded that this
self-description was the stale side of a mismatch: the research had been read from a `0.2.0-rc.2`
checkout all along. Measured consequences, in both directions:

- **No constant was ever wrong.** The `NodePtcRuntime.Config` defaults are byte-identical across
  the two tags — 120000 / 600000 / 67108864 / 134217728 / 128 / 3000 — so ADR-0003's 64 MiB
  output budget, ADR-0004's 128 pending calls and ADR-0005's worker limits hold either way. The
  fix was to the version label in the comment; no behaviour changed, and the test that locks
  these constants was untouched.
- **Line numbers do not transfer between tags.** `RUN_CODE_NAME` sits at line 23 of
  `packages/core/tools/src/ptc.ts` under `0.1.6-alpha.2` and line 30 under `0.2.0-rc.2`. A
  citation repointed at the wrong tag is not a formatting nit; it points a reader at a different
  statement.

The lesson is the one the audit doc already implied and did not need me to repeat: the version
was read off a comment in the code rather than off the research, and the file that recorded the
discrepancy was not read before the comment was trusted. A self-describing comment is a claim
about itself, not evidence.

## §D — `verify:dist` joins the gates

`scripts/verify-dist-render.mjs` is the only check that exercises the _built_ artifact, and it
ran nowhere: not in CI, not in `publish.yml`, not in `prepublishOnly`. `AGENTS.md` records a
feature that passed three review rounds and 696 tests and then failed this script on the release
artifact. The gates now run it, in all three places.

It is added to `prepublishOnly` too, which is a third path to the same gate: a maintainer running
`npm publish` locally gets it, and so does anyone reproducing a release by hand.

## Consequences

- `main` is owner-writable and nobody else writable; everything else is a reviewed PR, and a PR
  needs CI green plus one approving review.
- Release authority is the tag ruleset plus the npm access setting, not the location of a
  credential file. The one residual — a merged workflow rewrite published by the maintainer's own
  tag — is a review-discipline control and is recorded as one.
- The npm `homepage` and `repository` fields resolve for the first time, and versions released
  from here carry provenance attestations for the first time. Both were previously documented as
  known, expected properties of a private repository (ADR-0018 §7); both are now fixed rather
  than accepted.
- `docs/research/**` cites a public repository and can be checked by anyone. The citations that
  survived as file-level (no line) are the ones whose original basis was a build artifact — a
  bundle's barrel `export { … }` line or a `//#region` marker — and the files say so in their
  own preamble rather than carrying invented line numbers. The same applies to the 567 short-form
  `x.js:NN` references, which are lines in the **published build output** of that same release
  and are resolvable against the published npm package. They were measured before being left
  alone: only 4% of them could have their referring module determined from the line they sit on
  (a short form names a basename, and the module is usually named in an earlier bullet), and
  **none of those 22 could be matched to a unique source line**. Re-deriving them would mean
  reading all 567 in context, and a wrong source line is worse than an honest build line — so
  they keep the form they were written in, and each file's preamble says what they are.
- `verify:dist` is now part of the definition of a passing change, so a red run in it is a signal
  rather than a curiosity.

## Cross-references

- ADR-0018: release path — tag-triggered OIDC publishing (amended by reference on §6 token access
  and §7 provenance).
- ADR-0002: source strategy — the clean-room boundary the DSH attribution depends on.
- ADR-0003, ADR-0004: the limits whose values §C re-verified across two upstream tags.
- ADR-0007: no OS sandbox — what `SECURITY.md` points at when it says "there is no sandbox, by
  decision".
- `SECURITY.md`: the in-scope / out-of-scope split for vulnerability reports.
