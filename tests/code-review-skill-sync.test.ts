/**
 * Pins the project code-review skill's checkable claims.
 *
 * The failure mode this exists for. `.agents/skills/code-review/SKILL.md` is a **fork** of the
 * upstream `mattpocock/skills` code-review skill, so nothing keeps it in step with the repo it
 * describes. The drift is invisible to CI: no test read the skill file, and no workflow invokes
 * it. A review round measured the accumulated damage — the skill claimed `.yml` could not be
 * delegated to OCR (it can), named a hard-coded ADR count that was 23 ADRs stale, pointed a rule
 * anchor at the wrong rule file, and advertised a fixture that did not check the thing it claimed
 * to check. Every one of those is a claim a reviewer would act on.
 *
 * So the guard asserts on **claims the skill makes about this repo**, and each one has a clean
 * counterfactual:
 *   - delete `CONTRIBUTING.md` from the skill's standards list -> the upstream-rule test goes red
 *   - drop the skill's "no call edge is not no tests" discipline -> the blast-radius test goes red
 *   - copy the three-layer table into a second file -> the one-home test goes red
 *   - write "21 篇 ADR" back into the skill -> the no-hard-coded-count test goes red
 *   - restore the old ".yml 在 OCR 选择层不可见" sentence -> the yml test goes red
 *
 * The skill's hand-copied Q9-D rule table is GONE (issue #254, ticket ②): the fact now lives in
 * `.opencodereview/rule.json`'s top-level `q9d` map, one entry per rule file, and the guard for
 * it is `tests/review-layer-q9d-alignment.test.ts`. The describe group that guarded the copy was
 * deleted along with the copy -- a guard whose object no longer exists has nothing to assert.
 *
 * Expected-value sources are independent of the skill file itself: the filesystem (`existsSync`,
 * `git ls-files`) for CONTRIBUTING.md and for the one-home check, `.opencodereview/rule.json` for
 * the rule anchors, and issue #254's brief for the three-layer contract. Nothing here infers an
 * expectation from the implementation it checks.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_PATH = join(REPO_ROOT, ".agents/skills/code-review/SKILL.md");
const BASELINE_PATH = join(REPO_ROOT, "docs/agents/code-review-upstream.md");
const RULE_JSON_PATH = join(REPO_ROOT, ".opencodereview/rule.json");
const RULE_AUTHORING_MANUAL_PATH = join(REPO_ROOT, "docs/agents/ocr-rules.md");

/** Patterns that match every path; a rule on one of these is filler, not a claim about a file. */
const UNIVERSAL = new Set(["**", "**/*", "**/**", "**/*.*"]);

/**
 * Read a file or fail loudly.
 *
 * A missing file must not read as an empty string: every assertion below would then pass
 * vacuously, and a guard that passes because its input vanished is not a guard.
 */
