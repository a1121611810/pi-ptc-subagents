/**
 * Binds the two sides of the Q9-D fact.
 *
 * The fact used to live in two places at once: a hand-copied 9-row table in the code-review
 * skill (which had already lost a row once -- `ptc-bgdispatch-contract.md` was missing from the
 * copy, so Q9-D never fired for the most-anchored rule in the repo) and the prose in each rule
 * file's `## 严重性升级(Q9-D)` section. The hand copy is gone (issue #254, ticket ②): the
 * machine-side fact is now one entry per RULE FILE in `.opencodereview/rule.json`'s top-level
 * `q9d` map, and the prose side is still the rule file's own section.
 *
 * Two independent artifacts, one fact -- so the fixture's job is to make them agree, and to go
 * RED when either one moves alone:
 *
 *   - change `q9d`'s `escalate` while the rule file stays put  -> red
 *   - change the rule file's section while `q9d` stays put      -> red
 *
 * Expected-value sources (testing-constraints #4): the machine side is `.opencodereview/rule.json`
 * (the repo's own anchor list, `rules[].rule`); the prose side is each rule file's
 * `## 严重性升级(Q9-D)` section; the convention for a rule file that has no such section is the
 * issue #254 brief ("no section => 不升级"), pinned below on the reader itself so it cannot rot
 * into a guess.
 *
 * Scope: this fixture reads the rule files' `## 严重性升级(Q9-D)` sections ONLY. It never reads
 * or asserts on their check items — those carry the ownership markers, and
 * `tests/review-layer-ownership.test.ts` is the fixture for them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RULE_JSON_PATH = join(REPO_ROOT, ".opencodereview/rule.json");

/** The judgement-call catch-all layer: the brief pins its verdict to 否 / judgement call. */
const GENERAL_RULE = ".opencodereview/rules/general.md";

interface Q9dEntry {
  readonly escalate: boolean;
}

interface RuleJsonShape {
  readonly rules: { readonly path: string; readonly rule: string }[];
  readonly q9d: Record<string, Q9dEntry>;
}

/**
 * Read a file or fail loudly.
 *
 * IO boundary: a missing or unreadable file must not read as an empty section -- a guard that
 * passes because its input vanished is not a guard (testing-constraints #1 / #3).
 */
