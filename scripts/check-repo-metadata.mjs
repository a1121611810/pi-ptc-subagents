#!/usr/bin/env node
/**
 * Gate: the repository's About panel agrees with the manifest.
 *
 * The About panel is the first thing a visitor sees and the one surface with no version control:
 * `package.json` says what the package is, the repository metadata says it independently, and
 * nothing connected them. They match today. A rewording of the manifest's sentence would leave the
 * panel describing something else, silently, until someone noticed by eye.
 *
 * This is also the check that would have caught a real one from the website work: a topic published
 * as `programmable-tool-calling` while the manifest's keyword is `programmatic-` — one
 * transposition, and the package became unsearchable under its own term.
 *
 * ## Why it is a CI job and not a test, and why only on `main`
 *
 * This is **the repository's first network-dependent assertion**. `grep -rl 'api\.github\.com'
 * tests/ scripts/` returns nothing, no workflow references a token, and `verify-dist-render.mjs`
 * has no network reference at all. Two placement facts follow:
 *
 * - **Not in `prepublishOnly`.** Every gate in the release chain is hermetic. Putting the one
 *   online gate there would make publishing contingent on GitHub's API being up.
 * - **Not on `pull_request`.** The repair for drift is `gh repo edit` — an *out-of-band* action
 *   against the repository's own metadata, not a commit. Wired to PRs, every legitimate
 *   description change would fail against something the PR author cannot fix in that PR.
 *
 * So it asserts the **merged** state, which is where the drift is observable at all.
 *
 * ## Could-not-verify is a failure, not a pass
 *
 * A gate that reports success when the API was unreachable is a silent false pass — the exact
 * failure mode this repository has been bitten by twice. An unreachable API and an agreeing
 * About panel are different states and the exit code distinguishes them.
 *
 * Usage:
 *   GH_TOKEN=… node scripts/check-repo-metadata.mjs        # locally, before changing the panel
 *   (in CI: GITHUB_TOKEN is provided automatically)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..");

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

/**
 * Where this repository lives, taken from the manifest's own `repository.url` rather than from a
 * constant or `git remote` — the check then verifies that the manifest and the repository agree
 * about *both* things, not just one.
 */
function repositorySlug() {
  const url = manifest.repository?.url ?? "";
  const match = /^git\+(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!match)
    throw new Error(`cannot read an owner/repo out of repository.url: ${JSON.stringify(url)}`);
  return { owner: match[1], repo: match[2] };
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function main() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("✗ no GH_TOKEN / GITHUB_TOKEN — the About panel cannot be read.");
    console.error("  This check failing because it could not run is correct: it is not a pass.");
    process.exit(1);
  }

  const { owner, repo } = repositorySlug();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "pi-ptc-subagents-check-repo-metadata",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    console.error(
      `✗ could not read the About panel: GitHub answered ${response.status} ${response.statusText}`,
    );
    console.error("  Treat that as unverified, not as agreement — the two are different states.");
    process.exit(1);
  }

  const remote = await response.json();

  const repairs = [];

  if (remote.description !== manifest.description) {
    repairs.push(
      `description differs\n` +
        `      repository: ${JSON.stringify(remote.description)}\n` +
        `      manifest:   ${JSON.stringify(manifest.description)}\n` +
        `      repair:     gh repo edit ${owner}/${repo} --description ${JSON.stringify(manifest.description)}`,
    );
  }

  const keywords = manifest.keywords ?? [];
  const missing = keywords.filter((k) => !(remote.topics ?? []).includes(k));
  if (missing.length > 0) {
    const add = missing.map((k) => `--add-topic ${k}`).join(" ");
    repairs.push(
      `keywords missing from the repository's topics: ${missing.join(", ")}\n` +
        `      repair:     gh repo edit ${owner}/${repo} ${add}`,
    );
  }

  if ((remote.homepage ?? "") !== manifest.homepage) {
    repairs.push(
      `homepage differs\n` +
        `      repository: ${JSON.stringify(remote.homepage)}\n` +
        `      manifest:   ${JSON.stringify(manifest.homepage)}\n` +
        `      repair:     gh repo edit ${owner}/${repo} --homepage ${JSON.stringify(manifest.homepage)}`,
    );
  }

  if (repairs.length > 0) {
    console.error(`✗ the About panel and the manifest disagree on ${repairs.length} field(s):\n`);
    for (const repair of repairs) console.error(`   ${repair}`);
    console.error(
      "\n  The repository's metadata is not version-controlled, so this is repaired out of band\n" +
        "  by design. Fix it with the command above; there is no commit that carries it.",
    );
    process.exit(1);
  }

  console.log(
    `✓ repository metadata — description, ${keywords.length}/${keywords.length} keywords present as ` +
      `topics, and homepage all agree with the manifest (${remote.topics?.length ?? 0} topics set)`,
  );
  console.log(`    topics: ${(remote.topics ?? []).slice().sort(byName).join(", ")}`);
}

main().catch((error) => {
  console.error(`✗ could not verify the About panel: ${error.message}`);
  process.exit(1);
});
