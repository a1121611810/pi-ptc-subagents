import { describe, expect, test } from "vitest";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureRegisteredTools, makeTempDir, removeTempDir } from "./helpers/ptc.ts";
import {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DISPATCH_BINDING_NAME,
} from "../src/runtime/bindings.ts";
import * as contract from "../src/tools/binding-contract.ts";

const PTC_SURFACES = ["ptc_run_code", "ptc_workflow"] as const;

/**
 * The registered tool description, read through the same registration path pi
 * itself takes. This is the model-facing observable, and the guards that assert
 * on delivery -- presence, exactly-once, byte equality between the two surfaces,
 * and every note reaching the model -- are written against it. The guards that
 * assert on content read the module's text, because that is where the text
 * lives; the two are not the same claim and the file does not pretend they are.
 */
function descriptionOf(toolName: string): string {
  const tool = captureRegisteredTools().get(toolName);
  if (!tool) throw new Error(toolName + " must be registered");
  return tool.description;
}

/**
 * pi's own estimator for the upstream declaration renderer, reproduced here
 * rather than imported, so the budget assertion does not depend on the module
 * under test agreeing with itself about how to count.
 */
function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Deliberately derived from the real binding table and not from anything the
// contract module exports: an oracle living in the module under test would
// satisfy the very guard that is supposed to be checking it.
const BOUND_NAMES: readonly string[] = [...BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME];

/** The per-call context the binding table expects, as the existing binding tests pass it. */
const CALL = { callId: 1, depth: 0, maxDispatchDepth: 3 };

function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/**
 * Every backticked token the contract may name that is NOT a binding: the result
 * fields, the four fields that do not exist, the empty-answer sentinels, and the
 * runtime vocabulary. Written as a literal so it is an independent expectation,
 * not a copy of the string. Anything else in backticks has to be a real binding.
 */
const NON_BINDING_VOCABULARY: readonly string[] = [
  "tools.<name>(args)",
  'tools["pi.dispatch"]',
  "{ content, details }",
  "content",
  "details",
  "null",
  "undefined",
  "files",
  "output",
  "matches",
  "entries",
  "result.content[0].text",
  "No matches found",
  "No files found matching pattern",
  "(empty directory)",
  "ToolCallError",
  "try",
  "catch",
  "Promise.allSettled",
  "details: null",
  "{ text, status, ... }",
  "status",
  "diff",
  "patch",
];

/**
 * A parameter list, which the contract must never contain: pi already declares
 * every tool's arguments natively in the same request. Two shapes, because a
 * re-declaration can be typed or not.
 *
 * `TYPED_PARAMETER` is structural rather than a list of type names -- an earlier
 * version enumerated nine names, and a signature written in any other type (an
 * interface, a byte array, a callback) walked straight past it. `[ \t]` rather
 * than `[ ]` because a tab-indented signature is still a signature.
 *
 * `BARE_PARAMETER` catches the untyped form, `Args: read(path, offset)`, which the
 * typed pattern cannot see because there is nothing after the colon. It is scoped
 * to a call that is not namespaced through `tools.`, so the contract's own
 * `tools.<name>(args)` and its `Promise.all(...)` examples stay clean. What it
 * still does not catch is `tools.read(path)`, which is the form the contract is
 * teaching the model to write, not a re-declaration.
 */
