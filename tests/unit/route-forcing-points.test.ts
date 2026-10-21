/**
 * The eight MECHANICAL forcing points (ticket #247; spec #234, implementation
 * decision 10).
 *
 * ## What this file is
 *
 * The route registry and the resident index are two pieces of machinery that
 * were built by two tickets (#243 and #246) and guarded by two files. This
 * file is the third thing: ONE suite that reads as the eight rules, so a
 * reader can see which rule each test pins without reading two files and
 * reconciling them.
 *
 * The eight rules, and where each is pinned:
 *
 * | #   | rule                                                        | pinned by                                     |
 * | --- | ----------------------------------------------------------- | --------------------------------------------- |
 * | 1   | tool → road: every model-visible tool/binding is on a road  | "every tool the model can see is on a road"   |
 * | 2   | road → tool: every name a road names really exists          | "no road names a tool that does not exist"    |
 * | 3   | every road answers on EVERY surface                          | "no road leaves a surface unanswered"         |
 * | 4   | the index has a token budget, and says so when it is over   | "the index stays inside its budget"           |
 * | 5   | every road carries a fact                                    | "no road is only a when"                      |
 * | 6   | a tool's prose is the registry's CALL, never a copy          | "the prose is the registry's, not a copy"      |
 * | 7   | one line per road, and the pointer resolves IN THE PACKAGE   | "the pointer resolves in the package"         |
 * | 8   | the index is byte-identical from turn to turn                | "the index is the same bytes every turn"      |
 *
 * ## The ninth rule is NOT here, on purpose
 *
 * Decision 10's rule 9 — "a parameter's schema stays with its description, in
 * the tool file" — is a **convention**, not a mechanical rule. ADR-0059
 * decision 4 records it, and code review keeps it. There is no shape of it a
 * test could check: "the schema's description is next to the schema" is a
 * statement about how a human reads a file, and every mechanical version of it
 * is either vacuous (the schema is in the tool file — so what?) or a proxy for
 * a decision a human has to make. Writing a test for it would be a false
 * promise of coverage that the test cannot deliver.
 *
 * ## Where the expectations come from
 *
 * Every expected value in this file points at something other than the code
 * under test:
 *
 * - **The road set's expected coverage is a LITERAL** (`MODEL_VISIBLE_TOOLS`,
 *   `MODEL_VISIBLE_BINDINGS`), not the registry's own `TOOLS` zone. An oracle
 *   that moves with the implementation cannot say that the implementation
 *   missed something — so the registry is checked AGAINST the literal, and the
 *   literal is the spec's claim written out.
 * - **The budget's bounds are LITERALS** (560 and 380), because ADR-0061
 *   states them; editing the constant to 5000 must not keep the suite green.
 * - **The token ruler is REPRODUCED, not imported** (`tokens()` below), so the
 *   budget assertion does not depend on the module under test agreeing with
 *   itself about how to count.
 * - **The index's shape comes from ADR-0061's own example line**, and the
 *   package's shipped set comes from `package.json`'s `files` field — a
 *   different place from the registry.
 *
 * ## The counterfactual, rule by rule
 *
 * Each test names the mutation that turns it red. Every one of them was run:
 * see the report on the ticket.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";
import { describe, expect, test } from "vitest";
import {
  AGENT_OPTIONAL_CLAUSE,
  CHILD_REPORT_DESCRIPTION,
  IMAGE_HOISTING_NOTE,
  PROGRAM_BODY_DESCRIPTION,
  PTC_CHILD_SEARCH_NOTE,
  PTC_TASK_TOOL_GUIDELINES,
  PTC_TOOL_GUIDELINES,
  PTC_TRUNCATED_NO_NEW_TASK,
  PTC_TRUNCATED_SECTION_LINE,
  PTC_TRUNCATION_SECTION_LINES,
  renderDescription,
  renderRouteIndex,
  ROUTES,
  ROUTE_INDEX_HEADER,
  ROUTE_INDEX_OVER_BUDGET_WARNING,
  ROUTE_INDEX_TOKEN_CEILING,
  ROUTE_INDEX_TOKEN_FLOOR,
  TASK_DOOR_RESULT_NOTE,
  TASK_STOP_SEMANTICS,
  TOOLS,
  WHY_SUPPRESSED_DESCRIPTION,
  type RouteEntry,
  type ToolEntry,
  type ToolName,
} from "../../src/routes/registry.ts";
import { buildTools, ownParagraphs, sentencesOf, type ToolProse } from "../helpers/route-prose.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** The two surfaces, spelled out — the surface decides the road's `how`. */
const SURFACES = ["full_ptc", "codemode_ptc"] as const;

