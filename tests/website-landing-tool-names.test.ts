/**
 * The landing page's tool-name gate has to see a name it does not recognise — and the page must
 * not carry one.
 *
 * The failure this guards is the one that shipped. `check-landing-tool-names.mjs` reads the built
 * landing page and compares every tool name it shows against the names this package registers. On
 * 2026-10-22 the page still taught `pi.dispatch` — the PTC door's name before ADR-0052 renamed it
 * to `pi_task_ptc` — and the gate printed "8 claim(s) against 8 registered tool(s)" and exited 0.
 *
 * Why it was blind: the gate's name family was `(?:ptc|pi_task)_[a-z0-9_]+`, and a dotted name
 * matches neither. The gate had no opinion about the one name shape the page had been wrong
 * about, and a name it cannot recognise is a name it silently accepts.
 *
 * 口径 (why these assertions are these assertions, and not chosen):
 *
 *   - **The real script is run, not a copy of its rules.** A test that re-implements the gate's
 *     rules tests the re-implementation: it can stay green while the gate stays blind. So the test
 *     copies the actual script into a throwaway tree, gives it the two things it reads — `src/`
 *     for the registered names and a built `index.html` for the page's claims — and runs it. The
 *     script resolves the repository root from its own location, which is what makes the copy
 *     work at all, and nothing in the repository is written to.
 *   - **Both paths of the IO boundary.** A page naming only registered names must stay green
 *     (otherwise the gate is an "always red" that detects nothing), and a page naming a retired
 *     or unrecognised name must go red.
 *   - **A crash is not a detection.** The red cases assert on the message as well as the exit
 *     code, so a script that died on an exception — `src/` missing, say — cannot satisfy them.
 *   - **The retired list is read out of the script, not copied here.** A second copy of that list
 *     is a liability: it goes stale silently, and the test keeps passing against a name the gate
 *     no longer knows. The extraction is pinned by a floor assertion, because an extractor that
 *     returns nothing would make the page assertion below compare the empty set against itself.
 *   - **The page assertion reads the template, not the build.** The built page is a build
 *     artifact and does not exist when the root suite runs; the template is what a developer
 *     edits, and it is tracked in git.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHECK_SCRIPT = join(
  REPO_ROOT,
  "packages",
  "website",
  "scripts",
  "check-landing-tool-names.mjs",
);
const LANDING_SOURCE = join(REPO_ROOT, "packages", "website", ".vitepress", "theme", "Landing.vue");

/**
 * The retired name, as a literal.
 *
 * A real sample from this package's own history rather than a fixture: `pi.dispatch` was the PTC
 * door's name before ADR-0052 renamed it to `pi_task_ptc`.
 */
const RETIRED_NAME = "pi.dispatch";

/** What replaced it — the name the failure message has to point the reader at. */
const REPLACEMENT = "pi_task_ptc";

/** The check script's retired-name registry, read out of the script's own text. */
const RETIRED_BLOCK = /const RETIRED_NAMES = new Map\(\[([\s\S]*?)\]\);/;
/**
 * One registry entry. The `[` before the quoted name is what makes it an entry and not the
 * reason string that follows it — the reasons are quoted text too, and a pattern that matched
 * both would report a reason as a name.
 */
const RETIRED_ENTRY = /\[\s*"([^"]+)"\s*,/g;

/** Every name the gate treats as retired, read from the gate's own registry. */
function retiredNames(): string[] {
  const source = readFileSync(CHECK_SCRIPT, "utf8");
  const block = source.match(RETIRED_BLOCK)?.[1] ?? "";
  return [...block.matchAll(RETIRED_ENTRY)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Run the real gate against a synthetic built landing page.
 *
 * The script resolves the repository root from its own location, so it is copied into a throwaway
 * tree with the two things it reads. The copy is what makes the run possible; the repository is
 * untouched.
 */
function runGate(pageHtml: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "ptc-landing-tool-names-"));
  try {
    const scripts = join(dir, "packages", "website", "scripts");
    const dist = join(dir, "packages", "website", ".vitepress", "dist");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(dist, { recursive: true });
    cpSync(CHECK_SCRIPT, join(scripts, "check-landing-tool-names.mjs"));
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    writeFileSync(join(dist, "index.html"), pageHtml);

    const run = spawnSync(process.execPath, [join(scripts, "check-landing-tool-names.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
    return { code: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A page that names only names this package registers, and every name the gate requires.
 *
 * `MUST_APPEAR` is `ptc_run_code`, `ptc_task_*`, `ptc_workflow` and `pi_task_*`; a wildcard
 * requirement is satisfied by any claim under its prefix, so the individual names below are
 * enough to reach a green run.
 */
const CLEAN_PAGE = [
  "<html><body>",
  "<p><code>ptc_run_code</code> <code>ptc_workflow</code></p>",
  "<p><code>pi_task_ptc</code> <code>pi_task_codemode</code></p>",
  "<p><code>ptc_task_list</code> <code>ptc_task_output</code> <code>ptc_task_stop</code></p>",
  "</body></html>",
].join("\n");

describe("the landing page's tool-name gate sees the names it cannot recognise", () => {
  test("a page naming only registered tools stays green", () => {
    const gate = runGate(CLEAN_PAGE);
    expect(gate.code, gate.out).toBe(0);
  });

  test("a page naming a retired tool goes red, and says what to write instead", () => {
    const gate = runGate(CLEAN_PAGE.replace("</body>", `<code>${RETIRED_NAME}</code></body>`));
    expect(gate.code, gate.out).not.toBe(0);
    expect(gate.out).toContain(RETIRED_NAME);
    // The failure has to be classified, not merely reported: "retired" is the difference between
    // "this name was renamed" and "this name was never ours", and the reader acts on it.
    expect(gate.out).toContain("retired");
    expect(gate.out).toContain(REPLACEMENT);
  });

  test("a page naming an unrecognised name in the package's namespace goes red too", () => {
    // The general half of the fix: a name the gate does not recognise is not silently accepted,
    // whether or not somebody remembered to list it as retired.
    const gate = runGate(CLEAN_PAGE.replace("</body>", "<code>pi.not_a_door</code></body>"));
    expect(gate.code, gate.out).not.toBe(0);
    expect(gate.out).toContain("pi.not_a_door");
  });

  test("the retired-name registry is not empty — 抽取器失效必须红", () => {
    expect(retiredNames().length).toBeGreaterThan(0);
  });

  test("the landing page names no retired tool", () => {
    const page = readFileSync(LANDING_SOURCE, "utf8");
    const named = retiredNames().filter((name) => page.includes(name));
    expect(named, `the landing page names a retired tool: ${named.join(", ")}`).toEqual([]);
  });
});
