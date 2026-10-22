/**
 * Ownership-marker guard for the three review layers (issue #254, part ①).
 *
 * The failure mode this exists for: a rule file under `.opencodereview/rules/` whose check
 * items do not say WHICH layer owns them. Without that declaration the judgement layer
 * re-reports what the mechanical layer already forces red (F1–F4 are enforced by
 * `tests/test-meta-discipline.test.ts`, yet the judgement checklist still lists them as
 * blocking findings), and "mechanically owned" vs "judgement owned" stays a matter of
 * discipline rather than a fact something can read.
 *
 * The declaration is the marker appended to every check item:
 *
 *   [机械: tests/<guard>.test.ts]   — owned by the mechanical layer; `<guard>` is the
 *                                    test file that guards it. The judgement layer does
 *                                    not report it.
 *   [待补守卫: <reason>]            — would be mechanical, but no guard exists yet. A gap
 *                                    in the mechanical layer, not the judgement layer's job.
 *   [判断层: <reason>]              — owned by the judgement layer; the reason says why it
 *                                    is not mechanizable.
 *
 * Expected-value sources (docs/testing-constraints.md #4) — never "re-implement the
 * implementation":
 *   - the set of rule files comes from the directory itself (`readdirSync`), compared
 *     against the declared table, so a rule file with no declared shape fails;
 *   - the number of check items per file is a pinned baseline recorded in that table;
 *   - a `机械` marker is judged by `existsSync` on the repo-relative path it names;
 *   - the marker grammar is the three forms above, and the counterfactuals at the bottom
 *     pin what each malformed form must report.
 *
 * The counterfactuals run on SYNTHETIC snippets. This file never mutates a rule file to
 * make a test red.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RULES_DIR = join(REPO_ROOT, ".opencodereview/rules");

/**
 * The three legal ownership markers. The body of a marker is everything up to the closing
 * bracket, so a reason may not contain `]` — the rules below keep to that.
 */
const MARKER_PATTERN = /\[(机械|待补守卫|判断层)(:[^\]]*)?\]/g;

type MarkerKind = "机械" | "待补守卫" | "判断层";

/** How a rule file carries its checklist. The shape differs per file; see RULE_FILES. */
type Shape = "numbered" | "table" | "heading" | "file";

interface RuleFileSpec {
  /** Repo-relative path of the rule file. */
  readonly path: string;
  /** The heading that carries the checklist. Empty for the file-level shape. */
  readonly anchor: string;
  readonly shape: Shape;
  /** Pinned number of check items the anchor holds today. */
  readonly itemCount: number;
}

/**
 * Every rule file, with the anchor that actually carries its checklist. The anchor is not
 * `## 必查` everywhere: `test-discipline-oracle.md` has no `## 必查` section at all (its
 * checklist is `## 收紧项`), `test-discipline.md`'s is a table, and `general.md` is the
 * judgement catch-all, which carries ONE file-level marker instead of per-item ones.
 */
const RULE_FILES: readonly RuleFileSpec[] = [
  {
    path: ".opencodereview/rules/ptc-protocol-pair-correctness.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 4,
  },
  {
    path: ".opencodereview/rules/ptc-worker-lifecycle.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 5,
  },
  {
    path: ".opencodereview/rules/ptc-render-bounds.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 5,
  },
  {
    path: ".opencodereview/rules/ptc-bgdispatch-contract.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 11,
  },
  {
    path: ".opencodereview/rules/ptc-config-wiring.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 7,
  },
  {
    path: ".opencodereview/rules/doc-sync.md",
    anchor: "## 必查",
    shape: "numbered",
    itemCount: 9,
  },
  {
    path: ".opencodereview/rules/test-discipline.md",
    anchor: "## 必查",
    shape: "table",
    itemCount: 4,
  },
  {
    path: ".opencodereview/rules/test-discipline-oracle.md",
    anchor: "## 收紧项",
    shape: "heading",
    itemCount: 4,
  },
  {
    path: ".opencodereview/rules/general.md",
    anchor: "",
    shape: "file",
    itemCount: 1,
  },
];

interface Item {
  /** 1-based line number of the item's first line, for the failure message. */
  readonly line: number;
  readonly text: string;
}

