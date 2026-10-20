/**
 * Mechanical gate: has the upstream `code-review` skill moved since we last synced it?
 *
 * Why this exists at all. The upstream discipline (upstream's own `docs/engineering/code-review.md`)
 * says: *"Keep a note of the commit you forked from so you can re-sync by hand."* Keeping the note
 * only makes **discovering** the drift easy -- it does not make **failing to discover it** impossible.
 * This script is the second half: it reads the `base-commit` recorded in
 * `docs/agents/code-review-upstream.md`, asks GitHub which commits have touched the upstream skill
 * since, and fails when there are commits we have not recorded a verdict for.
 *
 * Why it is NOT part of the default release gate. It needs the network, and a pull-request gate that
 * depends on the network stops being a gate (it fails for reasons that have nothing to do with the
 * diff). Same call as `pnpm run compat:pi`: a manual check that runs before a release, not a check
 * CI runs on every push.
 *
 * Exit codes, all distinct so a caller can tell them apart:
 *   0  upstream has not moved since `base-commit`
 *   1  upstream has commits we have not recorded a verdict for  -> re-sync needed
 *   2  the check could not run (missing tool, network failure, unparsable doc)  -> NOT a pass
 *
 * Exit code 2 exists because "I could not check" and "there is nothing to check" are different
 * states, and collapsing them is how a gate silently stops gating. The "could not run" path is
 * therefore a thrown `GateFailure`, never a quiet `return`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UPSTREAM_REPO = "mattpocock/skills";
const UPSTREAM_SKILL_PATH = "skills/engineering/code-review/SKILL.md";
const BASELINE_DOC = new URL("../docs/agents/code-review-upstream.md", import.meta.url);

/** A "the check could not run" outcome. Distinct from "upstream moved" on purpose. */
class GateFailure extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GateFailure";
    this.code = code;
  }
}

/** Report a failure and stop. Always throws, so callers can `return fail(...)` safely. */
function fail(message, code = 2) {
  throw new GateFailure(message, code);
}

/**
 * Read the baseline doc.
 *
 * The `@returns` annotation is load-bearing, not decoration. `tsconfig.json` includes only
 * `src` and `tests`, so this file is never checked by `tsc`; oxlint's type-aware mode is the
 * only thing that types it, and it infers `readFileSync(<URL>, "utf8")` as `any`. One `any`
 * here poisons every value derived from the file, and `restrict-template-expressions` then
 * rejects them. The annotation pins the type where the file is actually checked.
 *
 * @returns {string}
 */
function readBaselineDoc() {
  try {
    return readFileSync(BASELINE_DOC, "utf8");
  } catch (cause) {
    return fail(`cannot read docs/agents/code-review-upstream.md: ${String(cause)}`);
  }
}

/**
 * Pull the `base-commit` SHA out of the baseline doc.
 *
 * The doc is the single source of truth, so this reads it rather than duplicating the SHA in a
 * constant here -- a second copy of the same fact is exactly the drift this whole mechanism exists
 * to catch.
 *
 * @param {string} doc
 * @returns {string}
 */
function readBaseCommit(doc) {
  const line = doc.split("\n").find((candidate) => candidate.includes("base-commit"));
  if (line === undefined) {
    return fail("docs/agents/code-review-upstream.md has no `base-commit` line");
  }
  const sha = /`([0-9a-f]{7,40})`/.exec(line)?.[1];
  if (sha === undefined) {
    return fail(
      "docs/agents/code-review-upstream.md has a `base-commit` line but no hex SHA in it -- " +
        "the extraction would silently compare against nothing",
    );
  }
  return sha;
}

/**
 * List the upstream commits that touched the skill, newest first.
 *
 * Uses `gh` because the repo already depends on it for the issue tracker
 * (`docs/agents/issue-tracker.md`) and it handles auth. A missing or failing `gh` is exit code 2,
 * never a silent pass.
 *
 * @returns {{ sha: string, date: string, message: string }[]}
 */
function listUpstreamCommits() {
  let stdout;
  try {
    stdout = execFileSync(
      "gh",
      [
        "api",
        `repos/${UPSTREAM_REPO}/commits?path=${UPSTREAM_SKILL_PATH}&per_page=100`,
        "--jq",
        '.[] | "\\(.sha) \\(.commit.author.date) \\(.commit.message | split("\\n")[0])"',
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (cause) {
    return fail(
      "could not query GitHub via `gh`. Install/authenticate gh, or set GITHUB_TOKEN, then re-run. " +
        `Underlying error: ${String(cause)}`,
    );
  }

  const commits = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", date = "", ...rest] = line.split(" ");
      return { sha, date, message: rest.join(" ") };
    });

  if (commits.length === 0) {
    return fail(
      `the GitHub query for ${UPSTREAM_REPO} ${UPSTREAM_SKILL_PATH} returned no commits -- ` +
        "either the path moved upstream or the API shape changed. Treat as unknown, not as up to date.",
    );
  }
  return commits;
}

function main() {
  const doc = readBaselineDoc();
  const baseCommit = readBaseCommit(doc);
  const commits = listUpstreamCommits();

  const baseIndex = commits.findIndex((commit) => commit.sha.startsWith(baseCommit));
  if (baseIndex === -1) {
    return fail(
      `base-commit ${baseCommit} is not among the ${commits.length} commits that touched ` +
        `${UPSTREAM_SKILL_PATH} upstream. The recorded baseline is dangling (upstream history was ` +
        "rewritten, or the skill was renamed). Re-establish the baseline by hand.",
    );
  }

  const newer = commits.slice(0, baseIndex);
  if (newer.length === 0) {
    process.stdout.write(
      `check:code-review-upstream: upstream has not moved since ${baseCommit} ` +
        `(${commits.length} commit(s) touch ${UPSTREAM_SKILL_PATH} in total).\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `check:code-review-upstream: upstream moved in ${newer.length} commit(s) since the recorded ` +
      `baseline ${baseCommit}:\n`,
  );
  for (const commit of newer) {
    process.stderr.write(
      `  ${commit.sha.slice(0, 8)}  ${commit.date.slice(0, 10)}  ${commit.message}\n`,
    );
  }
  process.stderr.write(
    "\nEach of these needs a verdict (adopt / adapt / reject) recorded in " +
      "docs/agents/code-review-upstream.md, then a bump of `base-commit`.\n" +
      "See the '重同步命令' section of that doc for the commands.\n",
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  if (error instanceof GateFailure) {
    process.stderr.write(`check:code-review-upstream: ${error.message}\n`);
    process.exit(error.code);
  }
  throw error;
}
