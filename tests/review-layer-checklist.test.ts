/**
 * The checklist-building step's guard (issue #254, acceptance ①).
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * Every check item in `.opencodereview/rules/*.md` carries an ownership marker
 * (`[机械: X]` / `[待补守卫: …]` / `[判断层: …]`), and the marker's promise is "the judgement
 * layer does not re-report what the mechanical layer already forces red". Until now nothing
 * read the markers: `ocr delegate rule` hands the whole rule file back as the checklist, marker
 * and all, so the promise was prose. `scripts/build-review-checklist.mjs` is the thing that
 * reads them, and THIS fixture is what proves it does.
 *
 * 口径 (why these assertions are these assertions):
 *
 *   - **The real script is run, not a copy of its rules.** A test that re-implements the filter
 *     tests the re-implementation: it can stay green while the script stays blind. So the test
 *     runs `scripts/build-review-checklist.mjs` over a delegate-rule JSON it writes to a
 *     throwaway directory.
 *   - **The expectations come from the real rule files, not from the script.** The rule files
 *     under `.opencodereview/rules/` are the independent artifact: the fixture reads them,
 *     quotes from them, and asserts on the script's output. Nothing here re-derives "which item
 *     is mechanical" with a second implementation of the filter.
 *   - **The repository's rule files are never written to.** The counterfactuals mutate a
 *     THROWAWAY COPY (in a temp directory), never the file the guard verifies — a guard that
 *     edits its own subject can go green by editing it back.
 *   - **Both paths of the IO boundary.** A well-formed delegate-rule JSON must stay green
 *     (otherwise the script is an "always red" that detects nothing), and malformed input must
 *     go red with a message — a crash is not a detection.
 *
 * Expected-value sources (docs/testing-constraints.md #4): the rule files themselves (quoted
 * verbatim below), the marker grammar in `tests/review-layer-ownership.test.ts`, and the
 * `docs/agents/review-layers.md` definition of what each marker kind means.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "build-review-checklist.mjs");
const RULES_DIR = join(REPO_ROOT, ".opencodereview", "rules");

/**
 * The rule files, discovered from the directory rather than from a hand-written list: a rule
 * file nobody listed here would never be checked, and that is exactly the drift this guard is
 * for (the same reason `tests/review-layer-ownership.test.ts` discovers them).
 */
const RULE_FILES: readonly string[] = readdirSync(RULES_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => join(RULES_DIR, name));

