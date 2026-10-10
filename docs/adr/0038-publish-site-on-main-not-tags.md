# The site is published on every push to `main`, not on release tags

status: accepted (2026-10-10)

## Context

This repository already has a publication trigger, and it is the opposite of this one. ADR-0018
established the release path: pushing a `v*` tag runs `publish.yml`, which publishes to npm under
OIDC trusted publishing. A tag is the right trigger for an immutable artifact — a version number is
a promise about what shipped, and nothing published after it may contradict that promise.

A documentation site is not that artifact. Per ADR-0037 its content is **projected from the
repository's own markdown**, so the site is a rendering of the working tree, not a versioned release.
Tagging it would mean the site answers questions from whatever release last happened to be cut.

The failure this avoids is specific and is the ordinary one for a usage site: a reader follows the
README's documentation link, lands on a page describing an option that no longer exists, and has no
way to tell that the page is stale rather than current.

## Decision

**`.github/workflows/pages.yml` triggers on `push` to `main`, plus `workflow_dispatch`. It does not
watch `v*` tags.**

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

The two triggers are not interchangeable, and the asymmetry is deliberate:

- The **npm release** stays tag-triggered (ADR-0018, unchanged). Cutting a version is a decision with
  a version number attached to it.
- The **site** is not versioned, so it has nothing to wait for. Every push that changes anything it
  renders publishes it.

### The build is the gate

`pnpm --filter website run build` must succeed before `upload-pages-artifact` runs. That single step
chains: `project-docs.mjs` (ADR-0037), `vitepress build`, and the checks described in ADR-0036 —
the landing-page tool-name check, the internal-link check, and VitePress's own dead-link detection
over projected markdown.

This is load-bearing and unusually strict, so it is written down in the workflow itself:

> Do not add `ignoreDeadLinks` — ticket #147's counterfactual test exists to catch exactly that.

Two supporting details, both of which exist because the obvious alternative is worse:

- **`pnpm install --frozen-lockfile`**, matching every other workflow here. A website change committed
  without its regenerated lockfile fails in CI exactly as it fails locally.
- **`concurrency: {group: pages, cancel-in-progress: false}`.** Cancelling a running `deploy-pages`
  leaves the Pages environment pointed at a half-published state. For a site rebuilt on every push,
  queuing is correct and cancelling is not.

## What this does not decide

- **This does not gate merges.** `pages.yml` runs after `main` moves; it cannot stop a bad
  documentation change from landing. It guarantees a bad site is never _published_, which is a
  weaker and different promise. Making it a merge gate would mean the repository's own release rules
  depend on a GitHub-hosted build.
- **Deploys are not atomic with the commit.** A push that breaks the site's build leaves `main` with a
  failing Pages run and the **previous deployment still live**. The site degrades to "one version
  behind", never to "404".
- **No preview deployments.** Every push to `main` replaces the live site. There is no per-PR preview
  URL.

## Why not tag-triggered, with a release when docs change

Because that reintroduces the staleness it is meant to prevent, in a slower form: a tag now has to be
cut for a wording fix, and every release pulls along a new version number that implies an npm
publication decision nobody made. The npm artifact and the documentation have genuinely different
lifetimes, and forcing them onto one trigger is what created the problem in the first place.

## Why `main` and not a `docs/`-style content branch

A separate branch would need a merge to reach the public site, which means the same staleness one hop
further away, plus a branch whose divergence from `main` is itself a thing to reconcile. The site has
no content of its own that `main` does not already have (ADR-0037), so a second branch would carry no
content at all.

## What would retire this

If the site ever became **version-specific documentation** — pages describing one released version's
API, retained for readers on older versions — then the npm trigger is the correct one, because the
site would become an immutable artifact after all. That is the same condition that would retire
ADR-0037's no-copies rule, and the two should be re-argued together.