/**
 * The model-visible tools, as a LITERAL.
 *
 * **Why a literal and not `Object.keys(TOOLS)`.** Rule 1 is a COVERAGE claim:
 * every tool the package shows the model is named by a road. If the expected
 * set were the registry's own `TOOLS` zone, the claim would be "the roads
 * cover the registry" — and a tool added to the package but forgotten in BOTH
 * zones would leave the suite green. This list is the spec's claim (decision 10,
 * rule 1) written out, so the registry is checked against something that does
 * not move when the registry does.
 *
 * The eight: the two PTC program tools, the codemode door, the three task
 * tools, the child's report tool, and the search tool that lives in the child.
 */
const MODEL_VISIBLE_TOOLS: readonly ToolName[] = [
  "ptc_run_code",
  "ptc_workflow",
  "pi_task_codemode",
  "ptc_task_list",
  "ptc_task_output",
  "ptc_task_stop",
  "ptc_child_report",
  "web_ds_search",
];

/**
 * The bindings the model reaches inside a program.
 *
 * `pi_task_ptc` is a BINDING, not a declared tool: the model only ever sees it
 * inside a program, so it has no description, no snippet and no guidelines of
 * its own — and therefore no `TOOLS` entry. But the model calls it, so it is
 * model-visible, and decision 10's rule 1 says "工具/绑定" — tool OR binding.
 * A road that names it names a real way of doing something.
 */
const MODEL_VISIBLE_BINDINGS: readonly string[] = ["pi_task_ptc"];

/**
 * pi's own estimator for the upstream declaration renderer, reproduced here
 * rather than imported, so the budget assertion does not depend on the module
 * under test agreeing with itself about how to count. The same rule the
 * binding contract's budget uses (ADR-0024 §5).
 */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The index's lines, minus the header and the blank line under it. */
function roadLines(index: string): string[] {
  return index.split("\n").filter((line) => line.startsWith("- "));
}

/**
 * A route set that is deliberately over the ceiling: one road whose text is far
 * longer than any real road's.
 *
 * **The expected value is the ceiling itself**, not the length of this fixture
 * — the fixture only has to be over it, and the assertion says which side of
 * the line it is on.
 */
const OVER_BUDGET_ROUTES: readonly RouteEntry[] = [
  ...ROUTES,
  {
    id: "an-absurdly-long-road",
    name: "An absurdly long road",
    when: "x".repeat(4_000),
    how: { full_ptc: "y".repeat(4_000), codemode_ptc: "y".repeat(4_000) },
    fact: "z".repeat(4_000),
    detail: "docs/routes/an-absurdly-long-road.md",
    tools: [],
  },
];

// ---------------------------------------------------------------------------
//  the rule-6 machinery: the registry's prose, and the scan that looks for it
// ---------------------------------------------------------------------------

/**
 * The registry's PROSE — every sentence the model can read that the registry
 * owns.
 *
 * **What is in it:** every tool description paragraph, every sentence inside
 * those paragraphs, every snippet, every guideline, every shared constant, the
 * index's header and its over-budget warning, and every road's `when`, `how`
 * and `fact` (plus the sentences inside them).
 *
 * **What is deliberately NOT in it:** a road's NAME and its DETAIL PATH. A name
 * is a label rather than a sentence — and one of them, "Create a task", is also
 * the wording of the runtime's validator stub (`DISPATCH_TOOL_LIKE` in
 * `src/runtime/bindings.ts`), which pi never shows to any model: it exists so
 * `validateToolArguments` has a `Tool` to check the arguments against. A path
 * is not prose either, and the pointer's own rule (7) checks it.
 */