function readText(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${label} (${path}): ${String(cause)}`);
  }
}

/**
 * Parse rule.json into the shape this fixture needs, failing loudly on anything malformed.
 *
 * `q9d` is validated here rather than trusted: a missing map, a missing entry, or an entry whose
 * `escalate` is not a boolean is an explicit error, not a silently-absent verdict.
 */
function parseRuleJson(raw: string): RuleJsonShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(".opencodereview/rule.json is not valid JSON: " + String(cause));
  }

  const rules = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(".opencodereview/rule.json has no non-empty rules array");
  }

  const q9dRaw = (parsed as { q9d?: unknown }).q9d;
  if (typeof q9dRaw !== "object" || q9dRaw === null || Array.isArray(q9dRaw)) {
    throw new Error(".opencodereview/rule.json has no top-level q9d map");
  }

  const q9d: Record<string, Q9dEntry> = {};
  for (const [ruleFile, entry] of Object.entries(q9dRaw as Record<string, unknown>)) {
    const escalate = (entry as { escalate?: unknown } | null | undefined)?.escalate;
    if (typeof escalate !== "boolean") {
      throw new Error(`q9d["${ruleFile}"] has no boolean "escalate" field`);
    }
    q9d[ruleFile] = { escalate };
  }

  return { rules: rules as RuleJsonShape["rules"], q9d };
}

/**
 * The rule file's `## 严重性升级(Q9-D)` section, heading excluded -- or null when it has none.
 *
 * The heading is matched by prefix because one rule file spells it `## 严重性升级(Q9-D hook)`.
 * The body is everything up to the next `## ` heading.
 */
function escalationSection(ruleFile: string): string | null {
  const text = readText(join(REPO_ROOT, ruleFile), ruleFile);
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith("## 严重性升级"));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The two signals a `## 严重性升级(Q9-D)` section can carry.
 *
 * Read them independently, because the order of the two checks used to decide the verdict, and
 * that made a legitimate clarification flip it: an escalate section that says 「以下情况不升级」
 * mentions 不升级, and checking 不升级 first turned that section into a no-escalate verdict.
 * The verdict must not depend on which signal a section happens to mention first.
 */
function escalationSignals(section: string): { noEscalate: boolean; escalate: boolean } {
  return {
    noEscalate: section.includes("不升级"),
    escalate: /delegate[^\n]{0,12}复核/.test(section),
  };
}

/**
 * The prose verdict, read off the section above.
 *
 * Four outcomes, and the third one matters: a section that commits to neither escalation nor
 * non-escalation is AMBIGUOUS, not a default. It must go red for a human to re-confirm rather
 * than flip the verdict silently -- the failure mode this whole ticket exists to prevent.
 *
 *   - no section at all  -> no-escalate  (the convention; see the convention test below)
 *   - "不升级"           -> no-escalate  (an explicit veto)
 *   - delegate 复核     -> escalate     (the section commits to a delegate review)
 *   - BOTH of the two   -> ambiguous    (a human must re-confirm: the section contradicts
 *                                         itself, or a clarification inside it reads as a veto)
 */
function verdictOf(section: string | null): "escalate" | "no-escalate" | "ambiguous" {
  if (section === null) return "no-escalate";
  const { noEscalate, escalate } = escalationSignals(section);
  if (noEscalate && escalate) return "ambiguous";
  if (noEscalate) return "no-escalate";
  if (escalate) return "escalate";
  return "ambiguous";
}

/**
 * Why a section came out ambiguous, in words. The failure message has to NAME what it found:
 * "states neither 升级 nor 不升级" and "mentions both 不升级 and delegate 复核" call for different
 * fixes, and a message that says only "ambiguous" sends the reader back to the file to work out
 * which of the two it is.
 */
function ambiguityReason(section: string): string {
  const { noEscalate, escalate } = escalationSignals(section);
  if (noEscalate && escalate) {
    return "the section mentions both 不升级 and delegate 复核; re-confirm by hand";
  }
  return "the section states neither 升级 nor 不升级; re-confirm it by hand";
}

/** The distinct rule files rule.json dispatches -- the repo's own anchor list. */
function dispatchedRuleFiles(rules: RuleJsonShape["rules"]): string[] {
  return [...new Set(rules.map((rule) => rule.rule))].sort();
}

describe("the Q9-D fact in rule.json", () => {
  test("a missing rule file is an explicit failure, not an empty section", () => {
    // Failure path of the IO boundary: reading a rule file that does not exist must throw.
    // If it returned an empty section instead, the verdict reader would call it "no-escalate"
    // and the alignment assertion below would pass on a vanished input.
    expect(() =>
      readText(join(REPO_ROOT, ".opencodereview/rules/no-such-rule.md"), "a missing rule"),
    ).toThrow();
  });

  test("rule.json must parse into a rules array and a q9d map", () => {
    // Failure path of the parse: malformed JSON and a missing q9d map are both explicit errors.
    expect(() => parseRuleJson("{ not json")).toThrow();
    expect(() =>
      parseRuleJson(JSON.stringify({ rules: [{ path: "src/x.ts", rule: "r.md" }] })),
    ).toThrow();
    expect(() => parseRuleJson(JSON.stringify({ rules: [], q9d: {} }))).toThrow();

    // Happy path: the real file parses into both halves.
    const parsed = parseRuleJson(readText(RULE_JSON_PATH, ".opencodereview/rule.json"));
    expect(parsed.rules.length).toBeGreaterThan(0);
    expect(Object.keys(parsed.q9d).length).toBeGreaterThan(0);
  });

  test("every dispatched rule file has exactly one q9d entry (one fact per rule file)", () => {
    // Expected value source: rule.json's own anchor list. The key set must equal the set of
    // distinct rule files it dispatches -- no missing entry (a rule that never escalates) and no
    // orphan entry (a verdict for a rule nobody dispatches).
    const parsed = parseRuleJson(readText(RULE_JSON_PATH, ".opencodereview/rule.json"));
    const dispatched = dispatchedRuleFiles(parsed.rules);
    const keyed = Object.keys(parsed.q9d).sort();

    expect(dispatched.length).toBeGreaterThan(0);
    expect(keyed).toEqual(dispatched);
  });
});

describe("the Q9-D fact and the rule files' 严重性升级 sections", () => {
  test("the convention: no 严重性升级 section means 不升级", () => {
    // The convention is a property of the READER, so it is asserted on the reader itself --
    // that keeps it non-vacuous even if every rule file later grows a section. Expected value
    // source: issue #254's brief ("无此节 ⇒ 不升级"), plus the two shapes the sections really
    // use, plus the ambiguous case that must NOT be resolved by guessing.
    expect(verdictOf(null)).toBe("no-escalate");
    expect(verdictOf("## 严重性升级(Q9-D)\n\n不升级 —— judgement call 兜底层。")).toBe(
      "no-escalate",
    );
    expect(verdictOf("## 严重性升级(Q9-D)\n\n任何命中 → delegate 复核。")).toBe("escalate");
    expect(verdictOf("## 严重性升级(Q9-D)\n\n这一节只说了一句跟判定无关的话。")).toBe("ambiguous");
  });

  test("a section carrying BOTH signals is ambiguous, and the reason names which", () => {
    // The order-sensitivity this pins: a clarification inside an escalate section (「以下情况
    // 不升级」) mentions 不升级, and a reader that checks 不升级 first flips the verdict to
    // no-escalate. Both signals present => a human re-confirms; the reason says which case it
    // is, because the two cases need different fixes.
    // Expected value source: the two signal shapes the rule files really use, plus
    // `docs/agents/review-layers.md`'s "判断层给证据,判断层不替它下事实结论" discipline —
    // an ambiguous escalation is a question for a human, not a default.
    const both = "## 严重性升级(Q9-D)\n\n以下情况不升级:任何其他命中 → delegate 复核。";

    expect(verdictOf(both)).toBe("ambiguous");
    expect(ambiguityReason(both)).toBe(
      "the section mentions both 不升级 and delegate 复核; re-confirm by hand",
    );
    expect(ambiguityReason("## 严重性升级(Q9-D)\n\n这一节只说了一句跟判定无关的话。")).toBe(
      "the section states neither 升级 nor 不升级; re-confirm it by hand",
    );
  });

  test("the machine-side verdict equals the rule file's own 严重性升级 verdict", () => {
    // The two-way alignment. Expected value source: the rule file's section (prose) against
    // rule.json's q9d map (machine). Counterfactuals: change either side alone and this goes
    // red -- which is the point of keeping the fact in two places with a guard on both.
    const parsed = parseRuleJson(readText(RULE_JSON_PATH, ".opencodereview/rule.json"));
    const ambiguous: string[] = [];
    const mismatched: string[] = [];

    for (const ruleFile of dispatchedRuleFiles(parsed.rules)) {
      const section = escalationSection(ruleFile);
      const prose = verdictOf(section);
      if (prose === "ambiguous") {
        // The message has to NAME what was found: "mentions both" and "states neither" are
        // different defects, and a reader told only "ambiguous" has to go re-read the file to
        // find out which one it is.
        ambiguous.push(`${ruleFile}: ${ambiguityReason(section ?? "")}`);
        continue;
      }
      const machine = parsed.q9d[ruleFile]?.escalate;
      if (machine !== (prose === "escalate")) {
        mismatched.push(
          `${ruleFile}: rule.json says escalate=${String(machine)}, the rule file's 严重性升级 section says ${prose}`,
        );
      }
    }

    expect(
      ambiguous,
      "a rule file's 严重性升级 section does not resolve to one verdict; re-confirm it by hand",
    ).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  test("the nine rule files still resolve as before: 7 escalate, 1 no-escalate, 1 by convention", () => {
    // The reader change (both signals => ambiguous) must not have moved any rule file's
    // verdict. Expected value source: rule.json's q9d map, cross-checked against each rule
    // file's own section -- the two artifacts are independent, and the counts are pinned so a
    // reader change that silently re-resolves a section is visible.
    const parsed = parseRuleJson(readText(RULE_JSON_PATH, ".opencodereview/rule.json"));
    const dispatched = dispatchedRuleFiles(parsed.rules);
    const verdicts = dispatched.map((ruleFile) => ({
      ruleFile,
      hasSection: escalationSection(ruleFile) !== null,
      verdict: verdictOf(escalationSection(ruleFile)),
    }));

    expect(dispatched.length, "the rule.json anchor list is empty").toBe(9);
    expect(
      verdicts.filter((entry) => entry.verdict === "escalate").map((entry) => entry.ruleFile),
      "the rule files that escalate",
    ).toEqual([
      ".opencodereview/rules/doc-sync.md",
      ".opencodereview/rules/ptc-bgdispatch-contract.md",
      ".opencodereview/rules/ptc-config-wiring.md",
      ".opencodereview/rules/ptc-protocol-pair-correctness.md",
      ".opencodereview/rules/ptc-worker-lifecycle.md",
      ".opencodereview/rules/test-discipline-oracle.md",
      ".opencodereview/rules/test-discipline.md",
    ]);
    expect(
      verdicts
        .filter((entry) => entry.verdict === "no-escalate" && entry.hasSection)
        .map((entry) => entry.ruleFile),
      "the rule file that says 不升级 in its own section",
    ).toEqual([".opencodereview/rules/ptc-render-bounds.md"]);
    expect(
      verdicts.filter((entry) => !entry.hasSection).map((entry) => entry.ruleFile),
      "the rule file that carries no 严重性升级 section at all",
    ).toEqual([".opencodereview/rules/general.md"]);
  });

  test("a rule file without a 严重性升级 section is recorded as no-escalation", () => {
    // The convention applied to the repo: general.md is the judgement-call catch-all layer and
    // has no such section, so the brief pins it to 否. Expected value source: issue #254's brief
    // ("general.md stays 否 / judgement call").
    const parsed = parseRuleJson(readText(RULE_JSON_PATH, ".opencodereview/rule.json"));
    const withoutSection = dispatchedRuleFiles(parsed.rules).filter(
      (ruleFile) => escalationSection(ruleFile) === null,
    );
    const escalated = withoutSection.filter((ruleFile) => parsed.q9d[ruleFile]?.escalate === true);

    expect(
      escalated,
      "a rule file with no 严重性升级 section must be recorded as no-escalation",
    ).toEqual([]);
    expect(parsed.q9d[GENERAL_RULE]?.escalate).toBe(false);
  });
});