interface Marker {
  readonly kind: MarkerKind;
  /** The text after the colon, trimmed. Empty means "no reason / no guard path". */
  readonly body: string;
}

/**
 * Read a rule file. A missing or unreadable rule file is an explicit failure — never an
 * empty rule set that would make every assertion below vacuously pass.
 */
function readRuleFile(relativePath: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  } catch (cause) {
    throw new Error("cannot read " + relativePath + ": " + String(cause));
  }
  return raw;
}

interface Section {
  readonly text: string;
  /** 1-based line number of the section's first line, so item lines are file-absolute. */
  readonly startLine: number;
}

/** The body of the section a heading opens, up to the next heading of the same or higher level. */
function sectionOf(text: string, anchor: string): Section {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start === -1) {
    throw new Error("anchor section not found: " + anchor);
  }
  const level = /^(#+)/.exec(anchor)?.[1]?.length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#+)\s/.exec(lines[i] ?? "");
    const headingLevel = heading?.[1]?.length ?? 0;
    if (heading !== null && headingLevel <= level) {
      end = i;
      break;
    }
  }
  return { text: lines.slice(start + 1, end).join("\n"), startLine: start + 2 };
}

/**
 * A markdown table's separator row: every cell is dashes (optionally colon-delimited).
 */
function isSeparatorRow(row: string): boolean {
  const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

/** A numbered list item (`1. …`) or a top-level bullet (`- …`) and the lines that follow it. */
function numberedItems(section: string): Item[] {
  const lines = section.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\d+\.\s/.test(line) || /^-\s/.test(line)) starts.push(i);
  }
  return itemsFromStarts(lines, starts);
}

/** A `###` subsection and the lines that follow it, up to the next subsection. */
function headingItems(section: string): Item[] {
  const lines = section.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s/.test(lines[i] ?? "")) starts.push(i);
  }
  return itemsFromStarts(lines, starts);
}

/** The data rows of a markdown table (header row and separator row excluded). */
function tableItems(section: string): Item[] {
  const lines = section.split("\n");
  const rowIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim().startsWith("|")) rowIndexes.push(i);
  }
  const separatorAt = rowIndexes.find((index) => isSeparatorRow(lines[index] ?? ""));
  if (separatorAt === undefined) {
    throw new Error("no table separator row found in the checklist section");
  }
  const items: Item[] = [];
  for (const index of rowIndexes) {
    if (index <= separatorAt) continue;
    items.push({ line: index + 1, text: lines[index] ?? "" });
  }
  return items;
}

function itemsFromStarts(lines: readonly string[], starts: readonly number[]): Item[] {
  const items: Item[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k] as number;
    const to = k + 1 < starts.length ? (starts[k + 1] as number) : lines.length;
    items.push({ line: from + 1, text: lines.slice(from, to).join("\n") });
  }
  return items;
}

function extractItems(section: string, shape: Shape): Item[] {
  if (shape === "numbered") return numberedItems(section);
  if (shape === "heading") return headingItems(section);
  if (shape === "table") return tableItems(section);
  throw new Error("extractItems has no shape for: " + shape);
}

/** Every ownership marker in a piece of text, in order. */
function markersIn(text: string): Marker[] {
  const markers: Marker[] = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    markers.push({
      kind: match[1] as MarkerKind,
      body: (match[2] ?? "").replace(/^:/, "").trim(),
    });
  }
  return markers;
}

/**
 * The pure core: what is wrong with the ownership declaration of one check item.
 *
 * `exists` is injected rather than imported so the same function validates the repository's
 * own rule files and the synthetic snippets the counterfactuals use — no IO happens here.
 *
 * Expected-value source: the marker grammar in the file header (three forms, verbatim), and
 * real file existence for the `机械` form.
 */
function validateMarkers(text: string, exists: (path: string) => boolean): string[] {
  const markers = markersIn(text);
  if (markers.length === 0) {
    return ["no ownership marker"];
  }
  if (markers.length > 1) {
    return [markers.length + " ownership markers on one check item"];
  }
  const marker = markers[0] as Marker;
  if (marker.kind === "机械") {
    if (marker.body === "") {
      return ["机械 marker names no guard file"];
    }
    if (!exists(marker.body)) {
      return ["机械 marker names a guard file that does not exist: " + marker.body];
    }
    return [];
  }
  if (marker.body === "") {
    return [marker.kind + " marker carries no reason"];
  }
  return [];
}