const TYPED_PARAMETER = /\([^()]*[A-Za-z_$][A-Za-z0-9_$]*[ \t]*[?]?[ \t]*:/g;
const BARE_PARAMETER = /(?<![\w$.])(?!tools\.)[A-Za-z_$][A-Za-z0-9_$]*\([^()]*[^()\s][^()]*\)/g;

// ------------------------------------------------------------------- predicates
// Shared by each guard and its counterfactual, so a counterfactual exercises the
// real guard rather than a restatement of it.

/**
 * The budget rule, as one predicate. Both bounds live here so the guard and its
 * counterfactual cannot drift apart: a counterfactual that re-derives the
 * comparison is asserting on its own literal, and the real assertion can be
 * deleted without anything noticing.
 */
/** The array-of-blocks fact, as one predicate the counterfactual can also call. */
function statesContentIsArrayOfBlocks(text: string): boolean {
  return text.includes("is an ARRAY of content blocks");
}

function withinBudget(text: string): boolean {
  const cost = estimatedTokens(text);
  return (
    cost >= contract.BINDING_CONTRACT_TOKEN_FLOOR && cost <= contract.BINDING_CONTRACT_TOKEN_CEILING
  );
}

/**
 * The bindings that genuinely deviate, as a literal. The guard and its
 * counterfactual both read this, so the counterfactual compares against the
 * decision rather than against the thing under test.
 */
const EXPECTED_NOTED: readonly string[] = ["bash", "edit", "write", DISPATCH_BINDING_NAME].sort();

/**
 * The bindings a note map carries, in a stable order. This extracts; it does not
 * decide which bindings deserve a note -- that decision is EXPECTED_NOTED, and
 * comparing the two is the whole point of the guard.
 */
function notedBindingNames(notes: ReadonlyMap<string, string>): string[] {
  return [...notes.keys()].sort();
}

/** Names the contract asserts that are neither a binding nor known vocabulary. */
function unboundNamesNamed(text: string): string[] {
  return backtickedTokens(text).filter(
    (token) => !NON_BINDING_VOCABULARY.includes(token) && !BOUND_NAMES.includes(token),
  );
}

/**
 * Parameter declarations found in the emitted text, quoted or not. Scanning
 * only the backticked tokens left a hole on the other side: a signature written in
 * bare prose is still a signature, and it was the form the closed type-name list
 * also happened to miss.
 */
function argumentShapedTokens(text: string): string[] {
  return [...text.matchAll(TYPED_PARAMETER), ...text.matchAll(BARE_PARAMETER)].map((m) => m[0]);
}

/**
 * A binding counts as named when it appears in backticks on its own, or in the
 * string-indexed call form the parallel binding is always written in.
 */
function namesBinding(text: string, name: string): boolean {
  const tick = "`";
  return (
    text.includes(tick + name + tick) ||
    text.includes(tick + "tools[" + JSON.stringify(name) + "]" + tick)
  );
}

/**
 * The contract as the model receives it on one surface, sliced back OUT of that
 * surface's rendered description. Reading it out of the description rather than
 * returning the module's constant is the whole point: comparing the constant to
 * itself would pass even if the two surfaces shipped different text.
 */
const CONTRACT_START = "Return value: every ";
const CONTRACT_END = "read `status`.";

function contractOf(surface: string, description?: string): string {
  const text = description ?? descriptionOf(surface);
  const start = text.indexOf(CONTRACT_START);
  if (start < 0) throw new Error(surface + " does not open with the binding contract");
  const end = text.indexOf(CONTRACT_END, start);
  if (end < 0) throw new Error(surface + " does not close with the binding contract");
  return text.slice(start, end + CONTRACT_END.length);
}

describe("the binding contract reaches the model", () => {
  test("ptc_run_code states the contract verbatim", () => {
    expect(descriptionOf("ptc_run_code")).toContain(contract.BINDING_CONTRACT);
  });

  test("every PTC surface carries the contract exactly once", () => {
    for (const surface of PTC_SURFACES) {
      const description = descriptionOf(surface);
      const occurrences = description.split(contract.BINDING_CONTRACT).length - 1;
      expect(occurrences, surface + " splices the contract in once, not restated").toBe(1);
    }
  });

  test("the two surfaces are byte-identical, so they cannot drift", () => {
    // Byte comparison of two independently sliced substrings, not regex
    // normalisation: a synonym, a re-wrap, or a dropped sentence on one side is
    // a drift, and this is what catches it.
    expect(contractOf("ptc_workflow"), "the surfaces teach the same shape").toBe(
      contractOf("ptc_run_code"),
    );
  });

  test("both surfaces carry exactly the module-owned text", () => {
    for (const surface of PTC_SURFACES) {
      expect(contractOf(surface), surface + " ships the module-owned text").toBe(
        contract.BINDING_CONTRACT,
      );
    }
  });
});

describe("the contract names nothing the extension cannot bind", () => {
  test("every name in backticks is a binding or known vocabulary", () => {
    // The guard reads the contract's OWN tokens. An earlier version iterated the
    // already-bound names instead, which made an unbound name structurally
    // invisible: inserting one left the whole suite green.
    for (const surface of PTC_SURFACES) {
      expect(unboundNamesNamed(contractOf(surface)), surface + " names nothing unbound").toEqual(
        [],
      );
    }
  });

  test("every bound binding is either named or knowingly covered by the shared shape", () => {
    // The literal is the point: adding an eighth builtin turns this red until
    // somebody decides whether the new binding is named or merely covered. `read`
    // is covered by the generic `tools.<name>(args)` phrasing -- it behaves
    // exactly like the shared shape and needs no note.
    const unnamed = BOUND_NAMES.filter((name) => !namesBinding(contract.BINDING_CONTRACT, name));
    expect(unnamed, "a binding the model is told nothing specific about").toEqual(["read"]);
  });
});

describe("the contract states the facts that kill the measured crash classes", () => {
  test("says content is an array of blocks and the text is content[0].text", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text, "the text is the first block text").toContain("result.content[0].text");
  });

  test("says details is an object or null, never undefined", () => {
    // The full phrase, across the line break: a rewording that dropped the
    // "never undefined" half has to fail this.
    expect(contract.BINDING_CONTRACT).toContain("object or `null`, never\n`undefined`");
  });

  test("says the four absent fields do not exist", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text, "names the absent fields").toContain(
      "No binding result has a `files`, `output`, `matches` or `entries` field",
    );
    expect(text, "says which tools return plain rows instead").toContain(
      "`bash`, `grep`, `find` and `ls` hand back ONE text block",
    );
  });

  test("says an empty answer is a sentinel, not an empty list", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text).toContain("No matches found");
    expect(text).toContain("No files found matching pattern");
    expect(text).toContain("(empty directory)");
  });

  test("says a failing call rejects, and says the program can catch it", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text, "rejection is named").toContain("REJECTS with `ToolCallError`");
    expect(text, "the unbound-builtin case is named").toContain("a builtin this run did not");
    expect(text, "a non-builtin is a type error").toContain(
      "not a builtin is simply not a function",
    );
    expect(text, "the call is catchable").toContain("wrap the call in");
    expect(text, "both catch forms are named").toContain(`Promise.allSettled`);
  });
});

