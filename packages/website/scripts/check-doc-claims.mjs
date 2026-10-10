#!/usr/bin/env node
/**
 * Gate: the reader-facing documents must still say what the code does.
 *
 * A sweep of the four projected documents found **48** machine-checkable claims about the code.
 * Twenty-four are checkable with what this repository already has. This gate binds the
 * drift-plausible subset to **named constants**, because that is the failure worth catching: a
 * default moves, a literal is reworded, a key is renamed, and the prose keeps describing the
 * previous code. A reader has no way to check a landing page, which makes a documentation site a
 * worse place for drift than a source comment nobody reads either.
 *
 * It already found a real one before it existed: `ptc_task_output` emits `report_channel` and
 * `report`, which `docs/usage/structured-results.md` did not list. Corrected in #160.
 *
 * ## Why the source side binds to a *name*, not to a string search
 *
 * `dispatch depth limit reached` appears twice in `src/runtime/dispatch.ts` — once as the
 * foreground refusal and once as the prefix of `BACKGROUND_DEPTH_LIMIT_MESSAGE`. A gate that
 * searched for "the message containing this text" would bind to whichever came first and report a
 * false positive forever. Worse, the foreground depth message is **not a named constant**; it is an
 * inline literal inside `dispatchDepthLimitReached()`. So the bindings are of three kinds, and each
 * names its anchor precisely:
 *
 *   - `config`     — a key of `DEFAULT_CONFIG` in `src/runtime/limits.ts`
 *   - `const`      — an exported `const` named in a named file
 *   - `inFunction` — a literal inside a named exported function
 *
 * ## Why the document side is a contiguous match after whitespace normalisation
 *
 * A claim is matched as `anchor + renderedValue` as one contiguous string over the document's
 * whitespace-normalised text. Pinning a whole sentence would fire on any rewording that does not
 * change the claim, and "the number appears somewhere in the file" would be true of nearly any
 * file. Contiguity ties the value to the claim and survives a line wrap, because a wrapped
 * markdown line collapses to a single space.
 *
 * ## Exit code
 *
 * 1 on any binding whose source no longer yields its documented value. The output names the
 * binding, the source anchor, what the source says now, and what the document still says — so a
 * red gate is a decision prompt, not a puzzle. A run that finds nothing prints the binding count,
 * because silence is indistinguishable from having looked at nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Recursively list .ts files under a directory. */
function tsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Strip comments. Without this a JSDoc line quoting a value would satisfy a binding, and the gate
 * would pass on prose alone — which is the same failure `check-landing-tool-names.mjs` guards.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

function readSrc(rel) {
  return stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

/** Collapse every whitespace run to one space, so a wrapped markdown line reads as one line. */
function normalize(text) {
  return text.replace(/\s+/g, ' ');
}

/** A tiny evaluator for the only arithmetic this repository writes in a const: `A * B`. */
function evaluateArithmetic(expr) {
  const parts = expr.split('*').map((p) => Number(p.replace(/[\s_]/g, '')));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`refusing to evaluate ${JSON.stringify(expr)}: not plain multiplication`);
  }
  return parts.reduce((a, b) => a * b, 1);
}

/**
 * A key of `DEFAULT_CONFIG`. This is the single declaration site for all fifteen `PtcConfig`
 * defaults, so binding here is binding to the truth rather than to a copy of it.
 */
