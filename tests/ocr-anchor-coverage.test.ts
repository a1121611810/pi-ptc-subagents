import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Meta-guard for the open-code-review project rules.
 *
 * The failure mode this exists for: a rule file under .opencodereview/rules/ that no
 * entry in .opencodereview/rule.json references is a DEAD RULE - OCR resolves it for
 * nobody and silently falls back to the system built-in. That is exactly what
 * happened to general.md: it was cited by SKILL.md and AGENTS.md as a Standards-axis
 * source while rule.json referenced it zero times, so 7 production files and all 67
 * markdown files were reviewed against generic JS/React boilerplate (React Best
 * Practices / "prohibiting var" / "== is prohibited") instead.
 *
 * The ordering assertion below is verified against ocr v1.12.10, not assumed:
 * rule.json is strictly first-match-wins, so a catch-all must be last.
 * See docs/agents/ocr-rules.md for the full derivation.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RULE_JSON = fileURLToPath(new URL("../.opencodereview/rule.json", import.meta.url));
const RULES_DIR = fileURLToPath(new URL("../.opencodereview/rules/", import.meta.url));

interface ProjectRule {
  path: string;
  rule: string;
  merge_system_rule: boolean;
}

/** Patterns that match every path; any rule after one of these can never fire. */
const UNIVERSAL = new Set(["**", "**/*", "**/**", "**/*.*"]);

function readRuleJson(): { rules: ProjectRule[] } {
  // IO boundary: a missing or unparsable rule.json is an explicit failure, never
  // an empty rule set that would make every assertion below vacuously pass.
  let raw: string;
  try {
    raw = readFileSync(RULE_JSON, "utf8");
  } catch (cause) {
    throw new Error("cannot read .opencodereview/rule.json: " + String(cause));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(".opencodereview/rule.json is not valid JSON: " + String(cause));
  }
  const rules = (parsed as { rules?: ProjectRule[] }).rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(".opencodereview/rule.json has no non-empty rules array");
  }
  return { rules };
}

function listRuleFiles(): string[] {
  return readdirSync(RULES_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ".opencodereview/rules/" + name)
    .sort();
}

function hasOcr(): boolean {
  try {
    execFileSync("ocr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ocrAvailable = hasOcr();

describe(".opencodereview/rule.json integrity", () => {
  test("every rule file is referenced by at least one anchor (no dead rules)", () => {
    const { rules } = readRuleJson();
    const referenced = new Set(rules.map((rule) => rule.rule));
    const orphans = listRuleFiles().filter((file) => !referenced.has(file));

    // Expected value source: the invariant "an unreferenced rule file is never
    // dispatched to any reviewer" (docs/agents/ocr-rules.md section 7). The
    // counterfactual - delete the general.md anchor from rule.json - turns this
    // test red, which is the whole point of the guard.
    expect(orphans).toEqual([]);
    expect(referenced.size).toBeGreaterThan(0);
  });

  test("every anchor points at a rule file that exists", () => {
    const { rules } = readRuleJson();
    const missing = rules
      .map((rule) => rule.rule)
      .filter((rulePath) => {
        try {
          readFileSync(fileURLToPath(new URL("../" + rulePath, import.meta.url)), "utf8");
          return false;
        } catch {
          return true;
        }
      });
    expect(missing).toEqual([]);
  });

  test("the catch-all anchor is last - rule.json is first-match-wins", () => {
    const { rules } = readRuleJson();
    const firstUniversal = rules.findIndex((rule) => UNIVERSAL.has(rule.path));

    if (firstUniversal !== -1) {
      expect(firstUniversal).toBe(rules.length - 1);
    }

    // General form of the same hazard: nothing narrower may follow a catch-all,
    // because the catch-all would shadow it and that rule could never fire.
    const shadowed = rules.filter(
      (rule, index) =>
        index > 0 && UNIVERSAL.has(rules[index - 1]!.path) && !UNIVERSAL.has(rule.path),
    );
    expect(shadowed).toEqual([]);
  });

  test("the catch-all merges the system rule so generic checks survive", () => {
    const { rules } = readRuleJson();
    for (const rule of rules.filter((r) => UNIVERSAL.has(r.path))) {
      expect(rule.merge_system_rule).toBe(true);
    }
  });

  test("the catch-all resolves to general.md (the orphan that started this)", () => {
    const { rules } = readRuleJson();
    const catchAll = rules.find((rule) => UNIVERSAL.has(rule.path));
    expect(catchAll?.rule).toBe(".opencodereview/rules/general.md");
  });
});

describe("ocr resolves sentinel files to project rules", () => {
  // Assert on the resolved rule TITLE, never on the .md filename. `ocr rules check`
  // prints the rule body and never says which file the body came from - there is no
  // such column in `ocr delegate rule` groups[] either. Asserting on the filename
  // would fail 7/7 for a reason that has nothing to do with the anchors.
  //
  // Explicit skip, not an early return: vitest reports a skipped suite as SKIPPED
  // so CI can see the guard did not run (test-discipline-oracle.md T4).
  const sentinels = [
    { file: "src/runtime/protocol.ts", title: "PTC Protocol Pair-Correctness" },
    { file: "src/runtime/limits.ts", title: "PTC Config Wiring" },
    { file: "src/tools/text.ts", title: "PTC Render Bounds" },
    { file: "src/runtime/turn-pools.ts", title: "PTC Worker Lifecycle" },
    { file: "src/runtime/sub-call-tracker.ts", title: "Background Dispatch Contract" },
    { file: "tests/limits.test.ts", title: "Test Discipline" },
    { file: "docs/adr/0022-background-dispatch.md", title: "Doc Sync" },
    { file: "README.md", title: "General Review Baseline" },
  ];

  for (const { file, title } of sentinels) {
    test.skipIf(!ocrAvailable)(file + " resolves to " + title, () => {
      const stdout = execFileSync("ocr", ["rules", "check", file], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });

      // Failure path: ocr prints no Source line when the CLI is broken or the file
      // does not exist. Assert on the line rather than letting a silent pass.
      const source = /^Source:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
      expect(source, "ocr rules check " + file + " printed no Source line").toBeDefined();
      expect(source).toContain("Project");
      expect(stdout).toContain(title);
    });
  }

  // The trap this file used to fall into: markdown resolves fine at the PARSE layer
  // (ocr rules check / ocr delegate rule both return a project group for .md), but
  // the SELECTION layer drops it - `ocr delegate preview`, `ocr review` and
  // `ocr scan` all mark every .md will_review:false with exclude_reason
  // "unsupported_ext". So a docs/ADR review cannot be delegated to OCR; the host
  // agent has to apply the doc-sync checklist itself.
  test.skipIf(!ocrAvailable)("markdown is never selected for review, only parsed", () => {
    const stdout = execFileSync("ocr", ["scan", "--preview", "--format", "json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = (JSON.parse(stdout) as { files?: { path: string; will_review?: boolean }[] })
      .files;
    const markdown = (files ?? []).filter((file) => file.path.endsWith(".md"));

    expect(markdown.length, "no markdown was listed; the guard would be vacuous").toBeGreaterThan(
      0,
    );
    const reviewed = markdown.filter((file) => file.will_review);
    expect(reviewed.map((file) => file.path)).toEqual([]);
  });
});