function readText(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${label} (${path}): ${String(cause)}`);
  }
}

function readRuleJson(): { rules: { path: string; rule: string }[] } {
  const parsed = JSON.parse(readText(RULE_JSON_PATH, ".opencodereview/rule.json")) as {
    rules?: { path: string; rule: string }[];
  };
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error(".opencodereview/rule.json has no non-empty rules array");
  }
  return { rules: parsed.rules };
}

const skill = readText(SKILL_PATH, "the code-review skill");
const baseline = readText(BASELINE_PATH, "the upstream baseline doc");
const ruleAuthoringManual = readText(RULE_AUTHORING_MANUAL_PATH, "the rule-authoring manual");

/**
 * Extract one `## <title>` section of the skill, heading excluded.
 *
 * Why not just assert on the whole file: a name appearing **anywhere** is not the claim being
 * made. The rule table lives in one section and the standards list in another, and the two
 * names also show up in the upstream-verdict prose. Asserting on the whole file let a mutation
 * that deleted the row but left the name mentioned in a different section pass — the guard was
 * measuring the wrong thing. Scoping to the section makes the counterfactual bite.
 */
function section(title: string): string {
  const lines = skill.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## " + title);
  if (start === -1) {
    throw new Error(`the skill has no section titled "## ${title}"`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Extract one `### <title>` subsection of the skill, heading excluded.
 *
 * The blast-radius audit is a `###` subsection of the Spec-axis block, and it is read on its own:
 * the claim under test is about THAT section, and a token appearing elsewhere in the skill (the
 * Q8 section used to carry the same claim) would make the guard pass on a skill that had lost it.
 */
function subsection(title: string): string {
  const lines = skill.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### " + title);
  if (start === -1) {
    throw new Error(`the skill has no subsection titled "### ${title}"`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## ") || line.startsWith("### "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * A rule file's `## 严重性升级(Q9-D)` section -- heading excluded, or null when it has none.
 *
 * One rule file spells the heading `## 严重性升级(Q9-D hook)`, so the match is by prefix. Only
 * the escalation section is read: the rule files' check items belong to another change
 * (issue #254, ticket ①) and this guard must not depend on them.
 */
function escalationSection(ruleFile: string): string | null {
  const lines = readText(join(REPO_ROOT, ruleFile), ruleFile).split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith("## 严重性升级"));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Every git-tracked markdown file, as paths relative to the repository root.
 *
 * The one-home check has to see the whole repository: a copy of the three-layer table in a file
 * nobody happens to read is still a second fact to keep in step.
 */
function trackedMarkdown(): string[] {
  const out = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * One markdown table row, normalized: the padding `oxfmt` puts on table cells removed.
 *
 * The one-home marker is matched on the normalized form so that reformatting the table (which
 * the repo's formatter does, and does again on every version bump) does not silently disarm the
 * guard -- while a copy with a different column set or a different column order still misses.
 */
function normalizeTableRow(line: string): string {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .join("|");
}

describe("the code-review skill's standards sources", () => {
  test("CONTRIBUTING.md is on the standards-source list (upstream's hard rule)", () => {
    // Upstream #1208 made this mandatory: when CONTRIBUTING.md exists it must be on the
    // standards-source list. Expected value source: the file exists on disk.
    expect(existsSync(join(REPO_ROOT, "CONTRIBUTING.md"))).toBe(true);

    // The section mentions CONTRIBUTING.md twice -- once in the enumeration, once in the
    // sentence explaining why it must be there. Only the enumeration is the claim, so the
    // assertion targets the enumeration line, not the section as a whole. Targeting the
    // section let a mutation that dropped the entry from the list pass.
    const enumeration = section("Standards 轴")
      .split("\n")
      .find((line) => line.includes("必有"));
    expect(enumeration, "the Standards 轴 section has no standards enumeration line").toBeDefined();
    expect(enumeration).toContain("CONTRIBUTING.md");
  });

  test("the upstream baseline doc is reachable from the skill", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
    expect(skill).toContain("docs/agents/code-review-upstream.md");
  });
});

describe("the code-review skill's factual claims", () => {
  test("no hard-coded ADR count", () => {
    // The count drifts every time an ADR lands. The skill points at docs/adr/README.md
    // instead; a number written here is a claim that is wrong within a week.
    expect(skill).not.toMatch(/\d+\s*篇/);
  });

  test("no hard-coded count of reviewable markdown", () => {
    // Same drift class: the .md population grows with the repo, and what matters is
    // will_review, never how many there are.
    expect(skill).not.toMatch(/\d+\s*个[^。\n]*`?\.md`?/);
  });

  test("the skill does not claim .yml is invisible to OCR", () => {
    // The stale claim, verbatim. It was wrong: .yml is selected for review and .github/
    // workflows/*.yml shows up in `ocr delegate preview`'s reviewable_files.
    expect(skill).not.toContain("`.md` 与 `.yml` 在 OCR 选择层不可见");

    // ...and the corrected claim has to be there too, so deleting both sentences cannot
    // make the guard pass. Tolerant of rewording: .yml and 可审 within 40 characters.
    expect(skill).toMatch(/`\.yml`[^\n]{0,40}可审/);
  });

  test("F4 is named as a blocking pattern, not only F1/F2/F3", () => {
    // F4 (assertion-free test body) is in the fixture and in docs/testing-constraints.md;
    // the skill was the one place that still listed only F1/F2/F3. The claim is not
    // "the token F4 appears" but "F4 is a blocking finding", so the assertion looks for a
    // line carrying both the pattern and the blocking marker.
    const blockingF4 = section("Spec 轴强制增量(阻塞项)")
      .split("\n")
      .filter((line) => line.includes("F4") && line.includes("阻塞"));
    expect(blockingF4.length, "F4 is not named as a blocking pattern").toBeGreaterThan(0);

    // The second half of this claim used to be asserted on the skill's hand-copied Q9-D table,
    // which issue #254 ticket ② deleted -- the fact now lives in rule.json's top-level `q9d`
    // map. The claim's new home is the rule file's own escalation section, which is the prose
    // side the machine-side map is aligned against by tests/review-layer-q9d-alignment.test.ts.
    // Expected value source: .opencodereview/rules/test-discipline.md.
    const escalation = escalationSection(".opencodereview/rules/test-discipline.md") ?? "";
    expect(escalation, "test-discipline.md has no 严重性升级 section").not.toBe("");
    expect(escalation).toContain("F4");
  });

  test("every rule-anchor claim the skill makes matches rule.json", () => {
    // The skill's overlay section says which project rule anchors which source file. It used
    // to file `turn-pools.ts` under ptc-config-wiring.md; rule.json anchors it to
    // ptc-worker-lifecycle.md. A wrong attribution sends a reviewer to the wrong checklist.
    // Expected value source: .opencodereview/rule.json, cross-checked against the claims.
    const { rules } = readRuleJson();

    // Exact anchors only -- the `**` catch-all is first-match-wins filler, not a claim about
    // a named file, and it would match every basename.
    const anchoredTo = new Map<string, string>();
    for (const rule of rules) {
      if (UNIVERSAL.has(rule.path)) continue;
      anchoredTo.set(basename(rule.path), basename(rule.rule));
    }

    const overlay = section("仓库锚点(overlay 层)");
    const claims: { file: string; rule: string }[] = [];

    // Forward form: `<rule path>.md`(锚 `file.ts` [ / `other.ts` ]). The rule is written
    // as a full path in the skill (`.opencodereview/rules/<name>.md`), so the match keeps
    // the path and the basename is taken afterwards -- a regex that only accepted a bare
    // rule name silently matched nothing.
    for (const match of overlay.matchAll(/`([^`]*\.md)`\(锚 ([^)]*)\)/g)) {
      const ruleName = basename(match[1] ?? "");
      for (const file of (match[2] ?? "").matchAll(/`([A-Za-z0-9._-]+\.ts)`/g)) {
        claims.push({ file: file[1] ?? "", rule: ruleName });
      }
    }

    // Reverse form: `file.ts` 实际锚在 `some-rule.md`
    for (const match of overlay.matchAll(/`([A-Za-z0-9._-]+\.ts)` 实际锚在 `([a-z0-9-]+\.md)`/g)) {
      claims.push({ file: match[1] ?? "", rule: match[2] ?? "" });
    }

    // Vacuity guard: if the extractor stopped matching, the loop below would check nothing
    // and the test would pass on a skill that makes no claims at all.
    expect(
      claims.length,
      "no rule-anchor claim was extracted; the guard would be vacuous",
    ).toBeGreaterThan(0);

    const wrong = claims.filter((claim) => anchoredTo.get(claim.file) !== claim.rule);
    expect(wrong).toEqual([]);
  });
});

describe("the code-review skill's factual-layer reading discipline", () => {
  test("'no call edge on the graph' is not read as 'no tests' in the blast-radius audit", () => {
    // Issue #254 (ticket ③). The factual layer supplies evidence; the mechanical layer owns
    // "are there tests". CodeGraph's "no tests found within N caller hops" is a GRAPH FACT,
    // and reading it as the CONCLUSION "no tests" is the over-reach this discipline forbids.
    // Expected value source: issue #254's brief (the three-layer contract).
    const audit = subsection("Audit 1 · 调用点完备性(blast radius)");

    // The discipline itself, in the skill's own words.
    expect(audit).toContain("没有直接调用边");
    expect(audit).toContain("不能读作「无测试」");

    // The shape it defends against: a test that runs the code under test as a subprocess never
    // imports the symbol, so the graph has no call edge BY CONSTRUCTION. The in-repo example
    // has to exist for the example to be an example.
    expect(audit).toContain("子进程");
    expect(audit).toContain("tests/website-landing-tool-names.test.ts");
    expect(existsSync(join(REPO_ROOT, "tests/website-landing-tool-names.test.ts"))).toBe(true);

    // And the ownership: counting and running the tests is the mechanical layer's job.
    expect(audit).toContain("机械层");
  });
});

describe("the three-layer review apparatus", () => {
  test("the three-layer table lives in exactly one file", () => {
    // One fact, one home. A second copy of the table is a second thing to keep in step -- the
    // failure this repo already paid for with the hand-copied Q9-D rule table.
    // Expected value source: the filesystem (the git-tracked markdown).
    const marker = normalizeTableRow("| 层 | 载体 | 接口 | 归属（这层拥有的关注点） | 不归它管 |");
    const holders = trackedMarkdown().filter((relative) =>
      readText(join(REPO_ROOT, relative), relative)
        .split("\n")
        .some((line) => line.trim().startsWith("|") && normalizeTableRow(line) === marker),
    );

    expect(holders).toEqual(["docs/agents/review-layers.md"]);
  });

  test("the skill and the rule-authoring manual point at that one home", () => {
    // The pointer chain: both entry points name the file, neither copies the table.
    expect(skill).toContain("docs/agents/review-layers.md");
    expect(ruleAuthoringManual).toContain("docs/agents/review-layers.md");
  });

  test("the flow tells the author to pick a layer before adding a rule", () => {
    // Issue #254 (ticket ④): adding a check item has a layer decision attached to it.
    const flow = section("流程");
    expect(flow).toContain("新增规则前先判层");
    expect(flow).toContain("docs/agents/review-layers.md");
  });
});

describe("the upstream decisions the skill must carry", () => {
  // Each of these is an upstream change (or an upstream-documented bug) that was ported in
  // the 2026-10-20 sync. Without an assertion, a later edit can quietly drop one and the
  // ledger row claiming it was closed would not be true -- the repository's closure
  // discipline requires a named test that goes red when the fix is reverted.
  const flow = section("流程");

  test("the sub-agents are dispatched in the foreground", () => {
    // Upstream #1208. In this repository the background branch of ptc_subagent returns a
    // handle and nothing else, so a background dispatch without polling yields no report
    // at all. This repository is the reason the upstream wording had to be taken seriously.
    expect(flow).toContain("都走前台");
    expect(flow).toContain("禁止后台派发");
  });

  test("the issue tracker is resolved through the tracker doc, not a hard-coded command", () => {
    // Upstream #1208, adapted: the path is fixed in this repo, but the command was not
    // (the setup skill supports github / gitlab / local trackers).
    expect(flow).toContain("### Issue tracker");
  });

  test("both sub-agent briefs carry the no-re-entry guard", () => {
    // Upstream documents this as a known open bug -- a sub-agent can find the skill again
    // and fan out again; one report reached more than 50 agents. The one-line fix upstream
    // documents is applied here.
    expect(flow).toContain("Do not invoke /code-review or spawn additional agents");
  });

  test("a fixed point that was not given is asked for, not guessed", () => {
    expect(flow).toContain("用户没给就问");
  });

  test("the commit list is captured for the sub-agent briefs", () => {
    expect(flow).toContain("git log <fixed-point>..HEAD --oneline");
  });

  test("the scope-creep check is present", () => {
    // Upstream's Spec brief asks for (a) missing, (b) scope creep, (c) implemented wrongly.
    // This repository's Spec axis had (a) and (c) and was missing (b) entirely.
    // Asserted on the heading, not on the word: step 6 also mentions the section by name,
    // so a bare token check would still pass with the section itself deleted.
    expect(skill).toContain("### 越界实现(scope creep)");
  });
});

describe("the upstream baseline record", () => {
  test("the baseline doc records a hex base-commit", () => {
    // The script scripts/check-code-review-upstream.mjs parses exactly this line. If the
    // line loses its SHA, the script cannot compare against anything -- so the parse
    // target is asserted here rather than trusted.
    const line = baseline.split("\n").find((candidate) => candidate.includes("base-commit"));
    const sha = /`([0-9a-f]{7,40})`/.exec(line ?? "")?.[1] ?? "";

    expect(sha).not.toBe("");
  });

  test("the baseline doc records a verdict for every upstream change it synced", () => {
    // A baseline SHA with no verdict table means "we synced" and "we decided" have been
    // conflated. The table's verdict column is the record of the decision.
    expect(baseline).toContain("裁决");
    expect(baseline).toContain("adopt");
    expect(baseline).toContain("adapt");
  });
});