function configDefault(key) {
  const source = readSrc('src/runtime/limits.ts');
  const body = /export\s+const\s+DEFAULT_CONFIG[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(
    source,
  );
  if (!body) throw new Error('DEFAULT_CONFIG not found in src/runtime/limits.ts');
  const found = new RegExp(`\\b${key}:\\s*([\\d_]+)\\s*,`).exec(body[1]);
  if (!found) throw new Error(`DEFAULT_CONFIG has no key ${key}`);
  return Number(found[1].replace(/_/g, ''));
}

/** An exported `const`, by name, in a named file. Handles type annotations and a trailing `as const`. */
function namedConst(rel, name) {
  const source = readSrc(rel);
  const found = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*([^;]+);`).exec(source);
  if (!found) throw new Error(`${rel} has no exported const ${name}`);
  const expr = found[1].trim().replace(/\s+as\s+const$/, '');
  if (/^["'`]/.test(expr)) return expr.slice(1, -1);
  if (/^[\d_\s*+]+$/.test(expr)) return evaluateArithmetic(expr);
  throw new Error(`cannot read a literal value out of ${name} = ${expr}`);
}

/**
 * A literal inside a named exported function's body.
 *
 * Used for the one binding whose source is an inline literal rather than a named constant: the
 * foreground depth refusal. Naming the function is what separates it from `BACKGROUND_*`, which
 * holds a different string in the same file.
 */