function registryProse(): string[] {
  const prose: string[] = [];
  const add = (text: string): void => {
    if (text.trim().length > 0) prose.push(text.trim());
  };
  for (const entry of Object.values(TOOLS)) {
    for (const paragraph of ownParagraphs(entry)) {
      add(paragraph);
      for (const sentence of sentencesOf(paragraph)) add(sentence);
    }
    add(entry.snippet);
    for (const guideline of entry.guidelines) {
      add(guideline);
      for (const sentence of sentencesOf(guideline)) add(sentence);
    }
  }
  for (const road of ROUTES) {
    add(road.when);
    add(road.fact);
    for (const how of Object.values(road.how)) {
      add(how);
      for (const sentence of sentencesOf(how)) add(sentence);
    }
    for (const sentence of sentencesOf(road.fact)) add(sentence);
  }
  for (const shared of [
    AGENT_OPTIONAL_CLAUSE,
    PROGRAM_BODY_DESCRIPTION,
    WHY_SUPPRESSED_DESCRIPTION,
    IMAGE_HOISTING_NOTE,
    PTC_CHILD_SEARCH_NOTE,
    TASK_DOOR_RESULT_NOTE,
    TASK_STOP_SEMANTICS,
    CHILD_REPORT_DESCRIPTION,
    PTC_TRUNCATED_NO_NEW_TASK,
    PTC_TRUNCATED_SECTION_LINE,
    ROUTE_INDEX_HEADER,
    ROUTE_INDEX_OVER_BUDGET_WARNING,
    ...PTC_TOOL_GUIDELINES,
    ...PTC_TASK_TOOL_GUIDELINES,
    ...Object.values(PTC_TRUNCATION_SECTION_LINES),
  ]) {
    add(shared);
  }
  return [...new Set(prose)];
}

/**
 * Remove the COMMENTS from a source file, leaving the code and its string
 * literals alone.
 *
 * **Why comments are removed.** A comment that QUOTES a shared constant to
 * explain why it is there is not a second copy of the prose — the model never
 * reads a comment. Two files in this repository do exactly that (they quote
 * the web route's action to explain the truncation notice), and a scan that
 * counted them would be crying wolf. What the rule forbids is a LITERAL: a
 * string in code that says the same thing, in a place that can reach the
 * model.
 *
 * The scanner tracks string and template literals so that a `//` inside one
 * (`"https://example.com"`) is not mistaken for the start of a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The text a scan looks in: comments gone, the `+` that joins two string
 * literals gone (so a sentence split across two literals is still one
 * sentence), and the whitespace collapsed.
 */
function scannable(source: string): string {
  return stripComments(source)
    .replace(/["'`]\s*\+\s*["'`]/g, "")
    .replace(/\s+/g, " ");
}

/** Every TypeScript source file under `src/`, except the registry itself. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(REPO_ROOT, "src"));
  return out.filter((file) => !file.endsWith(join("src", "routes", "registry.ts")));
}

/** The words of a text, lowercased — the unit the rule-8 vocabulary check uses. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/**
 * Every word the registry's STATIC zone uses — the prose above, plus the two
 * things the index legitimately carries that are not prose: a road's name and
 * the path its pointer names.
 *
 * Both are static (a road's name and its detail file do not change inside a
 * session), so both belong in the vocabulary rule 8 checks the index against.
 * They are excluded from the rule-6 SOURCE SCAN for a different reason: a
 * label and a path are not sentences, and one of the labels ("Create a task")
 * is also the wording of the runtime's validator stub.
 */
function registryVocabulary(): Set<string> {
  const texts = [...registryProse()];
  for (const road of ROUTES) {
    texts.push(road.name, road.detail);
  }
  return new Set(texts.flatMap(wordsOf));
}

/**
 * The one word the RENDERER owns, and the registry does not.
 *
 * ADR-0061 shows the index's line literally:
 *
 * ```
 * - Create a task — …: … Details: docs/routes/create-a-task.md.
 * ```
 *
 * so "Details" is the renderer's join between the line and the pointer. It is
 * listed here so the rule-8 vocabulary check is about the index's CONTENT and
 * not about an accident of the registry's current wording.
 */
const RENDERER_JOIN_WORDS: readonly string[] = ["details"];

/** The package's `files` field — the set npm packs, read from package.json. */
function packagedPatterns(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    files?: string[];
  };
  return pkg.files ?? [];
}

/** Is this package-relative path in the set the package ships? */
function isPackaged(path: string): boolean {
  return packagedPatterns().some((pattern) => minimatch(path, pattern, { dot: true }));
}

// ---------------------------------------------------------------------------
//  1 — tool → road
// ---------------------------------------------------------------------------

describe("forcing point 1 — every model-visible tool and binding is named by a road", () => {
  test("every tool the model can see is on a road", () => {
    // Decision 10, rule 1: "每个模型可见的工具/绑定至少被一条路提到".
    //
    // Counterfactual: add a tool to the package and to no road — the literal
    // list no longer matches the registry, and this goes red on the first
    // half. Drop `pi_task_ptc` from the create-a-task road's `tools` — the
    // binding is named by nobody and this goes red on the second half.
    const named = new Set<string>(ROUTES.flatMap((road) => road.tools));
    for (const tool of MODEL_VISIBLE_TOOLS) {
      expect(named.has(tool), `${tool} is named by a road`).toBe(true);
    }
    for (const binding of MODEL_VISIBLE_BINDINGS) {
      expect(named.has(binding), `${binding} is named by a road`).toBe(true);
    }
  });

  test("the registry declares exactly the tools the model can see", () => {
    // The oracle's own guard: the coverage set above is a literal, so the
    // registry is checked against it rather than the other way round. Without
    // this, the first test's expected set could drift away from the package
    // and the coverage claim would be about nothing.
    //
    // Counterfactual: add an entry to the registry's `TOOLS` zone — this goes
    // red until the literal list says so too, which is the moment somebody
    // decides whether the new tool has a road.
    expect(Object.keys(TOOLS).sort(), "the registry's TOOLS zone").toEqual(
      [...MODEL_VISIBLE_TOOLS].sort(),
    );
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      expect(entry.name, `${name} names itself`).toBe(name);
    }
    // The binding has no `TOOLS` entry of its own: the model only ever sees it
    // inside a program, so it has no description, no snippet and no
    // guidelines — but it IS model-visible, and rule 1 names it above.
    expect(Object.keys(TOOLS), "the binding is not a declared tool").not.toContain("pi_task_ptc");
  });
});