/**
 * The marker must be APPENDED to the item, not woven into its prose: for a list item or a
 * `###` section it ends the last line, for a table row it ends the last cell. This is what
 * makes the diff "a marker was added" rather than "the check item was rewritten".
 */
function markerIsAppended(item: Item, shape: Shape): boolean {
  if (shape === "table") {
    const cells = item.text.trim().replace(/\|$/, "").split("|");
    const lastCell = cells[cells.length - 1] ?? "";
    return lastCell.trim().endsWith("]");
  }
  const lines = item.text.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return lastLine.trim().endsWith("]");
}

/** The repo-relative path exists on disk. */
function repoFileExists(relativePath: string): boolean {
  return existsSync(join(REPO_ROOT, relativePath));
}

/** Every check item of every rule file that carries a per-item checklist. */
function allCheckItems(): { spec: RuleFileSpec; item: Item }[] {
  const collected: { spec: RuleFileSpec; item: Item }[] = [];
  for (const spec of RULE_FILES) {
    if (spec.shape === "file") continue;
    for (const item of checkItemsOf(spec)) {
      collected.push({ spec, item });
    }
  }
  return collected;
}

/** The check items of one rule file, with file-absolute line numbers. */
function checkItemsOf(spec: RuleFileSpec): Item[] {
  const section = sectionOf(readRuleFile(spec.path), spec.anchor);
  return extractItems(section.text, spec.shape).map((item) => ({
    line: item.line + section.startLine - 1,
    text: item.text,
  }));
}

/** Every ownership marker in every check item, with where it was found. */
function allMarkers(): { spec: RuleFileSpec; item: Item; marker: Marker }[] {
  const found: { spec: RuleFileSpec; item: Item; marker: Marker }[] = [];
  for (const { spec, item } of allCheckItems()) {
    for (const marker of markersIn(item.text)) {
      found.push({ spec, item, marker });
    }
  }
  return found;
}

