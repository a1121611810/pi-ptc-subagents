/**
 * Meta-discipline fixture: scans every .test.ts in this repo for false-pass patterns
 * (F1 / F2 / F3 / F4 in docs/testing-constraints.md) and fails the build if any are found.
 *
 * This fixture exists because the project once shipped a false-pass test (dispatch-e2e.test.ts)
 * that accepted `status: 'fulfilled' | 'rejected'` — a characterization test, not a
 * specification test — so it could pass on both happy and broken paths. The fixture's job
 * is to make that mistake impossible to ship again.
 *
 * Patterns detected (must reference docs/testing-constraints.md):
 *   F1: accept-both assertion     expect(X).toMatch(/^(A|B)$/)
 *   F2: conditional assertion     if (...) { expect(...) }
 *   F3: opt-in gate early-return  if (process.env.X !== '1') { return; }
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const TESTS_DIR = join(REPO_ROOT, "tests");
const SKIP_FILES = new Set(["test-meta-discipline.test.ts"]);

interface Finding {
  file: string;
  line: number;
  kind: "F1" | "F2" | "F3" | "F4";
  snippet: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (
      entry === ".DS_Store" ||
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "coverage"
    )
      continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function findF1(content: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines: string[] = content.split("\n");
  const re = /expect\s*\(\s*[^)]+\s*\)\s*\.toMatch\s*\(\s*\/([^/]+)\/\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    const ln: string = lines[i] ?? "";
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ln)) !== null) {
      const body = m[1] ?? "";
      if (/\|/.test(body) && /\(/.test(body) && /\)/.test(body)) {
        const trimmed = body.trim();
        if (trimmed.startsWith("^(") && trimmed.endsWith(")$")) {
          out.push({ file, line: i + 1, kind: "F1", snippet: ln.trim() });
        }
      }
    }
  }
  return out;
}

function findF2(content: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines: string[] = content.split("\n");
  const reIf = /\bif\s*\([^)]*\b(?:status|result|response|outcome)\b[^)]*\)\s*\{/g;
  for (let i = 0; i < lines.length; i++) {
    const ln: string = lines[i] ?? "";
    if (!reIf.test(ln)) continue;
    let depth = 0;
    let foundExpect = false;
    for (let j = i; j < lines.length && j < i + 30; j++) {
      const jl: string = lines[j] ?? "";
      depth += (jl.match(/{/g) ?? []).length;
      depth -= (jl.match(/}/g) ?? []).length;
      if (/expect\s*\(/.test(jl)) foundExpect = true;
      if (depth <= 0 && j > i) break;
    }
    if (foundExpect) out.push({ file, line: i + 1, kind: "F2", snippet: ln.trim() });
  }
  return out;
}

/**
 * F4: a test body that reaches the next declaration without an expect.
 *
 * The window is "this declaration line to the next declaration at the same
 * indentation", not a brace match. A brace matcher was tried first and produced
 * 24 false positives across this repository, because `test` also appears inside
 * regexes and helper names. A checker that cries wolf on 24 real files is worse
 * than no checker, so the simpler and dumber rule is the one that ships.
 */
function findF4(content: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines = content.split("\n");
  const reDecl = /^(\s*)(?:test|it)(?:\.each)?\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = reDecl.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = m[1] ?? "";
    if (indent.length === 0) continue;
    let asserted = false;
    for (let j = i; j < lines.length; j++) {
      const jl = lines[j] ?? "";
      if (j > i && reDecl.test(jl) && (jl.match(/^(\s*)/)?.[1] ?? "") === indent) break;
      // Any call whose name mentions expect or assert: a test that delegates its
      // assertion to a helper -- assertSitesAgree(x) -- is still asserting.
      if (/\w*(?:expect|assert)\w*\s*\(/.test(jl)) asserted = true;
    }
    if (!asserted) {
      out.push({ file, line: i + 1, kind: "F4", snippet: (lines[i] ?? "").trim().slice(0, 90) });
    }
  }
  return out;
}