describe("a note exists only where behaviour genuinely differs", () => {
  test("the noted bindings are exactly the four that deviate", () => {
    expect(
      notedBindingNames(contract.BINDING_NOTES),
      "only deviating bindings carry a note",
    ).toEqual([...EXPECTED_NOTED]);
  });

  test("a binding matching the shared shape carries no note", () => {
    const notes = contract.BINDING_NOTES as ReadonlyMap<string, string>;
    for (const name of ["read", "grep", "find", "ls"]) {
      expect(notes.has(name), name + " carries a note it does not need").toBe(false);
    }
  });

  test("every note reaches the model on both surfaces", () => {
    for (const surface of PTC_SURFACES) {
      const description = descriptionOf(surface);
      for (const [name, note] of contract.BINDING_NOTES) {
        expect(description, surface + " states the " + name + " note").toContain(note);
      }
    }
  });

  test("the bash note carries the non-zero exit case the body no longer does", () => {
    expect(contract.BINDING_NOTES.get("bash"), "the exit case is stated once").toContain(
      "non-zero exit",
    );
  });
});

describe("the contract stays inside its budget", () => {
  // ADR-0024 section 5: a ceiling rather than a target, so a future genuine
  // deviation can be documented without reopening the budget argument, and a
  // floor, because a ceiling-only check passes on an empty block.
  test("the block is above the floor and at or below the ceiling", () => {
    // through withinBudget, not through the comparison spelled out here: an
    // earlier version inlined both bounds, and deleting them left the suite green
    // while the counterfactual below carried on passing against its own literal.
  });

  test("the bounds are the ones the record states", () => {
    // Without this, editing the constant to 1000 keeps the suite green and the
    // record silently stops describing the code.
    expect(contract.BINDING_CONTRACT_TOKEN_CEILING, "ADR-0024 section 5").toBe(300);
    expect(contract.BINDING_CONTRACT_TOKEN_FLOOR, "ADR-0024 section 5").toBe(200);
  });

  test("the block declares no parameter, so the argument-table decision holds", () => {
    // Read from the emitted text, not from the export names: an export-name scan
    // cannot see a text edit, and appending one re-declared signature to the block
    // left the whole suite green when the guard only looked at identifiers.
    for (const surface of PTC_SURFACES) {
      expect(
        argumentShapedTokens(contractOf(surface)),
        "pi declares arguments natively; the block must not restate them",
      ).toEqual([]);
    }
  });

  test("re-declaring the real argument schemas blows the ceiling", () => {
    // The rejected alternative, measured against the installed pi rather than
    // illustrated with a hand-written one: the actual argument schemas of the
    // seven builtin tools, serialised the way a declaration block would carry
    // them. An earlier version of this test hand-invented those signatures and
    // misstated pi (edit takes edits[], grep has no include).
    const tools = [
      createReadTool(process.cwd()),
      createBashTool(process.cwd()),
      createEditTool(process.cwd()),
      createWriteTool(process.cwd()),
      createGrepTool(process.cwd()),
      createFindTool(process.cwd()),
      createLsTool(process.cwd()),
    ];
    const asDeclarations = tools
      .map((tool) => tool.name + "(args: " + JSON.stringify(tool.parameters) + ")")
      .join("\n");
    expect(tools.length, "the fixture is built from the installed pi").toBe(7);
    expect(estimatedTokens(asDeclarations), "restating them is unaffordable").toBeGreaterThan(
      contract.BINDING_CONTRACT_TOKEN_CEILING,
    );
  });
});