describe("review-layer ownership markers", () => {
  test("every rule file under .opencodereview/rules has a declared checklist shape", () => {
    // Expected-value source: the rules directory itself. A rule file that is not in the
    // declared table would never be checked for markers — the failure this guard exists for.
    const discovered = readdirSync(RULES_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ".opencodereview/rules/" + name)
      .sort();
    const declared = RULE_FILES.map((spec) => spec.path).sort();

    expect(discovered.length, "no rule file was found; the guard would be vacuous").toBeGreaterThan(
      0,
    );
    expect(discovered, "a rule file with no declared checklist shape").toEqual(declared);
  });

  test("every check item carries exactly one legal ownership marker", () => {
    const problems: string[] = [];
    for (const spec of RULE_FILES) {
      if (spec.shape === "file") continue;
      const items = checkItemsOf(spec);
      if (items.length !== spec.itemCount) {
        problems.push(
          spec.path + ": expected " + spec.itemCount + " check items, found " + items.length,
        );
      }
      for (const item of items) {
        for (const problem of validateMarkers(item.text, repoFileExists)) {
          problems.push(spec.path + ":" + item.line + " " + problem);
        }
        if (!markerIsAppended(item, spec.shape)) {
          problems.push(
            spec.path + ":" + item.line + " the ownership marker is not appended to the item",
          );
        }
      }
    }

    expect(problems, "ownership declarations that are missing or malformed").toEqual([]);
  });

  test("every 机械 marker names a guard file that exists in the repo", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const { spec, item, marker } of allMarkers()) {
      if (marker.kind !== "机械") continue;
      seen += 1;
      if (!repoFileExists(marker.body)) {
        problems.push(spec.path + ":" + item.line + " guard file missing: " + marker.body);
      }
    }

    // Non-vacuity: the 机械 form is in use today. A count of zero would mean the
    // declaration has drifted to a single form, which is the drift this guard is for.
    expect(seen, "no 机械 marker is exercised; the guard would be vacuous").toBeGreaterThan(0);
    expect(problems, "机械 markers pointing at a file that does not exist").toEqual([]);
  });

  test("every 待补守卫 marker names the guard that is missing", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const { spec, item, marker } of allMarkers()) {
      if (marker.kind !== "待补守卫") continue;
      seen += 1;
      if (marker.body === "") {
        problems.push(spec.path + ":" + item.line + " 待补守卫 marker with no reason");
      }
    }

    expect(seen, "no 待补守卫 marker is exercised; the guard would be vacuous").toBeGreaterThan(0);
    expect(problems, "待补守卫 markers with no reason").toEqual([]);
  });

  test("every 判断层 marker carries a reason", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const { spec, item, marker } of allMarkers()) {
      if (marker.kind !== "判断层") continue;
      seen += 1;
      if (marker.body === "") {
        problems.push(spec.path + ":" + item.line + " 判断层 marker with no reason");
      }
    }

    expect(seen, "no 判断层 marker is exercised; the guard would be vacuous").toBeGreaterThan(0);
    expect(problems, "判断层 markers with no reason").toEqual([]);
  });

  test("general.md carries one file-level marker and no per-item markers", () => {
    // Expected-value source: the rule file's own text. general.md is the judgement
    // catch-all: its 12 Fowler smells and its A–F dimensions are judgement calls, so it
    // declares ONE file-level owner instead of a marker per item.
    const text = readRuleFile(".opencodereview/rules/general.md");
    const markers = markersIn(text);

    expect(markers.length, "general.md must carry exactly one file-level marker").toBe(1);
    expect((markers[0] as Marker).kind).toBe("判断层");
    expect((markers[0] as Marker).body).not.toBe("");

    // The 12 Fowler smells and the A–F dimensions stay marker-free; the file-level marker
    // is the only ownership declaration in the file.
    const smells = numberedItems(sectionOf(text, "## 设计基线:12 条 Fowler smell").text);
    const dimensions = headingItems(sectionOf(text, "## 触发式维度 checklist").text);
    expect(smells.length, "the Fowler baseline should still hold 12 items").toBe(12);
    expect(dimensions.length, "the trigger dimensions should still hold 6 items").toBe(6);
    for (const item of [...smells, ...dimensions]) {
      expect(markersIn(item.text).length, "a per-item marker crept into general.md").toBe(0);
    }
  });
});

describe("the ownership-marker validator's counterfactuals", () => {
  // These run on synthetic snippets. The repository's own rule files are never mutated to
  // make a test red — a guard that edits its own subject can go green by editing it back.

  const nothingExists = (): boolean => false;

  test("a 机械 marker pointing at a file that does not exist is reported", () => {
    const problems = validateMarkers(
      "1. 出口统一:所有出口都是常量。 [机械: tests/does-not-exist.test.ts]",
      nothingExists,
    );

    expect(problems).toContain(
      "机械 marker names a guard file that does not exist: tests/does-not-exist.test.ts",
    );
  });

  test("a 判断层 marker with no reason is reported", () => {
    const problems = validateMarkers("1. 这是判断层的事。 [判断层]", nothingExists);

    expect(problems).toContain("判断层 marker carries no reason");
  });

  test("a 待补守卫 marker with no reason is reported", () => {
    const problems = validateMarkers("1. 可脚本化但缺守卫。 [待补守卫:]", nothingExists);

    expect(problems).toContain("待补守卫 marker carries no reason");
  });

  test("an item with no ownership marker is reported", () => {
    const problems = validateMarkers("1. 出口统一:所有出口都是常量。", nothingExists);

    expect(problems).toContain("no ownership marker");
  });

  test("an item with two ownership markers is reported", () => {
    const problems = validateMarkers(
      "1. 出口统一。 [机械: tests/x.test.ts] [判断层: 人判]",
      nothingExists,
    );

    expect(problems).toContain("2 ownership markers on one check item");
  });

  test("a well-formed marker with an existing guard produces no problem", () => {
    const problems = validateMarkers(
      "1. 出口统一。 [机械: tests/review-layer-ownership.test.ts]",
      (path) => path === "tests/review-layer-ownership.test.ts",
    );

    expect(problems).toEqual([]);
  });
});