/** Run the real script. A non-zero exit is a result, not a crash — so spawn, never exec. */
function runScript(
  args: readonly string[],
  stdin?: string,
): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    input: stdin ?? "",
  });
  return { code: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * Write a fixture into a throwaway directory, run the script over it, and clean up.
 *
 * The fixture never lands in the repository: the file the guard verifies (the rule files) is
 * only ever read.
 */
function runOverFixture(
  name: string,
  content: string,
): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "ptc-review-checklist-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, content);
    return runScript([path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The delegate-rule JSON shape `ocr delegate rule --format json` produces. */
function delegateJson(groups: readonly { pattern: string; rule: string }[]): string {
  return JSON.stringify({
    schema_version: "1",
    groups: groups.map((group, index) => ({
      group_id: index + 1,
      source: "project",
      pattern: group.pattern,
      files: [group.pattern],
      rule: group.rule,
    })),
  });
}

/** The rule files' own text, keyed by file name. */
function ruleTexts(): Map<string, string> {
  return new Map(RULE_FILES.map((path) => [path, readFileSync(path, "utf8")]));
}

/**
 * A `## ` section of a markdown document, heading included, up to the next `## ` heading.
 * Null when the document has no such section.
 */
function sectionOf(text: string, headingPrefix: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) return null;
  const rest = lines.slice(start);
  const end = rest.findIndex((line, index) => index > 0 && line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** The filtered rule text of one group, by its pattern. */
function filteredByPattern(stdout: string): Map<string, string> {
  const parsed = JSON.parse(stdout) as { groups: { pattern: string; rule: string }[] };
  return new Map(parsed.groups.map((group) => [group.pattern, group.rule]));
}

/**
 * A synthetic rule document with the three item shapes the repository uses: a multi-line
 * numbered item, a judgement-layer item, a `###` subsection, and a table row.
 *
 * It is a literal, so the expectations below do not depend on any rule file staying as it is
 * today (the real rule files are exercised separately, from the files themselves).
 */
const SYNTHETIC_RULE = [
  "# Synthetic Rule (audit fixture)",
  "",
  "适用文件:tests/fixture.ts。",
  "",
  "## 风险",
  "",
  "合成规则的正文,用来钉住 checklist 构建步骤的三种条目形状。",
  "",
  "## 必查",
  "",
  "1. 多行编号项:第一条检查项占三行,",
  "   第二行继续,",
  "   第三行是标记所在的那一行。 [机械: tests/guard-a.test.ts]",
  "",
  "2. 判断层项:这条必须留在交给评审的清单里。 [判断层: 这条只能由人判]",
  "",
  "### 子项:一个小节",
  "",
  "小节正文,标记在小节的最后一行。 [待补守卫: 缺一条 fixture]",
  "",
  "## 表格",
  "",
  "| 问题 | 合法 | 归属 |",
  "| ---- | ---- | ---- |",
  "| 表格行? | 是 | [机械: tests/guard-b.test.ts] |",
  "",
  "## 阻塞触发",
  "",
  "- 命中任一条 → PR 阻塞。",
  "",
  "## 严重性升级(Q9-D)",
  "",
  "升级。合成规则。",
  "",
].join("\n");

describe("the checklist-building step over the repository's own rule files", () => {
  const texts = ruleTexts();
  const delegate = delegateJson(
    RULE_FILES.map((path) => ({ pattern: path, rule: texts.get(path) ?? "" })),
  );
  const run = runOverFixture("delegate.json", delegate);
  const filtered = run.code === 0 ? filteredByPattern(run.stdout) : new Map<string, string>();

  test("every rule file parses: each ownership marker really is at an item's end", () => {
    // The script verifies the invariant the ownership fixture pins for the repository's rule
    // files, because it also runs on whatever `ocr delegate rule` hands it. A marker that is
    // not at an item's end must fail loudly, not be mis-parsed. Expected value source: the
    // marker grammar in tests/review-layer-ownership.test.ts (`markerIsAppended`).
    expect(RULE_FILES.length, "no rule file was found; the guard would be vacuous").toBeGreaterThan(
      0,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr, "the script reported a parse failure").not.toContain(
      "could not be parsed safely",
    );
  });

  test("a mechanically-owned check item is absent from the checklist the reviewer gets", () => {
    // Expected value source: the rule files' own markers. A `[机械: …]` or `[待补守卫: …]`
    // marker means the item belongs to the mechanical layer, so it must not be in the list the
    // judgement layer reads — that is the whole point of the marker.
    const survivors: string[] = [];
    for (const [path, text] of filtered) {
      const lines = text.split("\n");
      for (const line of lines) {
        if (/\[(机械|待补守卫)(:[^\]]*)?\]/.test(line)) {
          survivors.push(path + ": " + line.trim());
        }
      }
    }

    expect(survivors, "a mechanically-owned check item survived into the checklist").toEqual([]);
  });

  test("the handover list names every removed item and the guard that owns it", () => {
    // Expected value source: the guard paths the rule files themselves declare. The handover is
    // what keeps the removal from being a silent drop, so every guard the rules name must be
    // named there. (The `待补守卫` items have no guard by definition — they are the gaps.)
    const guards: string[] = [];
    for (const [path, text] of texts) {
      for (const match of text.matchAll(/\[机械: ([^\]]*)\]/g)) {
        for (const guard of (match[1] ?? "").split(",")) {
          const trimmed = guard.trim();
          if (trimmed !== "") guards.push(`${path} ${trimmed}`);
        }
      }
    }

    expect(guards.length, "no 机械 marker was found; the guard would be vacuous").toBeGreaterThan(
      0,
    );
    const unnamed = guards.filter((entry) => !run.stderr.includes(entry.split(" ").at(-1) ?? ""));
    expect(unnamed, "a guard the rule files name is missing from the handover").toEqual([]);
  });

  test("a judgement-layer check item is still in the checklist", () => {
    // Expected value source: the rule files' own text, quoted verbatim.
    // `ptc-protocol-pair-correctness.md`'s item 4 and `doc-sync.md`'s item 3 are both
    // `[判断层: …]`, so they must survive the filter.
    expect(filtered.get(join(RULES_DIR, "ptc-protocol-pair-correctness.md"))).toContain(
      "describeValue 共享",
    );
    expect(filtered.get(join(RULES_DIR, "doc-sync.md"))).toContain("代码改动是否需要 ADR");
  });

  test("general.md survives the transform unharmed", () => {
    // `general.md` carries ONE file-level marker and no per-item markers: it declares the
    // ownership of the whole file. A transform that treated that marker as a per-item one
    // would either strip the catch-all's baseline or fail the parse — so the file must come
    // through byte for byte.
    // Expected value source: the rule file's own bytes.
    const path = join(RULES_DIR, "general.md");
    expect(filtered.get(path), "general.md did not survive the filter").toBe(texts.get(path) ?? "");
  });

  test("the rest of the rule text survives verbatim", () => {
    // The filter removes whole items, not the document around them. Every `## 严重性升级` section
    // (8 of the 9 rule files have one; `general.md` has none, which is the documented
    // convention) must come through byte-for-byte, and so must the sections around the removed
    // items of the two files the shape test uses.
    const damaged: string[] = [];
    for (const [path, text] of texts) {
      const escalation = sectionOf(text, "## 严重性升级");
      const filteredText = filtered.get(path) ?? "";
      if (escalation !== null && !filteredText.includes(escalation)) {
        damaged.push(path + " 严重性升级");
      }
    }
    const renderBounds = filtered.get(join(RULES_DIR, "ptc-render-bounds.md")) ?? "";
    const renderText = texts.get(join(RULES_DIR, "ptc-render-bounds.md")) ?? "";
    for (const heading of ["## 硬约束", "## 阻塞触发"]) {
      const section = sectionOf(renderText, heading);
      if (section !== null && !renderBounds.includes(section)) {
        damaged.push("ptc-render-bounds.md " + heading);
      }
    }

    expect(damaged, "sections that did not survive the filter verbatim").toEqual([]);
  });
});

describe("the checklist-building step's counterfactuals", () => {
  test("removing the marker puts the item back — on a throwaway copy, never on the rule file", () => {
    // The counterfactual: if the marker is what removes the item, then an item whose marker was
    // removed comes back. The mutation is applied to a COPY of the real rule file in a temp
    // directory; the repository's file is only read.
    // Expected value source: `ptc-render-bounds.md`'s item 1, quoted verbatim.
    const original = readFileSync(join(RULES_DIR, "ptc-render-bounds.md"), "utf8");
    const ITEM = "cap 常量集中";
    const MARKER = " [机械: tests/render-bounds-registry.test.ts]";

    const withMarker = runOverFixture(
      "marked.json",
      delegateJson([{ pattern: "ptc-render-bounds.md", rule: original }]),
    );
    const withoutMarker = runOverFixture(
      "unmarked.json",
      delegateJson([
        {
          pattern: "ptc-render-bounds.md",
          rule: original.replace(MARKER, ""),
        },
      ]),
    );

    expect(withMarker.code, withMarker.stderr).toBe(0);
    expect(withoutMarker.code, withoutMarker.stderr).toBe(0);
    expect(filteredByPattern(withMarker.stdout).get("ptc-render-bounds.md")).not.toContain(ITEM);
    expect(filteredByPattern(withoutMarker.stdout).get("ptc-render-bounds.md")).toContain(ITEM);
  });

  test("a marker that is not at an item's end is reported, not silently mis-parsed", () => {
    // The invariant the script relies on: the marker sits at the END of the item's last line.
    // When it does not, the script must fail loudly — a mis-parsed item would put a mechanical
    // check item back into the checklist, silently.
    // Expected value source: the marker grammar in tests/review-layer-ownership.test.ts.
    const misplaced = SYNTHETIC_RULE.replace(
      "   第三行是标记所在的那一行。 [机械: tests/guard-a.test.ts]",
      "1. 多行编号项:[机械: tests/guard-a.test.ts] 第一条检查项占三行,",
    );
    const run = runOverFixture(
      "misplaced.json",
      delegateJson([{ pattern: "s.md", rule: misplaced }]),
    );

    expect(run.code, "a marker off an item's end must fail loudly").not.toBe(0);
    expect(run.stdout, "nothing must be written to stdout when the parse fails").toBe("");
    expect(run.stderr).toContain("not at the end of any check item");
  });

  test("a marker in the middle of an item's last line is reported", () => {
    // The other half of the invariant: the marker must END the line, not merely sit on it.
    const middle = SYNTHETIC_RULE.replace(
      "   第三行是标记所在的那一行。 [机械: tests/guard-a.test.ts]",
      "   第三行是标记所在的那一行。[机械: tests/guard-a.test.ts] 还有别的字。",
    );
    const run = runOverFixture("middle.json", delegateJson([{ pattern: "s.md", rule: middle }]));

    expect(run.code, "a marker that does not end the line must fail loudly").not.toBe(0);
    expect(run.stderr).toContain("not at the end of the check item");
  });

  test("the three item shapes are all removed whole, and the handover names them", () => {
    // Expected value source: the synthetic fixture's own text, quoted verbatim.
    const run = runOverFixture(
      "synthetic.json",
      delegateJson([{ pattern: "s.md", rule: SYNTHETIC_RULE }]),
    );

    expect(run.code, run.stderr).toBe(0);
    const checklist = filteredByPattern(run.stdout).get("s.md") ?? "";

    // The multi-line numbered item: gone, whole.
    expect(checklist).not.toContain("多行编号项");
    // The `###` subsection: gone, heading and body.
    expect(checklist).not.toContain("### 子项");
    expect(checklist).not.toContain("小节正文");
    // The table row: gone.
    expect(checklist).not.toContain("表格行?");
    // The judgement-layer item: still there.
    expect(checklist).toContain("判断层项");
    // The document around the items: intact.
    expect(checklist).toContain("## 风险");
    expect(checklist).toContain("## 阻塞触发");
    expect(checklist).toContain("命中任一条 → PR 阻塞。");
    expect(checklist).toContain("升级。合成规则。");
    // The table's header survives even though its only data row was removed.
    expect(checklist).toContain("| 问题 | 合法 | 归属 |");

    // The handover names each removed item and the guard that owns it.
    expect(run.stderr).toContain("tests/guard-a.test.ts");
    expect(run.stderr).toContain("tests/guard-b.test.ts");
    expect(run.stderr).toContain("多行编号项");
    expect(run.stderr).toContain("表格行?");
    // The `待补守卫` item is a gap, and the handover says so rather than naming a guard.
    expect(run.stderr).toContain("NO GUARD");
    expect(run.stderr).toContain("缺一条 fixture");
  });

  test("the script reads its input from stdin", () => {
    // The other documented input path. A crash is not a detection: the exit code is checked
    // together with the output.
    const run = runScript([], delegateJson([{ pattern: "s.md", rule: SYNTHETIC_RULE }]));

    expect(run.code, run.stderr).toBe(0);
    expect(filteredByPattern(run.stdout).get("s.md")).toContain("判断层项");
  });

  test("malformed input is an explicit failure, not an empty checklist", () => {
    // IO boundary, failure path. An empty checklist would read as "nothing to review" instead
    // of "the input broke" — the failure would be invisible.
    const notJson = runOverFixture("bad.json", "{ not json");
    const noGroups = runOverFixture("no-groups.json", JSON.stringify({ schema_version: "1" }));
    const missingFile = runScript([join(tmpdir(), "ptc-review-checklist-does-not-exist.json")]);

    expect(notJson.code).not.toBe(0);
    expect(notJson.stderr).toContain("not valid JSON");
    expect(noGroups.code).not.toBe(0);
    expect(noGroups.stderr).toContain("groups");
    expect(missingFile.code).not.toBe(0);
    expect(missingFile.stderr).toContain("cannot read");
  });
});
