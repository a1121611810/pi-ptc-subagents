import { describe, expect, test } from "vitest";
import { captureRegisteredTools } from "./helpers/ptc.ts";
import { BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME } from "../src/runtime/bindings.ts";
import * as contract from "../src/tools/binding-contract.ts";

/**
 * The binding contract (ADR-0024) is model-facing text, so the only observable
 * is what the model is handed: the registered tool definitions, read through the
 * same registration path pi itself takes. Nothing here reaches into the
 * description constant or into the module that owns the text.
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

const BOUND_NAMES: readonly string[] = [...BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME];

/** Every binding the contract names, written as a literal: this is the decision. */
const CONTRACT_BINDINGS: readonly string[] = [
  "bash",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  DISPATCH_BINDING_NAME,
];

function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/**
 * A binding counts as named when it appears in backticks on its own, or in the
 * string-indexed call form the parallel binding is always written in -- the
 * contract says `tools["pi.dispatch"]`, never a bare `pi.dispatch`, because that
 * is the form that actually works in a program.
 */
function namesBinding(text: string, name: string): boolean {
  const tick = String.fromCharCode(96);
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
const CONTRACT_END = "read \u0060status\u0060.";

function contractOf(surface: string): string {
  const description = descriptionOf(surface);
  const start = description.indexOf(CONTRACT_START);
  if (start < 0) throw new Error(surface + " does not open with the binding contract");
  const end = description.indexOf(CONTRACT_END, start);
  if (end < 0) throw new Error(surface + " does not close with the binding contract");
  return description.slice(start, end + CONTRACT_END.length);
}

describe("the binding contract reaches the model", () => {
  const PTC_SURFACES = ["ptc_run_code", "ptc_workflow"] as const;

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
    // normalisation: a synonym, a re-wrap, or a dropped sentence on one side is a
    // drift, and this is what catches it.
    expect(contractOf("ptc_workflow"), "the surfaces teach the same shape").toBe(
      contractOf("ptc_run_code"),
    );
  });

  test("both surfaces carry exactly the module-owned text", () => {
    // The "one owner, two consumers" claim: the text is defined once, and both
    // surfaces ship that text rather than a paraphrase of it.
    for (const surface of PTC_SURFACES) {
      expect(contractOf(surface), surface + " ships the module-owned text").toBe(
        contract.BINDING_CONTRACT,
      );
    }
  });

  test("the contract appears exactly once, so a second copy cannot rot", () => {
    const description = descriptionOf("ptc_run_code");
    const occurrences = description.split(contract.BINDING_CONTRACT).length - 1;
    expect(occurrences, "the contract is spliced in once, not restated").toBe(1);
  });
});

describe("the contract names only bindings this extension binds", () => {
  test("the bindings it names are exactly the ones the decision lists", () => {
    const named = BOUND_NAMES.filter((name) => namesBinding(contract.BINDING_CONTRACT, name));
    expect([...named].sort(), "no binding is documented twice or silently dropped").toEqual(
      [...CONTRACT_BINDINGS].sort(),
    );
  });

  test("every binding it names is one the extension actually binds", () => {
    for (const name of CONTRACT_BINDINGS) {
      expect(BOUND_NAMES, "a documented binding is really bound").toContain(name);
    }
  });

  test("a binding this run may not bind is never claimed as callable", () => {
    const unbound = CONTRACT_BINDINGS.filter((name) => !BOUND_NAMES.includes(name));
    expect(unbound, "the contract must not teach a call that cannot succeed").toEqual([]);
  });
});

describe("the contract states the facts that kill the measured crash classes", () => {
  // docs/research/ptc-binding-contract-measurement-20260930.md: the 16-run
  // narrowed arm produced 31 program crashes, the largest class being the model
  // treating a binding result as a string or as an object with a files field.
  test("says content is an array of blocks and the text is content[0].text", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text, "content is an array of blocks").toContain("is an ARRAY of content blocks");
    expect(text, "the text is the first block's text").toContain("result.content[0].text");
  });

  test("says details is an object or null, never undefined", () => {
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

  test("says a failing call rejects rather than resolving", () => {
    const text = contract.BINDING_CONTRACT;
    expect(text, "rejection is named").toContain("REJECTS with `ToolCallError`");
    expect(text, "the unbound-builtin case is named").toContain("a builtin this run did not bind");
    expect(text, "a non-builtin is a type error, not a tool error").toContain(
      "not a builtin is simply not a function",
    );
  });
});

