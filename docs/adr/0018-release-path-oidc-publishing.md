# Release path: tag-triggered OIDC publishing (no provenance while private)

0.1.0 was published by hand: `npm publish` on the maintainer's machine, using the
account's long-lived credentials, with `prepublishOnly` as the only gate between a
test run and the registry. Nothing in the tarball or in the registry's record of the
version says which commit produced it, the credential outlives the release it was
used for, and the steps live in one person's shell history. npm's current guidance
for a package published from CI is trusted publishing (OIDC), which is what this ADR
adopts; 0.1.1 is the first release to go out through it.

The change is deliberately narrow. Installing the package, the tarball's contents and
the `pi.extensions` manifest are untouched — this is about how a version reaches the
registry, not about what a `pi` user gets.

Status: accepted (2026-09-23). Reversible per release: the manual path is kept as the
fallback (§8), so nothing here can block a release that needs to happen.

## Decision

**1. §1 · The release act is pushing an annotated tag `v<version>` on `main`.** The
workflow (`.github/workflows/publish.yml`) runs on `push: tags: [v*]`, checks the tag
out, and publishes. The tag is the release's identity: it names the commit the tarball
was built from, which is the one property the manual path could not state. Because the
tag carries that meaning, the workflow refuses to publish when `v<tag>` and
`package.json`'s `version` disagree — the failure it prevents is a release that ships
under the wrong number, or one that publishes the previous number again and dies on
npm's "cannot publish over previously published version".

**2. §2 · Authentication is trusted publishing (OIDC); no long-lived npm token
exists.** The workflow filename is registered on npmjs.com as this package's trusted
publisher, and the job declares `id-token: write` so the npm CLI can exchange a GitHub
OIDC token for a short-lived publish credential. `contents: read` is declared because
`checkout` needs it on a private repository — the same reason `ci.yml` carries it.
Consequence to expect in npm's version metadata: `_npmUser` reads `GitHub Actions
<npm-oidc-no-reply@github.com>` for versions published this way, where 0.1.0 read the
maintainer's account.

**The job deliberately does not pass `registry-url` to `setup-node`, unlike npm's sample.**
That input writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`,
and with no token supplied `setup-node` fills in the placeholder `XXXXX-XXXXX-XXXXX-XXXXX`.
The npm CLI then finds a credential it can use, which masks the OIDC helper's failure
(`lib/utils/oidc.js` is documented as never throwing) and turns it into
`npm error 404 Not Found - PUT https://registry.npmjs.org/<pkg>` — a permissions failure
wearing a missing-package costume. Both of this release's first two runs failed exactly
that way (35810906655, and its rerun). Drop the input, and a failed exchange surfaces
instead as npm's own "This command requires you to be logged in". The publish step also
runs at `--loglevel verbose`, because that is the level at which the helper reports both
outcomes ("Successfully retrieved and set token" / "Failed token exchange request with
body message: …") — so the release log carries the evidence rather than hiding it.

**3. §3 · The gates run twice, on purpose.** The workflow runs `typecheck`, `lint`,
`fmt:check`, `build` and `test` as explicit steps; `npm publish` then runs
`prepublishOnly`, which runs the same five again. Collapsing the two would cost the CI
log its per-gate granularity (a red run currently names the gate that failed) or cost a
local publish its gate; keeping both means a failure that only reproduces under
`prepublishOnly` is still caught. Worth stating plainly, since it is the kind of
duplication a later reader would otherwise "clean up": `ci.yml` and `oxlint.yml` run the
formatter and the linter only, and the PR gate that does run these five
(`.github/workflows/test.yml`, added 2026-09-23) does not retire this copy — a release has
to gate the tree it publishes, and a tag can be pushed on a commit no PR ever ran.

**`build` precedes `test` in both places, and it has to.** `tests/tool-visibility.test.ts`
drives the _built_ bundle — it loads `dist/index.js` under a real `pi` and asserts what the
provider is offered — so a test run that starts from a clean checkout with no `dist/` fails
with "the probe never observed a provider request", which says nothing about the code. The
first version of this workflow ran `test` before any build and failed exactly that way (run
35810906655); `prepublishOnly` had the same latent ordering bug, invisible locally because a
working copy usually still has a `dist/` from the last build.

**4. §4 · Release builds do not cache the package manager.** `package-manager-cache:
false` on `setup-node`, as npm's trusted-publishing example does. A release build is
the one place where a stale cache must not be able to change what ships;
`pnpm install --frozen-lockfile` still pins the dependency graph exactly.

**5. §5 · Node is pinned, not `lts/*`.** The job requests Node 24 rather than
`lts/*` (what the gate workflows ask for). Trusted publishing requires npm CLI
≥ 11.5.1, and the CLI ships with the runtime, so a release job's runtime is part of
its credential path. `lts/*` remains right for a gate that should track the ecosystem.

**6. §6 · Token access is restricted only after the first successful OIDC publish.**
npm's migration order is: add the trusted publisher, publish successfully, _then_ set
"Require two-factor authentication and disallow tokens" on the package. Doing it in the
other order risks a package whose only publish path is one that has not yet been proven
to work, with the fallback credential already revoked.

**7. §7 · No provenance, because the source repository is private.** npm generates
provenance attestations only when publish comes from a public source repository, so
versions of this package carry no `dist.attestations` — including versions published
through OIDC. That is a property of `a1121611810/pi-ptc-subagents` being private, not a
broken release path: making the repository public later adds the attestation with no
change to the workflow. Recorded here, and in `CONTEXT.md`, so the missing badge is not
re-diagnosed as a publishing defect.

**8. §8 · The manual path survives as the fallback, and only that.** `npm publish` from
a working copy, with the account's 2FA, remains possible: a CI outage, an expired OIDC
trust, or a release cut from a machine without GitHub access must not block a release.
It is not the default, and a release that uses it is a release no tag identifies — the
cost §1 exists to remove.

## Consequences

- The tarball on npm is tied to a commit and to a workflow run; the run's log is the
  release record.
- Every version published this way is missing the provenance badge, for as long as the
  repository is private. Expected, not a defect (§7).
- `typecheck` and the test suite also run on every `pull_request` and on `push: main`
  (`.github/workflows/test.yml`, added 2026-09-23), so a red test surfaces on the PR
  rather than at release time. The release job keeps its own copy of the gates — see §3.
- Deployments of the credential are unchanged in kind: there is no secret to rotate,
  and nothing to revoke when a maintainer leaves.

## Considered options

- **Keep publishing by hand.** What 0.1.0 did. Rejected as the default: the credential
  is long-lived, the build is whatever the working copy happened to contain, and the
  published version is not linked to a commit. Kept as §8's fallback.
- **A long-lived automation token in repository secrets.** Rejected on npm's own
  stated grounds: tokens leak (logs, config, a compromised runner), they need rotation,
  and they grant standing publish access rather than a per-run credential.
- **Staged publishing, stage-only (`npm stage publish` + a 2FA approval).** Rejected
  _for now_, not on principle: staging exists to put a second pair of eyes, or at least
  a deliberate approval, between CI and the registry. Here the maintainer is both the
  person who pushes the tag and the person who would approve, so it adds a per-release
  2FA step without adding a reviewer. Revisit when a second maintainer joins — that is
  exactly when the approval starts buying something.
- **Publishing from a self-hosted runner.** Not available: npm's trusted publishing
  supports GitHub-hosted, GitLab.com shared and CircleCI cloud runners only.
- **`npm publish --ignore-scripts`, to avoid running the gates twice.** Rejected: it
  also skips `build`, so the tarball would ship without `dist/` — the flag removes the
  step that makes the package work, not just the duplication.
