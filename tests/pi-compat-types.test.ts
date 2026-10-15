/**
 * The pi-compat declarations cannot silently drift from upstream (#193, spec #192).
 *
 * `src/tools/pi-compat-types.ts` restates three things pi owns: the `ToolExposure` union and
 * the `outputSchema` / `exposure` / `defaultActive` fields. Those restatements exist because pi
 * 0.86.0 — the floor `package.json` declares — has none of them (measured: `grep -rn 'exposure'`
 * over its `dist/` returns 0 matches). What makes the restatement safe is not the comment next to
 * it; it is this file. A transcription can rot, and a rot here is invisible until a consumer on a
 * new pi gets a tool definition pi rejects.
 *
 * ## Why this is a test and not a comment
 *
 * The obvious assertion — `expectTypeOf<Local>().toEqualTypeOf<Real>()` — would be checked by
 * `tsc`, but **vitest strips types and never evaluates them**, so a wrong union compiles this file
 * to a passing test. A green suite would then be exactly the false pass this repo has been bitten
 * by before. So both halves of the contract are asserted against something that runs:
 *
 * 1. **The declarations, as text, against pi's own `.d.ts`** — read from the installed package and
 *    parsed here. Independent source (约束 #4): pi's file, not a constant in this repo.
 * 2. **The relationships, through the real `tsc`** — a probe file is generated and compiled by the
 *    installed TypeScript, and a diagnostic in it fails the test. This is what makes the
 *    counterfactual real: adding a sixth literal to the local union makes the probe fail, and the
 *    test goes red.
 *
 * ## What the counterfactual proves (约束 #5)
 *
 * Adding any literal the installed pi does not have to `ToolExposure` in `pi-compat-types.ts`
 * breaks probe P1 (local → real) and the test fails. Deleting a literal pi does have breaks P2
 * (real → local) and the test fails. Both directions are asserted, because a union that is only
 * ever checked one way is a copy that can drift in half the directions.
 *
 * ## The floor branch
 *
 * On pi below 0.99.0 pi exports no `ToolExposure` and declares none of the three fields, so there
 * is nothing to compare against — the probe is then built to assert the **absence** instead, which
 * is what licenses the local declarations to exist at all. That branch is a real assertion about
 * a real measurement (absent, with the `dist/` paths checked), never an early return: #195 and
 * #197 both reject `skipIf` on this repo precisely because a skipped test reads like a passing one.
 *
 * ## Expected values
 *
 * pi's `ToolExposure` is read from `dist/core/extensions/types.d.ts` at whatever line it sits, and
 * the three field types are read from the same file. The pins below are the ONLY literals in this
 * file, and each carries the measured line from pi 1.0.0 and 0.99.0 (`types.d.ts:388` for the
 * union; `:462` / `:466` / `:471` for the fields) so a reader can check them against the package
 * without running anything.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_TOOLS = join(TESTS_DIR, "..", "src", "tools");
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** pi's extension type module — the one place all three declarations live. */
const PI_TYPES_PATH = join(
  dirname_(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "core",
  "extensions",
  "types.d.ts",
);

function dirname_(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

const PI_TYPES_SOURCE: string = readFileSync(PI_TYPES_PATH, "utf8");

/**
 * pi's union, read out of its declaration source.
 *
 * Parsed rather than imported because the whole point of this file is to compare two copies, and
 * an imported type is erased before any of it runs. A regex over the one declaration line is enough
 * and cannot half-work: if pi rewords the declaration this returns `null` and the test fails with
 * the reason, which is the correct outcome — the local copy would then need re-reading.
 */
function readPiToolExposure(): readonly string[] | null {
  const decl = /export type ToolExposure = ([^;]+);/.exec(PI_TYPES_SOURCE);
  if (decl === null) return null;
  const body = decl[1] ?? "";
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** The declared type of one field on pi's `ToolDefinition`, verbatim. */
function readPiToolDefinitionField(field: string): string | null {
  const re = new RegExp("^\\s+" + field + "\\?:\\s*([^;]+);", "m");
  const m = re.exec(PI_TYPES_SOURCE);
  return m === null ? null : (m[1] ?? "").trim();
}

/**
 * Compile a probe with the installed TypeScript and return its diagnostics.
 *
 * The probe imports both the local declarations and pi's own, so it is compiled against the same
 * resolution a consumer gets. `--noEmit` keeps this side-effect free; a diagnostic mentioning the
 * probe file is the failure signal.
 */
function typecheckProbe(body: string): readonly string[] {
  // INSIDE the repo, not in tmpdir: the probe imports both this package's source and pi by bare
  // specifier, so it has to resolve against this repo's node_modules. A temp directory would make
  // every import TS2307 and the probe would assert nothing. `.scratch/` is already gitignored, so a
  // run killed between mkdtemp and the finally cannot leave an untracked directory behind.
  // `.scratch/` is gitignored and NOT copied into the floor probe tree (only src/ tests/ and the
  // manifests are), so the parent is created here rather than assumed.
  const scratch = join(REPO_ROOT, ".scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "pi-compat-probe-"));
  const file = join(dir, "probe.ts");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["probe.ts"],
    }),
  );
  writeFileSync(file, body);
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        join(dir, "tsconfig.json"),
      ],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return [];
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    return out
      .split("\n")
      .filter((l) => l.includes("probe.ts"))
      .map((l) => l.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Relative, so the probe resolves against the repo without needing tsconfig `paths`. The probe
// file sits at `.scratch/<tmp>/probe.ts`, so two levels up is the repo root.
const LOCAL_IMPORT = 'from "../../src/tools/pi-compat-types.ts"';
const PI_IMPORT = 'from "@earendil-works/pi-coding-agent"';

describe("pi-compat types track the installed pi (#193)", () => {
  const piExposure = readPiToolExposure();

  test("the local ToolExposure union is the installed pi's, in both directions", () => {
    if (piExposure === null) {
      // Floor branch: pi below 0.99.0 declares no union at all. The local copy is then not a
      // copy of anything, and the measurement that justifies it is the ABSENCE — asserted here
      // against pi's own dist, not assumed.
      expect(
        /exposure/i.test(PI_TYPES_SOURCE),
        "installed pi exports no ToolExposure; expected the concept to be absent from its dist",
      ).toBe(false);
      // The three fields are absent for the same reason and at the same boundary.
      for (const field of ["outputSchema", "exposure", "defaultActive"]) {
        expect(
          readPiToolDefinitionField(field),
          `installed pi declares no \`\${field}\` on ToolDefinition`,
        ).toBeNull();
      }
      return;
    }

    // Measured on pi 1.0.0 and 0.99.0 (dist/core/extensions/types.d.ts:388):
    //   "direct" | "model-only" | "codemode" | "deferred" | "hidden"
    expect(piExposure).toEqual(["direct", "model-only", "codemode", "deferred", "hidden"]);

    // P1 local -> pi, P2 pi -> local. Both directions, because one direction is not enough.
    const diagnostics = typecheckProbe(`
import type { ToolExposure as PiExposure } ${PI_IMPORT};
import type { ToolExposure as LocalExposure } ${LOCAL_IMPORT};

// P1: every local member is accepted by pi.
declare const local: LocalExposure;
const p1: PiExposure = local;

// P2: every pi member is accepted by the local union. This is the direction a
// narrowed copy fails: "deferred" is in pi and not in a two-literal local union.
declare const real: PiExposure;
const p2: LocalExposure = real;

export { p1, p2 };
`);
    expect(diagnostics).toEqual([]);
  });

  test("the local ToolDefinition fields carry the types pi gives them", () => {
    // Measured on pi 1.0.0 (dist/core/extensions/types.d.ts):
    //   :462  outputSchema?: TSchema
    //   :466  exposure?: ToolExposure
    //   :471  defaultActive?: boolean
    const expected: Record<string, string> = {
      outputSchema: "TSchema",
      exposure: "ToolExposure",
      defaultActive: "boolean",
    };

    for (const [field, upstreamType] of Object.entries(expected)) {
      if (piExposure === null) {
        // Floor: pi declares none of the three, which is the measurement that licenses the local
        // declarations. A real assertion about a real absence — not a skip.
        expect(
          readPiToolDefinitionField(field),
          `installed pi declares no \`\${field}\` on ToolDefinition`,
        ).toBeNull();
        continue;
      }
      expect(
        readPiToolDefinitionField(field),
        `pi 1.0.0 declares \`\${field}?: <type>\` (types.d.ts:462/466/471)`,
      ).toBe(upstreamType);
    }

    // The relationships themselves, through the installed tsc. Probes P3-P5 pair each local field
    // against the real ToolDefinition: a local value must be readable as pi's, and a pi value must
    // be readable as the local field type.
    const diagnostics = typecheckProbe(`
import type { ToolDefinition as PiToolDefinition } ${PI_IMPORT};
import type { CompatToolDefinition, ToolExposure as LocalExposure } ${LOCAL_IMPORT};
import type { TSchema } from "typebox";

declare const local: CompatToolDefinition<TSchema, unknown, unknown>;
declare const real: PiToolDefinition<TSchema, unknown, unknown>;

// P3: the local tool definition is usable wherever pi's is.
const p3: PiToolDefinition<TSchema, unknown, unknown> = local;

// P4: each of the three local fields carries pi's declared type. All three, not the two that
// happen to be convenient to name — a field left unprobed is a field that can drift silently.
const p4a: TSchema | undefined = local.outputSchema;
const p4b: LocalExposure | undefined = local.exposure;
const p4c: boolean | undefined = local.defaultActive;

// P5: a pi tool definition satisfies the local type too — the local extension is safe in both
// directions, which is what makes it sound rather than merely compiling.
const p5: CompatToolDefinition<TSchema, unknown, unknown> = real;

export { p3, p4a, p4b, p4c, p5 };
`);
    expect(diagnostics).toEqual([]);
  });
});

test("every tool declaration site routes through defineCompatTool, not pi's own defineTool", () => {
  // #192's core deliverable is that src/ compiles on pi 0.86.0. That is only true while the
  // three post-0.86.0 fields travel through OUR wrapper: pi's own defineTool accepts them on
  // 0.99.0+ and rejects them on the floor, so a site that quietly went back to pi's function
  // would compile here (the pinned pi is 1.0.0) and break only on the floor tree -- which the
  // default gate never runs. Measured: reverting child-report-tool.ts to pi's defineTool,
  // import and all, leaves `tsc` at 0 errors and 111 targeted tests green.
  //
  // So the migration is pinned here rather than left to the floor leg alone.
  //
  // The wrapper module is excluded: it calls pi's defineTool on purpose (that is what it
  // wraps), so a hit there is the seam itself rather than a site that skipped it.
  const files = readdirSync(SRC_TOOLS).filter(
    (f) => f.endsWith(".ts") && f !== "pi-compat-types.ts",
  );
  expect(files.length, "the scan has to find the tool modules").toBeGreaterThan(5);

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(SRC_TOOLS, file), "utf8");
    const calls = source.match(/\bdefineTool\s*\(/g) ?? [];
    if (calls.length > 0) {
      offenders.push(`${file}: ${calls.length} raw defineTool call(s)`);
    }
  }
  expect(
    offenders,
    "a raw pi defineTool call compiles on the pinned pi and breaks on the floor; route it " +
      "through defineCompatTool instead",
  ).toEqual([]);

  // The wrapper has to actually be used, or the guard above would pass on a tree where
  // nobody declares a tool at all.
  const wrapperUses = files.reduce((n, file) => {
    const source = readFileSync(join(SRC_TOOLS, file), "utf8");
    return n + (source.match(/\bdefineCompatTool\s*\(/g) ?? []).length;
  }, 0);
  expect(wrapperUses, "the compat wrapper has to have call sites").toBeGreaterThan(0);
});