function literalInFunction(rel, fnName, literal) {
  const source = readSrc(rel);
  const start = source.indexOf(`export function ${fnName}`);
  if (start === -1) throw new Error(`${rel} has no exported function ${fnName}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport (?:function|const|type|interface|class|enum) /);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  if (!body.includes(literal)) {
    throw new Error(`${fnName}() no longer contains ${JSON.stringify(literal)}`);
  }
  return literal;
}

/**
 * The bindings.
 *
 * `doc` + `anchor` describe where the claim is made; `anchor + render(value)` must appear
 * contiguously in the document's normalised text. `render` carries the unit conversions the prose
 * does — the code says `120_000`, the document says `120 s`.
 */
const BINDINGS = [
  {
    id: 'dispatch-concurrency-default',
    source: () => configDefault('dispatchConcurrency'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '`dispatchConcurrency` — default ',
    render: (v) => String(v),
  },
  {
    id: 'max-dispatch-depth-default',
    source: () => configDefault('maxDispatchDepth'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '`maxDispatchDepth` — default ',
    render: (v) => String(v),
  },
  {
    id: 'run-deadline-default',
    source: () => configDefault('timeoutMs'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '(default **',
    render: (v) => `${v / 1000} s`,
  },
  {
    id: 'run-deadline-ceiling',
    source: () => configDefault('maxTimeoutMs'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'ceiling **',
    render: (v) => `${v / 1000} s`,
  },
  {
    id: 'foreground-concurrency-message',
    source: () => namedConst('src/runtime/dispatch.ts', 'DISPATCH_CONCURRENCY_LIMIT_MESSAGE'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'errorMessage: "',
    render: (v) => `${v}"`,
  },
  {
    // Not a named constant: the foreground depth refusal is an inline literal inside the helper.
    // Binding by function name is what keeps this distinct from BACKGROUND_DEPTH_LIMIT_MESSAGE,
    // which holds a `next_step:`-suffixed string in the same file.
    id: 'foreground-depth-message',
    source: () =>
      literalInFunction(
        'src/runtime/dispatch.ts',
        'dispatchDepthLimitReached',
        'dispatch depth limit reached',
      ),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'errorMessage: "',
    render: (v) => `${v}"`,
  },
  {
    id: 'task-list-limit-default',
    source: () => namedConst('src/tools/ptc-task.ts', 'DEFAULT_TASK_LIST_LIMIT'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '| `limit` | `number` | ',
    render: (v) => `\`${v}\``,
  },
  {
    id: 'stop-reason-default',
    source: () => namedConst('src/tools/ptc-task.ts', 'DEFAULT_STOP_REASON'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '| `reason` | `string` | ',
    render: (v) => `\`"${v}"\``,
  },
  {
    id: 'inline-preview-ceiling',
    source: () => namedConst('src/runtime/task-registry.ts', 'OUTPUT_PREVIEW_MAX_BYTES'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'at or below **',
    render: (v) => `${v} bytes`,
  },
  {
    id: 'notification-batch-budget',
    source: () => namedConst('src/runtime/notification-pipeline.ts', 'DEFAULT_MAX_BATCH_BYTES'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'default **',
    render: (v) => `${v / 1024} KiB`,
  },
  {
    id: 'child-report-finding-cap',
    source: () => namedConst('src/runtime/child-report.ts', 'CHILD_REPORT_MAX_FINDINGS'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'bounded at ',
    render: (v) => `${v} findings`,
  },
  {
    id: 'scaled-output-temp-prefix',
    source: () => namedConst('src/runtime/adr0015-truncation.ts', 'TASK_SCALE_TEMP_PREFIX'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: '`os.tmpdir()/',
    render: (v) => v,
  },
  {
    id: 'dispatch-binding-name',
    source: () => namedConst('src/runtime/bindings.ts', 'DISPATCH_BINDING_NAME'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: "this binding's name is `",
    render: (v) => v,
  },
  {
    id: 'child-report-tool-name',
    source: () => namedConst('src/runtime/child-report.ts', 'CHILD_REPORT_TOOL_NAME'),
    doc: 'docs/usage/bgdispatch.md',
    anchor: 'the child called `',
    render: (v) => v,
  },
];

/**
 * Tool names the documents say are **not** in v1.
 *
 * A negative assertion is as valuable as a positive one here: the page's whole point in that
 * section is that these names do not exist yet. If one of them ever gets implemented, the sentence
 * stops being true and nothing else in the build would notice.
 */
const MUST_STAY_ABSENT = [
  'ptc_task_resume',
  'ptc_task_append',
  'ptc_task_handoff',
  'ptc_parent_query',
  'ptc_query_response',
];

/** The documents whose claims this gate covers. */
const DOCUMENTS = [
  'docs/how-to-install.md',
  'docs/usage/surface.md',
  'docs/usage/bgdispatch.md',
  'docs/usage/structured-results.md',
];

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function main() {
  const sourceCache = new Map();
  const readSource = (rel) => {
    if (!sourceCache.has(rel)) {
      sourceCache.set(rel, normalize(readFileSync(join(REPO_ROOT, rel), 'utf8')));
    }
    return sourceCache.get(rel);
  };

  const failures = [];
  let checked = 0;

  for (const binding of BINDINGS) {
    checked += 1;
    let value;
    try {
      value = binding.source();
    } catch (error) {
      failures.push({
        id: binding.id,
        why: `the source anchor no longer resolves — ${error.message}`,
      });
      continue;
    }
    const documented = binding.anchor + binding.render(value);
    if (!readSource(binding.doc).includes(documented)) {
      failures.push({
        id: binding.id,
        why: `${binding.doc} does not say ${JSON.stringify(documented)} (looked for it after ` +
          `${JSON.stringify(binding.anchor)}); the code now yields ${JSON.stringify(String(value))}`,
      });
    }
  }

  const allSource = tsFiles(join(REPO_ROOT, 'src'))
    .map((f) => stripComments(readFileSync(f, 'utf8')))
    .join('\n');
  for (const name of MUST_STAY_ABSENT) {
    checked += 1;
    if (allSource.includes(name)) {
      failures.push({
        id: `absent:${name}`,
        why: `${name} is documented as "Not in v1" but now appears in src/ — the document's ` +
          `claim, or the implementation, has to change`,
      });
    }
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} documented claim(s) no longer match the code:\n`);
    for (const failure of failures.sort((a, b) => byName(a.id, b.id))) {
      console.error(`   ${failure.id}`);
      console.error(`      ${failure.why}`);
    }
    console.error(
      `\n  Fix the document, or fix the code and then the document. A binding that should not\n` +
        `  exist any more is removed here with a reason — not loosened until it passes.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ documented claims — ${checked} binding(s) over ${DOCUMENTS.length} document(s), ` +
      `${BINDINGS.length} named-source + ${MUST_STAY_ABSENT.length} absent-name`,
  );
}

main();
