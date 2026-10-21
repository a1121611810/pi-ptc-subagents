/**
 * PROTOTYPE (throwaway) — drive the prototype's logic headlessly and check it.
 *
 * The prototype is an HTML file a human double-clicks; this harness is how I check it myself
 * without taking over the screen: it lifts the inline script out of the HTML, runs it against a
 * minimal DOM stub, and then exercises the builder over the REAL measured payloads.
 *
 * **What it asserts** (the invariants the verdict rests on):
 *   1. the HTML's script parses and runs (no reference error, no typo in an id);
 *   2. P1 (drop whole results) NEVER exceeds the budget;
 *   3. P1 drops WHOLE results — a dropped result's summary is not silently cut;
 *   4. P2 (cut by characters) DOES cut, and the cut is invisible to the model;
 *   5. the notice names the dropped pages and their urls.
 *
 * Run: `node docs/prototypes/search-context-budget-check.js`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "search-context-budget.html"), "utf8");

// --- the DOM stub -----------------------------------------------------------------------------

const elements = new Map();
function stub(id) {
  const el = {
    id,
    value: id === "policy" ? "unbounded" : id === "budget" ? "8000" : id === "scenario" ? "0" : "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild() {},
  };
  elements.set(id, el);
  return el;
}
const dataEl = stub("data");
const scripts = [...HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({
  attrs: m[1],
  body: m[2],
}));
if (scripts.length < 2) throw new Error("the prototype has no inline script to check");
const dataBlock = scripts.find((m) => m.attrs.includes("application/json"));
const appBlock = scripts[scripts.length - 1];
dataEl.textContent = dataBlock.body;

const document = {
  getElementById: (id) => (id === "data" ? dataEl : (elements.get(id) ?? stub(id))),
  querySelectorAll: () => [],
  createElement: () => ({ set textContent(v) {}, set value(v) {} }),
};
const context = vm.createContext({
  document,
  console,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  Set,
  Map,
  Intl,
});
vm.runInContext(appBlock.body, context, { filename: "prototype-inline.js" });
console.log("✓ the inline script parses and runs");

// --- the builder, reached through the same source the page runs ---------------------------------

const source = appBlock.body;
const buildStart = source.indexOf("function buildText(");
const buildEnd = source.indexOf("// ------", buildStart);
const buildSource = source.slice(buildStart, buildEnd);
const build = vm.runInContext(`${buildSource}; buildText;`, context);

const DATA = JSON.parse(dataBlock.body);
const MEAS = DATA.measurements;

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label} ${detail}`);
  }
}

console.log("\n── the invariants, over every measured payload and every budget ──");
for (const m of MEAS) {
  for (const budget of [2000, 4000, 8000, 12000, 24000, 999999]) {
    const whole = build(m.sample, "whole", budget, m.need_content);
    const chars = build(m.sample, "chars", budget, m.need_content);

    // The budget bounds the RESULT BLOCKS. The notice that names the dropped pages is an
    // overhead ON TOP of it — reported separately, never hidden inside the bound.
    // P1's floor: result #1 always goes in, so a budget smaller than it is exceeded ON PURPOSE.
    check(
      `${m.label} @ ${budget}: P1's blocks stay inside the budget (or the floor result alone)`,
      whole.blockChars <= budget || whole.kept === 1 || budget === 999999,
      `(got ${whole.blockChars}, kept ${whole.kept})`,
    );
    check(
      `${m.label} @ ${budget}: P2's blocks stay inside the budget`,
      chars.blockChars <= budget || budget === 999999,
      `(got ${chars.blockChars})`,
    );
    // A dropped result must be ABSENT from the text — not present in a cut form. That is the
    // whole difference between P1 and P2.
    //
    // Stated as a COUNT of summary blocks, not as "the dropped summary's text is absent": two
    // results from the same site share their opening characters, so a substring test reported
    // a leak that was not there. The count is the honest claim: the text carries exactly the
    // kept results, each in full.
    const summaryBlocks = (whole.text.match(/^   summary: /gm) ?? []).length;
    const keptSamples = m.sample.slice(0, whole.kept);
    const missingSamples = m.sample.slice(whole.kept);
    check(
      `${m.label} @ ${budget}: P1 carries exactly the top-k, each in full`,
      summaryBlocks === whole.kept && keptSamples.every((r) => whole.text.includes(r.summary)),
    );
    // And the notice must account for the WHOLE missing tail, not just the first result that
    // did not fit — that was a real bug in the first version of this prototype.
    check(
      `${m.label} @ ${budget}: the notice accounts for every missing result`,
      whole.dropped.length === missingSamples.length &&
        missingSamples.every((r) => whole.text.includes(r.url)),
    );
    check(
      `${m.label} @ ${budget}: the notice names every dropped page's url`,
      whole.dropped.every((d) => whole.text.includes(d.url)),
    );
    // And the converse: P2 DOES cut, and it says so in the text — the cut is marked, but the
    // FACT it removed is gone.
    if (
      budget !== 999999 &&
      chars.chars < build(m.sample, "unbounded", 999999, m.need_content).chars
    ) {
      check(`${m.label} @ ${budget}: P2 marks its cuts`, chars.text.includes("（已截断）"));
    }
  }
}
console.log(`\n${failures === 0 ? "✓ all invariants hold" : `✗ ${failures} invariant(s) failed`}`);

// --- the numbers the verdict rests on -----------------------------------------------------------

console.log("\n── the numbers ──");
for (const m of MEAS) {
  const unbounded = build(m.sample, "unbounded", 999999, m.need_content);
  const p1 = build(m.sample, "whole", 8000, m.need_content);
  const p2 = build(m.sample, "chars", 8000, m.need_content);
  console.log(
    `${m.label.padEnd(15)} 无界 ${String(unbounded.chars).padStart(6)} 字符 / ${String(unbounded.kept).padStart(2)} 条` +
      `   P1@8k 本体 ${String(p1.blockChars).padStart(5)} + 告知 ${String(p1.chars - p1.blockChars).padStart(4)} = ${String(p1.chars).padStart(5)} / ${p1.kept} 条（丢 ${p1.dropped.length}）` +
      `   P2@8k 本体 ${String(p2.blockChars).padStart(5)} / ${p2.kept} 条`,
  );
}

console.log("\n── how many searches fit in a 128k context (520,000 chars) ──");
for (const m of MEAS) {
  const unbounded = build(m.sample, "unbounded", 999999, m.need_content);
  const p1 = build(m.sample, "whole", 8000, m.need_content);
  console.log(
    `${m.label.padEnd(15)} 无界 ${String(Math.floor(520000 / unbounded.chars)).padStart(3)} 次` +
      `   P1@8k ${String(Math.floor(520000 / Math.max(1, p1.chars))).padStart(3)} 次`,
  );
}

process.exit(failures === 0 ? 0 : 1);