// ---------------------------------------------------------------------------
//  2 — road → tool
// ---------------------------------------------------------------------------

describe("forcing point 2 — every tool a road names really exists", () => {
  test("no road names a tool the package does not have", () => {
    // Decision 10, rule 2: "路里提到的每个工具名必须真实存在".
    //
    // The expected set is the literal list plus the binding — the same shape
    // the binding contract's two-way test uses, where the oracle is the
    // runtime's own binding table rather than the contract's own text.
    //
    // Counterfactual: name a tool that does not exist on a road — this goes
    // red.
    const real = new Set<string>([...MODEL_VISIBLE_TOOLS, ...MODEL_VISIBLE_BINDINGS]);
    for (const road of ROUTES) {
      for (const tool of road.tools) {
        expect(real.has(tool), `${road.id} names ${tool}, which exists`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  3 — every surface is answered
// ---------------------------------------------------------------------------

describe("forcing point 3 — every road answers on every surface", () => {
  test("no road leaves a surface unanswered", () => {
    // Decision 10, rule 3: "每条路在每个表面上都有交代（怎么走 / 明确「不适用」）".
    // "Not applicable here" IS an answer; a missing key is a hole, and a hole
    // the model cannot see is the failure this rule exists to prevent.
    //
    // **The `typeof` assertion is the load-bearing half.** A missing key reads
    // as `undefined`, and `undefined` is not the empty string — so a
    // `not.toBe("")` check alone would pass on a road that answers nothing.
    //
    // Counterfactual: delete the `codemode_ptc` key of one road's `how` — this
    // goes red.
    for (const road of ROUTES) {
      for (const surface of SURFACES) {
        const answer = road.how[surface];
        expect(typeof answer, `${road.id} answers on ${surface}`).toBe("string");
        expect(answer.trim(), `${road.id} answers on ${surface}`).not.toBe("");
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  4 — the budget
// ---------------------------------------------------------------------------

describe("forcing point 4 — the index has a token budget, and says so when it is over", () => {
  test("the real index is above the floor and at or below the ceiling, on every surface", () => {
    // Decision 10, rule 4: the index has a ceiling AND a floor. A ceiling
    // alone passes on an empty index, so the floor is the other half.
    //
    // Counterfactual: add a road with a very long `when` — the ceiling
    // assertion goes red.
    for (const surface of SURFACES) {
      for (const childCanSearch of [true, false]) {
        const index = renderRouteIndex({ surface, childCanSearch });
        const cost = tokens(index);
        expect(
          cost,
          `${surface} (search=${childCanSearch}) is under the ceiling`,
        ).toBeLessThanOrEqual(ROUTE_INDEX_TOKEN_CEILING);
        expect(
          cost,
          `${surface} (search=${childCanSearch}) is over the floor`,
        ).toBeGreaterThanOrEqual(ROUTE_INDEX_TOKEN_FLOOR);
      }
    }
  });

  test("the bounds are the ones ADR-0061 states", () => {
    // Without this, editing the constant to 5000 keeps the suite green and the
    // record silently stops describing the code — the same hole the binding
    // contract's budget test closes for its own pair.
    //
    // Counterfactual: raise the ceiling (or drop the floor) — this goes red.
    expect(ROUTE_INDEX_TOKEN_CEILING, "ADR-0061's ceiling").toBe(560);
    expect(ROUTE_INDEX_TOKEN_FLOOR, "ADR-0061's floor").toBe(380);
  });

  test("an over-budget index says so, and drops no road", () => {
    // The third half of the rule, and the one that matters: a road that
    // silently disappeared from the index is a road the model cannot take and
    // cannot tell it is missing.
    //
    // Counterfactual: return the index untruncated and without the warning —
    // this goes red. Drop the last road to fit the budget — this goes red on
    // the road count.
    const index = renderRouteIndex({
      surface: "full_ptc",
      childCanSearch: true,
      routes: OVER_BUDGET_ROUTES,
    });
    expect(index, "the index says it is over budget").toContain(ROUTE_INDEX_OVER_BUDGET_WARNING);
    expect(roadLines(index).length, "no road was dropped").toBe(OVER_BUDGET_ROUTES.length);
  });
});

// ---------------------------------------------------------------------------
//  5 — every road carries a fact
// ---------------------------------------------------------------------------

describe("forcing point 5 — every road carries a fact", () => {
  test("no road is only a when", () => {
    // Decision 10, rule 5: "每行事实段非空：一条路不能只有「什么时候用」没有
    // 「是什么/怎么调」" — a road with no facts is prose, not a route.
    //
    // **The `typeof` assertion is the load-bearing half**, for the same reason
    // as rule 3: an absent field is `undefined`, and `undefined` is not the
    // empty string.
    //
    // Counterfactual: blank out one road's `fact` — this goes red.
    for (const road of ROUTES) {
      expect(typeof road.id, "a road has an id").toBe("string");
      expect(road.id.trim(), "a road has an id").not.toBe("");
      expect(typeof road.name, `${road.id} has a name`).toBe("string");
      expect(road.name.trim(), `${road.id} has a name`).not.toBe("");
      expect(typeof road.when, `${road.id} says when to take it`).toBe("string");
      expect(road.when.trim(), `${road.id} says when to take it`).not.toBe("");
      expect(typeof road.fact, `${road.id} carries facts`).toBe("string");
      expect(road.fact.trim(), `${road.id} carries facts`).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
//  6 — the prose has one home
// ---------------------------------------------------------------------------

describe("forcing point 6 — a tool's prose is the registry's call, never a copy", () => {
  test("each tool's description, snippet and guidelines ARE the registry's entry", async () => {
    // Decision 10, rule 6: "工具的 description / 指南 / 片段必须是册子的调用".
    //
    // **The comparison is EXACT, not containment.** A tool that added one
    // sentence of its own would still CONTAIN every registry paragraph — and
    // would still be the same prose in two places, which is the failure the
    // registry exists to prevent. So the tool's description must BE the
    // registry's rendering, word for word.
    //
    // The second half guards the comparison against being vacuous: if the
    // renderer silently dropped a paragraph, BOTH sides would drop it and the
    // equality would still hold. So the registry's own paragraphs are checked
    // to be present in what was built.
    //
    // Counterfactual: write the description literally in the tool file again —
    // the rendered tool stops equalling the rendered registry, and this goes
    // red.
    const built = await buildTools();
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      const prose = built.prose.get(name);
      expect(prose, `${name} is built by a factory`).toBeDefined();
      const registered = prose as ToolProse;
      expect(registered.promptSnippet, `${name}'s snippet`).toBe(entry.snippet);
      expect(registered.promptGuidelines, `${name}'s guidelines`).toEqual([...entry.guidelines]);
      expect(
        registered.description,
        `${name}'s description is the registry's rendering, word for word`,
      ).toBe(renderDescription(entry, built.filled.get(name) ?? {}));
      for (const paragraph of ownParagraphs(entry)) {
        expect(registered.description, `${name} carries the registry's paragraph`).toContain(
          paragraph,
        );
      }
    }
  });

  test("no source file carries a copy of the registry's prose", () => {
    // The one-home property, mechanically: the sentence lives in the registry,
    // so no other file may hold it as a literal.
    //
    // **The corpus is the WHOLE prose, with no length floor.** An earlier
    // version of this scan only looked at paragraphs of 40 characters and
    // sentences of 60 — and a tool that copied ONE SHORT SENTENCE of the
    // registry's prose sailed through, because the corpus never held the
    // sentence it had copied. Every sentence is in the corpus now, so a copy
    // of any of them is a hit.
    //
    // Counterfactual: paste one sentence of the registry's prose into
    // `src/tools/subagent.ts` — this goes red.
    const corpus = registryProse();
    expect(corpus.length, "the registry holds a scan-worthy corpus").toBeGreaterThanOrEqual(100);
    for (const file of sourceFiles()) {
      const source = scannable(readFileSync(file, "utf8"));
      for (const unit of corpus) {
        expect(
          source.includes(scannable(unit)),
          `${relative(REPO_ROOT, file)} must not carry a copy of the registry's prose: ${unit.slice(0, 60)}`,
        ).toBe(false);
      }
    }
  });

  test("the `agent` clause is one constant, carried by every surface that shows it", async () => {
    // The first of the three the inventory found: the `agent`-is-optional
    // clause, which two descriptions used to write out separately and which
    // ADR-0061 decision 10 added the codemode door to.
    //
    // **The surface list is a LITERAL**, because the guard's claim is "every
    // surface that shows this sentence shows the CONSTANT" — and a list read
    // off the code could only ever say "the surfaces that show it are the
    // ones that show it".
    //
    // Counterfactual: reword the clause in one description only — the other
    // surface's assertion goes red.
    const surfaces = ["ptc_run_code", "ptc_workflow", "pi_task_codemode"] as const;
    const built = await buildTools();
    for (const name of surfaces) {
      const description = (built.prose.get(name) as ToolProse).description;
      expect(description, `${name} carries the shared agent clause`).toContain(
        AGENT_OPTIONAL_CLAUSE,
      );
    }
  });

  test("the program-body sentence is one constant, carried by every schema that shows it", async () => {
    // The second of the three: the sentence that says what the program's body
    // is, which the `code` parameter and the `script` parameter used to write
    // out separately.
    //
    // Counterfactual: reword one parameter schema's description in place — the
    // other schema's assertion goes red.
    const built = await buildTools();
    const runCode = built.raw.get("ptc_run_code") as unknown as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const workflow = built.raw.get("ptc_workflow") as unknown as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    expect(runCode.parameters?.properties?.code?.description, "the program's own description").toBe(
      PROGRAM_BODY_DESCRIPTION,
    );
    expect(
      workflow.parameters?.properties?.script?.description,
      "the script's own description",
    ).toBe(PROGRAM_BODY_DESCRIPTION);
  });

  test("the `whySuppressed` sentence is one constant, carried by every schema that shows it", async () => {
    // The third of the three: the sentence that says what `whySuppressed`
    // means, which the codemode door's output schema and the task output's
    // output schema used to write out separately — and whose two versions had
    // already started to diverge at the tail.
    //
    // Counterfactual: reword one output schema's description in place — the
    // other schema's assertion goes red.
    const built = await buildTools();
    const codemode = built.raw.get("pi_task_codemode") as unknown as {
      outputSchema?: { properties?: Record<string, { description?: string }> };
    };
    const taskOutput = built.raw.get("ptc_task_output") as unknown as {
      outputSchema?: { properties?: Record<string, { description?: string }> };
    };
    expect(
      codemode.outputSchema?.properties?.whySuppressed?.description,
      "the codemode door's why_suppressed",
    ).toBe(WHY_SUPPRESSED_DESCRIPTION);
    expect(
      taskOutput.outputSchema?.properties?.why_suppressed?.description,
      "the task output's why_suppressed",
    ).toBe(WHY_SUPPRESSED_DESCRIPTION);
  });

  test("every sentence two surfaces carry reaches BOTH of them", async () => {
    // The shared sentences that were already one constant before the registry
    // existed, and the ones that became one because of it.
    //
    // Counterfactual: drop the image contract from the workflow description —
    // the workflow half goes red; the run_code half stays green, which is
    // exactly the drift this catches.
    const built = await buildTools();
    const runCode = (built.prose.get("ptc_run_code") as ToolProse).description;
    const workflow = (built.prose.get("ptc_workflow") as ToolProse).description;
    expect(runCode, "ptc_run_code carries the image contract").toContain(IMAGE_HOISTING_NOTE);
    expect(workflow, "ptc_workflow carries the image contract").toContain(IMAGE_HOISTING_NOTE);

    // The web sentence reaches the PTC descriptions only in a session whose
    // children can search — so this reads the tools built WITH that
    // capability, not the ones built without.
    const searching = await buildTools(true);
    const searchingRunCode = (searching.prose.get("ptc_run_code") as ToolProse).description;
    expect(searchingRunCode, "ptc_run_code carries the web sentence").toContain(
      PTC_CHILD_SEARCH_NOTE,
    );

    const codemodeDescription = (built.prose.get("pi_task_codemode") as ToolProse).description;
    expect(codemodeDescription, "the codemode door carries the door note").toContain(
      TASK_DOOR_RESULT_NOTE,
    );

    const stopProse = built.prose.get("ptc_task_stop") as ToolProse;
    expect(stopProse.description, "the stop tool's description").toContain(TASK_STOP_SEMANTICS);
    expect(stopProse.promptGuidelines ?? [], "the stop tool's guidelines").toContain(
      `Use ptc_task_stop to stop a task: ${TASK_STOP_SEMANTICS}`,
    );
  });
});

// ---------------------------------------------------------------------------
//  7 — one line per road, and the pointer resolves in the PACKAGE
// ---------------------------------------------------------------------------

describe("forcing point 7 — one line per road, and the pointer resolves in the package", () => {
  test("the index carries exactly one line per road, and nothing else", () => {
    // Decision 10, rule 7, first half: the index is an INDEX — a hook, the way
    // to take the road on this surface, and a pointer to the file with the
    // whole story. A road's `fact` belongs in that file, not in the line the
    // model reads every turn.
    //
    // The second half of the assertion — that nothing ELSE is in the index —
    // is what keeps the index from growing a second source of truth: a header
    // of its own, a footer, a note.
    //
    // Counterfactual: render the `fact` into the line as well — the "the fact
    // is not in the index" half goes red. A renderer that emitted two lines
    // for one road goes red on the count. A renderer that added a footer goes
    // red on the "nothing else" half.
    for (const surface of SURFACES) {
      const index = renderRouteIndex({ surface, childCanSearch: true });
      const lines = index.split("\n");
      const linesOfRoads = lines.filter((line) => line.startsWith("- "));
      expect(linesOfRoads.length, `${surface}: one line per road`).toBe(ROUTES.length);
      for (const road of ROUTES) {
        const line = linesOfRoads.find((candidate) => candidate.includes(road.detail));
        expect(line, `${road.id} has a line`).toBeDefined();
        expect(line, `${road.id}'s line names the road`).toContain(road.name);
        expect(line, `${road.id}'s line carries the hook`).toContain(road.when);
        expect(line, `${road.id}'s line carries the calling convention`).toContain(
          road.how[surface],
        );
        expect(line, `${road.id}'s line does NOT carry the fact`).not.toContain(road.fact);
      }
      const others = lines.filter(
        (line) => !line.startsWith("- ") && line !== "" && line !== ROUTE_INDEX_HEADER,
      );
      expect(others, `${surface}: the index carries nothing but its header and its roads`).toEqual(
        [],
      );
    }
  });

  test("every road's pointer resolves IN THE PACKAGE, not just on disk", () => {
    // Decision 10, rule 7, second half — and the half that is easy to get
    // wrong. The detail files ship (`package.json`'s `files` field covers
    // `docs/routes/`), so the pointer resolves on the USER'S machine. A file
    // that exists in the repository but not in the tarball leaves every
    // pointer dangling for everyone who installed the package — which is
    // exactly what shipped `docs/` outside the tarball in the first place.
    //
    // **Both halves are checked.** The `files` field's pattern has to cover
    // the pointer, AND the file has to exist under the root that pattern is
    // relative to (the package root). A pattern that covers nothing, or a
    // file that was never written, each fail one half.
    //
    // Counterfactual: drop `docs/routes/**/*.md` from the package's `files`
    // field — this goes red. Point a road at a file nobody wrote — this goes
    // red.
    const patterns = packagedPatterns();
    expect(patterns.length, "the package declares a files field").toBeGreaterThan(0);
    for (const road of ROUTES) {
      expect(
        patterns.some((pattern) => minimatch(road.detail, pattern, { dot: true })),
        `${road.id}'s pointer (${road.detail}) is covered by the package's files field`,
      ).toBe(true);
      expect(
        existsSync(join(REPO_ROOT, road.detail)),
        `${road.id}'s pointer (${road.detail}) exists under the package root`,
      ).toBe(true);
    }
  });

  test("the package ships every detail file under docs/routes/ and docs/usage/", () => {
    // The acceptance condition on the `files` field itself: the two
    // directories of shipped documentation have to be IN the tarball, or a
    // pointer into them dangles on the user's machine.
    //
    // Counterfactual: remove `docs/usage/**/*.md` from the package's `files`
    // field — this goes red.
    for (const dir of ["docs/routes", "docs/usage"]) {
      const names = readdirSync(join(REPO_ROOT, dir))
        .filter((name) => name.endsWith(".md"))
        .sort();
      expect(names.length, `${dir} holds detail files`).toBeGreaterThan(0);
      const unshipped = names.filter((name) => !isPackaged(`${dir}/${name}`));
      expect(unshipped, `${dir} files the package does not ship`).toEqual([]);
    }
  });

  test("the detail file carries the road's fact, so the two cannot drift", () => {
    // The pointer is the model's way to the whole story, and the story has to
    // be ABOUT the road the line names. Whitespace-normalised, because the
    // file wraps.
    //
    // Counterfactual: reword the registry's fact — the file no longer carries
    // it, and this goes red.
    const normalize = (text: string): string => text.replace(/\s+/g, " ");
    for (const road of ROUTES) {
      const file = normalize(readFileSync(join(REPO_ROOT, road.detail), "utf8"));
      expect(file, `${road.id}'s detail file carries the fact`).toContain(normalize(road.fact));
    }
  });
});

// ---------------------------------------------------------------------------
//  8 — byte-identical from turn to turn
// ---------------------------------------------------------------------------

describe("forcing point 8 — the index is byte-identical from turn to turn", () => {
  test("two renders of the same session are the same bytes", () => {
    // Decision 10, rule 8: the index is rebuilt on every model request, and a
    // system prompt that changes mid-session invalidates the cached prefix —
    // so the same session must produce the same bytes, every time.
    //
    // Counterfactual: put something that varies per call into the index (a
    // counter, a clock, a per-turn id) — the two renders differ and this goes
    // red.
    for (const surface of SURFACES) {
      for (const childCanSearch of [true, false]) {
        const first = renderRouteIndex({ surface, childCanSearch });
        const second = renderRouteIndex({ surface, childCanSearch });
        expect(second, `${surface} renders the same bytes`).toBe(first);
      }
    }
  });

  test("the index says nothing the registry does not say", () => {
    // The other half of rule 8: the index carries nothing that varies inside
    // a session. The thing that DOES vary inside a session is the binding
    // list — it is the session's, and it is what the session injection is
    // for (ADR-0061 decision 5).
    //
    // **This is a VOCABULARY check, and it is what catches the realistic
    // mutation.** Two renders of the same input are identical for a pure
    // function whatever it contains, so the byte check above cannot see a
    // session-varying value that is passed IN. The vocabulary check says the
    // index may only use words the registry's static zone uses — so a binding
    // list, a clock or a per-turn id riding along turns this red.
    //
    // Counterfactual: render the session's bound names into the index — the
    // names that are not the registry's own ("bash", "edit", "grep", "find",
    // "ls") turn this red.
    const known = new Set<string>([...registryVocabulary(), ...RENDERER_JOIN_WORDS]);
    for (const surface of SURFACES) {
      for (const childCanSearch of [true, false]) {
        const index = renderRouteIndex({ surface, childCanSearch });
        const said = [...new Set(wordsOf(index))];
        const unknown = said.filter((word) => !known.has(word));
        expect(unknown, `the ${surface} index says nothing the registry does not`).toEqual([]);
      }
    }
  });
});