function findF3(content: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines: string[] = content.split("\n");
  // Allow digits in env var names (e.g. PT_DISPATCH_E2E)
  const reGate = /\bif\s*\(\s*process\.env\.[A-Z0-9_]+\s*[!=]==?\s*['"][^'"]+['"]/g;
  for (let i = 0; i < lines.length; i++) {
    const ln: string = lines[i] ?? "";
    if (!reGate.test(ln)) continue;
    let depth = 0;
    let foundReturn = false;
    for (let j = i; j < lines.length && j < i + 40; j++) {
      const jl: string = lines[j] ?? "";
      depth += (jl.match(/{/g) ?? []).length;
      depth -= (jl.match(/}/g) ?? []).length;
      if (depth <= 0 && j > i) break;
      if (/\breturn\s*;/.test(jl)) foundReturn = true;
    }
    if (foundReturn) out.push({ file, line: i + 1, kind: "F3", snippet: ln.trim() });
  }
  return out;
}

describe("test-meta-discipline", () => {
  const files = walk(TESTS_DIR).filter((f) => !SKIP_FILES.has(f.split("/").pop() ?? ""));

  test("every .test.ts is scanned", () => {
    expect(files.length).toBeGreaterThan(0);
    console.log("[meta-discipline] scanning", files.length, "test files");
  });

  test("F1: no accept-both assertions", () => {
    const findings: Finding[] = [];
    for (const f of files) {
      const c = readFileSync(f, "utf-8");
      findings.push(...findF1(c, f));
    }
    if (findings.length > 0) {
      console.error("[meta-discipline] F1 accept-both findings:");
      for (const fd of findings) {
        console.error("  ", relative(REPO_ROOT, fd.file) + ":" + fd.line, "—", fd.snippet);
      }
    }
    expect(findings, "F1 accept-both assertions found (see logs)").toEqual([]);
  });

  test("F2: no conditional assertions", () => {
    const findings: Finding[] = [];
    for (const f of files) {
      const c = readFileSync(f, "utf-8");
      findings.push(...findF2(c, f));
    }
    if (findings.length > 0) {
      console.error("[meta-discipline] F2 conditional-assert findings:");
      for (const fd of findings) {
        console.error("  ", relative(REPO_ROOT, fd.file) + ":" + fd.line, "—", fd.snippet);
      }
    }
    expect(findings, "F2 conditional assertions found (see logs)").toEqual([]);
  });

  test("F3: no opt-in gate early-return", () => {
    const findings: Finding[] = [];
    for (const f of files) {
      const c = readFileSync(f, "utf-8");
      findings.push(...findF3(c, f));
    }
    if (findings.length > 0) {
      console.error("[meta-discipline] F3 opt-in-gate findings:");
      console.error("  (Policy: no opt-in gate; use test.skipIf(...) instead.)");
      for (const fd of findings) {
        console.error("  ", relative(REPO_ROOT, fd.file) + ":" + fd.line, "—", fd.snippet);
      }
    }
    expect(findings, "F3 opt-in gate findings (use test.skipIf instead)").toEqual([]);
  });

  test("F4: no test body without an assertion", () => {
    // Three false-pass guards in this repo's review ledger all reached a state
    // F1/F2/F3 cannot see: the test kept its name, the body kept a comment saying
    // what it should do, and nothing asserted. vitest reports that as passed.
    const findings: Finding[] = [];
    for (const f of files) {
      const c = readFileSync(f, "utf-8");
      findings.push(...findF4(c, f));
    }
    if (findings.length > 0) {
      console.error("[meta-discipline] F4 assertion-free test bodies:");
      for (const fd of findings) {
        console.error("  ", relative(REPO_ROOT, fd.file) + ":" + fd.line, "—", fd.snippet);
      }
    }
    expect(findings, "F4 test bodies with no assertion (see logs)").toEqual([]);
  });
});