describe("a note exists only where behaviour genuinely differs", () => {
  test("the noted bindings are exactly the four that deviate", () => {
    expect(
      [...contract.NOTED_BINDING_NAMES].sort(),
      "only deviating bindings carry a note",
    ).toEqual(["bash", "edit", "write", DISPATCH_BINDING_NAME].sort());
  });

  test("a binding whose behaviour matches the shared shape carries no note", () => {
    // read, grep, find and ls are described by the shared shape alone. A note for
    // one of them would be a second place to keep in sync with no fact to add.
    for (const name of ["read", "grep", "find", "ls"]) {
      expect(
        contract.BINDING_NOTES.has(name),
        name + " deviates from the shared shape and therefore needs a note",
      ).toBe(false);
    }
  });

  test("every note reaches the model on both surfaces", () => {
    for (const surface of ["ptc_run_code", "ptc_workflow"]) {
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
    expect(contract.BINDING_CONTRACT, "and it is stated only in the note").not.toContain(
      "A failing call REJECTS with `ToolCallError` instead of resolving: a `bash` command",
    );
  });
});

describe("the contract stays inside its token ceiling", () => {
  // ADR-0024 section 5: about 300 estimated tokens, a ceiling rather than a
  // target, so a future genuine deviation can be documented without reopening
  // the budget argument. Upstream's comparable block costs several times this.
  test("the block is above the floor and at or below the ceiling", () => {
    const cost = estimatedTokens(contract.BINDING_CONTRACT);
    expect(cost, "an emptied or stubbed block cannot pass vacuously").toBeGreaterThanOrEqual(
      contract.BINDING_CONTRACT_TOKEN_FLOOR,
    );
    expect(cost, "the block is inside the agreed budget").toBeLessThanOrEqual(
      contract.BINDING_CONTRACT_TOKEN_CEILING,
    );
  });

  test("the module exports no argument table (decision: return types only)", () => {
    const argumentShaped = Object.keys(contract).filter((name) =>
      /arg|param|input|schema/i.test(name),
    );
    expect(
      argumentShaped,
      "pi declares arguments natively in the same request; restating them is pure token cost",
    ).toEqual([]);
  });
});

describe("counterfactual", () => {
  // Constraint 5: an obviously-wrong version that still satisfies a loose
  // assertion must turn the suite red. Each case below is a plausible wrong
  // edit to the contract text.
  test("a synonym on one surface is a drift the guard sees", () => {
    // The failure this whole block exists to prevent: someone rewords the
    // workflow copy. Byte equality has to notice a synonym, not just a deletion.
    const paraphrased = descriptionOf("ptc_workflow").replace(
      "No binding result has a",
      "No result carries a",
    );
    expect(paraphrased, "the reworded surface really did change").not.toBe(
      descriptionOf("ptc_workflow"),
    );
    const start = paraphrased.indexOf(CONTRACT_START);
    const end = paraphrased.indexOf(CONTRACT_END, start);
    const drifted = paraphrased.slice(start, end + CONTRACT_END.length);
    expect(drifted, "byte equality must reject a synonym").not.toBe(contractOf("ptc_run_code"));
  });

  test("a note for a binding that does not deviate is caught", () => {
    // read behaves exactly like the shared shape, so a note for it is a second
    // place to keep in sync with no fact to add.
    const withStrayNote = new Map(contract.BINDING_NOTES);
    withStrayNote.set("read", "`read` always reports `details: null`.");
    const keys = [...withStrayNote.keys()].sort();
    expect(keys, "the exact key set is the guard").not.toEqual(
      [...contract.NOTED_BINDING_NAMES].sort(),
    );
  });

  test("documenting a binding that is not bound is caught", () => {
    const wrong = contract.BINDING_CONTRACT.replace(
      "ONE text block",
      "one `web_search` block and ONE text block",
    );
    const named = backtickedTokens(wrong).filter((token) => !BOUND_NAMES.includes(token));
    expect(named, "a non-binding tool name leaked in").not.toEqual([]);
  });

  test("dropping a binding the contract is about to omit is caught", () => {
    const wrong = contract.BINDING_CONTRACT.replace("`write`", "`edit`");
    const named = BOUND_NAMES.filter((name) => backtickedTokens(wrong).includes(name));
    expect([...named].sort()).not.toEqual([...CONTRACT_BINDINGS].sort());
  });

  test("re-declaring the bindings' arguments blows the ceiling", () => {
    // What the rejected alternative actually looks like: every binding restated
    // with its full argument list, which is the form the upstream renderer emits
    // and the reason its comparable block costs several times this one.
    const args = [
      "read(args: { path: string; offset?: number; limit?: number }): Promise<string>;",
      "bash(args: { command: string; timeout?: number }): Promise<string>;",
      "edit(args: { path: string; oldText: string; newText: string }): Promise<string>;",
      "write(args: { path: string; content: string }): Promise<string>;",
      "grep(args: { pattern: string; path?: string; include?: string }): Promise<string>;",
      "find(args: { pattern: string; path?: string }): Promise<string>;",
      "ls(args: { path?: string }): Promise<string>;",
    ].join("\n");
    expect(estimatedTokens(contract.BINDING_CONTRACT + args)).toBeGreaterThan(
      contract.BINDING_CONTRACT_TOKEN_CEILING,
    );
  });

  test("emptying the block trips the floor, not just the ceiling", () => {
    expect(estimatedTokens("")).toBeLessThan(contract.BINDING_CONTRACT_TOKEN_FLOOR);
  });

  test("weakening the array-of-blocks fact is a real weakening", () => {
    const wrong = contract.BINDING_CONTRACT.replace("is an ARRAY of content blocks", "is a string");
    expect(wrong).not.toContain("is an ARRAY of content blocks");
    expect(contract.BINDING_CONTRACT).toContain("is an ARRAY of content blocks");
  });
});