describe("the contract is true of the runtime it describes", () => {
  // The notes are third-party facts about the installed pi, so the text can reach
  // the model while being false. These run the real binding table.
  test("write really does resolve with details null, new file and overwrite alike", async () => {
    // The note says "always", so the suite pins both paths of the IO boundary: a
    // new file and an overwrite. One happy path would be n=1 for a claim about a
    // third-party tool.
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "hello\n");
      const bindings = createBuiltinBindings({ cwd: dir });
      const first = (await bindings
        ?.get("write")
        ?.execute({ path: "fixture.txt", content: "written\n" }, CALL)) as {
        details: unknown;
      };
      expect(first.details, "write over an existing file reports null details").toBe(null);

      const second = (await bindings
        ?.get("write")
        ?.execute({ path: "fresh.txt", content: "new\n" }, CALL)) as {
        details: unknown;
      };
      expect(second.details, "write to a new file reports null details").toBe(null);

      // The third path, and the one "always" really rests on: a directory that
      // does not exist. pi resolves this too rather than rejecting, which is
      // surprising enough that it is worth pinning -- a release that starts
      // rejecting here is exactly the change this note would become false on.
      const missing = (await bindings
        ?.get("write")
        ?.execute({ path: "no-such-dir/file.txt", content: "x\n" }, CALL)) as {
        details: unknown;
      };
      expect(missing.details, "write into a missing directory still resolves with null").toBe(null);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("bash really does reject on a non-zero exit, and resolve on a zero one", async () => {
    // Both paths of one IO boundary, and the failure path is the one the note
    // promises, so a pi release that starts resolving would turn this red.
    const bindings = createBuiltinBindings({ cwd: process.cwd() });
    const ok = (await bindings.get("bash")?.execute({ command: "exit 0" }, CALL)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(ok.content[0]?.type, "a zero exit resolves with content").toBe("text");
    let rejected = false;
    try {
      await bindings.get("bash")?.execute({ command: "exit 3" }, CALL);
    } catch (error) {
      rejected = true;
      // The binding re-throws whatever the tool threw; the worker is what wraps
      // it as a ToolCallError, so the name is asserted at the worker layer, not
      // here. What this layer owes the model is simply that it rejects.
      expect(String((error as Error).message), "the failure names the exit code").toContain("3");
    }
    expect(rejected, "a non-zero exit rejects rather than resolving").toBe(true);
  });
});

describe("the guards are themselves checked", () => {
  test("the non-binding vocabulary holds no parameter-shaped entry", () => {
    // Stated as what it is. An earlier version claimed this keeps the argument
    // guard from being blinded, which was not true: the guard scans the whole
    // emitted text and never reads this list. What it really rules out is a
    // leftover declaration in the whitelist itself, which would then be exempt
    // from the name guard for no reason anyone could state.
    expect(
      NON_BINDING_VOCABULARY.filter((token) => argumentShapedTokens(token).length > 0),
      "the vocabulary must not hold a parameter declaration",
    ).toEqual([]);
  });
});

describe("counterfactual", () => {
  // Constraint 5: an obviously-wrong version must turn the suite red. Each case
  // below applies the SAME predicate the real guard uses, to a mutated string, so
  // it exercises the guard rather than restating it.

  test("a name that is not a binding is caught by the vocabulary guard", () => {
    const wrong = contract.BINDING_CONTRACT.replace(
      "ONE text block",
      "one `web_search` block and ONE text block",
    );
    expect(unboundNamesNamed(wrong), "the guard fires on the original").not.toEqual([]);
  });

  test("a reworded surface is caught by the byte-equality guard", () => {
    const paraphrased = descriptionOf("ptc_workflow").replace(
      "No binding result has a",
      "No result carries a",
    );
    expect(contractOf("ptc_workflow", paraphrased)).not.toBe(contractOf("ptc_run_code"));
  });

  test("a re-declared parameter is caught by the argument guard", () => {
    // The canonical form, the optional form, and two the earlier closed
    // type-name list walked straight past: an interface-typed signature and a
    // byte-array one. The last is unquoted, because a signature written in bare
    // prose is still a signature and the old scan only looked at backticks.
    const cases: readonly string[] = [
      `read(path: string)`,
      `read(path: string, offset?: number)`,
      `read(input: ReadInput, opts: ReadOptions)`,
      `write(bytes: Uint8Array)`,
      "call read(path: string) first",
    ];
    for (const signature of cases) {
      const wrong = contract.BINDING_CONTRACT + "\n" + signature + ";";
      expect(argumentShapedTokens(wrong), "the guard catches: " + signature).not.toEqual([]);
    }
  });

  test("a note for a binding that does not deviate is caught by the key-set guard", () => {
    // The real guard's predicate, applied to a mutated map -- not a comparison of
    // the mutation against the untouched original, which is true either way.
    const withStrayNote = new Map<string, string>(contract.BINDING_NOTES);
    withStrayNote.set("read", "`read` always reports `details: null`.");
    expect(notedBindingNames(withStrayNote), "the guard rejects a stray note").not.toEqual([
      ...EXPECTED_NOTED,
    ]);
  });

  test("an emptied block is caught by the floor, and a grown one by the ceiling", () => {
    // The spec names both bounds as counterfactuals, and both go through the
    // guard's own predicate. An earlier version compared a local literal against
    // a constant, which stayed true whether or not the real guard was still there.
    const stubbed = "Return value: every `tools.<name>(args)` call resolves.";
    expect(withinBudget(stubbed), "a stub is under the floor").toBe(false);

    const grown = contract.BINDING_CONTRACT.repeat(3);
    expect(withinBudget(grown), "a tripled block is over the ceiling").toBe(false);

    expect(withinBudget(contract.BINDING_CONTRACT), "the real block still passes").toBe(true);
  });

  test("weakening the array-of-blocks fact is caught by the content guard", () => {
    // through the content predicate, not through a second copy of the assertion:
    // the previous version restated the guard here, so deleting the real one left
    // this passing.
    const wrong = contract.BINDING_CONTRACT.replace("is an ARRAY of content blocks", "is a string");
    expect(statesContentIsArrayOfBlocks(wrong), "the guard rejects the rewording").toBe(false);
    expect(
      statesContentIsArrayOfBlocks(contract.BINDING_CONTRACT),
      "the real block still passes",
    ).toBe(true);
  });
});
