# pi compatibility matrix

`pnpm run compat:pi` runs this repo's gate against more than one version of pi. It exists
because the package makes a RANGE claim it never measured:

- `peerDependencies` declares `@earendil-works/pi-coding-agent: ">=0.86.0"`;
- `devDependencies` pins `^1.0.0`, so the default gate measures one point of that range;
- the project's stated policy is to track new pi releases, so the ceiling moves.

The matrix measures the ends. It is **not** part of the default gate: each version needs its own
full install (~30-60 s each), which would multiply every contributor's gate by the matrix length
for coverage the pinned version already provides. Run it when pi ships a release, when the peer
range changes, or when a diff touches something the installed pi mediates (the codemode probes,
the binding contract, tool visibility).

## What a run does, per version

1. Copies the repo into a scratch directory under the OS temp dir. The copy is deliberately
   COMPLETE — see [what the copy must include](#what-the-copy-must-include-each-item-is-a-measured-failure) below.
2. Rewrites the three `@earendil-works/*` devDependencies to the version, and pins the whole
   transitive `@earendil-works/*` family to the same version through `pnpm-workspace.yaml`.
3. Installs with `--no-frozen-lockfile` (the repo's own lockfile is NOT copied — see below).
4. Runs, in order: `tsc --noEmit` → `oxlint` → `oxfmt --check` → **build** → a
   version-sensitive test subset → `verify-dist-render`.
5. Prints one row per step and exits non-zero if any step failed. Rows are per step, not a
   single pass/fail, because a floor failure reads very differently from a regression.

## Results as of 2026-10-14 (this repo at 695d2ba + the pi-1.2.0 compatibility work)

| step        | pi 0.86.1 | pi 1.0.0 (pin) | pi 1.2.0 |
| ----------- | --------- | -------------- | -------- |
| install     | pass      | pass           | pass     |
| typecheck   | **FAIL**  | pass           | pass     |
| lint        | pass      | pass           | pass     |
| fmt:check   | pass      | pass           | pass     |
| build       | pass      | pass           | pass     |
| tests       | **FAIL**  | pass           | pass     |
| verify:dist | pass      | pass           | pass     |

### The 0.86.1 finding: the declared floor is below the real floor

pi 0.86.1 fails typecheck with **9 errors in two classes**, all of them "this pi does not have
the API yet" rather than "our code is wrong":

- `TS2305`: `ToolExposure` is not exported (`src/tools/run-code.ts:24`, `src/tools/workflow.ts:25`);
- `TS2353`: `outputSchema` does not exist on `ToolDefinition` (`src/tools/child-report-tool.ts:156`,
  `src/tools/ptc-task.ts:229/470/629`, `src/tools/subagent.ts:291`), same for the `exposure` field
  (`run-code.ts:163`, `workflow.ts:240`);
- plus the same two names reaching the tests (`ExtensionToolContext`,
  `AgentToolResult.structuredContent`, `ToolDefinition.defaultActive`).

Both APIs arrived in pi **1.0.0**, and the package's own ADRs are built on them (ADR-0028
structured results; ADR-0025/0029 the codemode exposure). The runtime export surface on 0.86.1
is otherwise complete — every function `src/` imports resolves there — so the gap is exactly
those two type-level features.

**Conclusion: the real floor is 1.0.0, not 0.86.0.** This script reports that as a failing
`typecheck` row instead of hiding it. Whether to narrow `peerDependencies` to `>=1.0.0` (and
re-measure what 0.86.x actually needs), or to add version-conditional code paths, is a product
decision this script deliberately does not make for you.

### The 1.2.0 finding: green, with one upstream behaviour worth knowing

pi 1.2.0 passes every step. The changes it shipped that touch this package — `normalizePath` on
extension patterns (inert for the codemode answer, measured and documented in
`src/mode/ptc-mode.ts`), a `reachesTools` gate on MCP auto-enable (inert for pi's own codemode),
and `read` growing an `outputSchema` (our binding projection drops `structuredContent`, so the
program-visible shape is unchanged) — are all covered by the suite. The one real behavioural
change, print-mode exiting 1 on a truncated response, is handled by `truncationFailureMessage`
in `src/runtime/dispatch.ts`.

### The 0.86.1 finding: runs, by design, with two bounded known limitations

An earlier draft of this section recorded the prototype's first cost model - three
degradations - and it was WRONG on two of three, because it missed the surface convention: on a
pi without `codemode`, the detected surface is `full`, and `src/index.ts` registers the
programming pair as `exposure: "direct"` - declared to the model - which is exactly what the
package's own PTC face is supposed to do. Measured (prototype probe, real 0.86.1 tree):
`ptc_run_code` / `ptc_workflow` register `direct`, all six tools register, and the built dist
loads. What remains:

1. **The bash binding failure message bypassed our 2000-char cap on the throw path.** pi 0.86.x
   has no `isError` channel - a failing builtin THROWS with its own text - and the binding
   wrapper had no catch there. Measured: a 5 KB failing output reached the program as a 5051-char
   rejection, head intact (1.0.0+ arrive capped at 2014, head dropped). **Fixed** (#190): the
   binding's catch routes thrown failures through the same `bindingFailureMessage`, so both
   failure channels share one cap and one shape.
2. **ADR-0032's child-report tool channel is dead on < 1.0.0.** pi-agent-core 0.86.1 does not
   forward `structuredContent` on `tool_execution_end`, so `extractChildReportFromToolEvent`
   never fires. The `prompt-json` channel is independent (it scans the assistant text) and still
   delivers, so reports arrive via the fallback and `reportChannel` reads `"prompt-json"`. Not
   fixable here - the missing forward is upstream.

Not a cost, worth stating so it is never re-classified as one: `structuredContent` is documented
as not-sent-to-the-model, and on 0.86.x the only programmatic caller (codemode) does not exist -
so its absence is invisible to the model. Evidence: the prototype probe and its verdict
(`.scratch/prototype-pi086-runtime/`, `VERDICT.md` v2; the probe loads the real built dist
against a real 0.86.1 tree through a realpath-resolving module loader).

The typecheck row's failure on 0.86.1 is compile-time only (missing `.d.ts` names: `ToolExposure`,
`ToolDefinition.outputSchema`, `AgentToolResult.structuredContent`); the runtime rows pass. The
real floor for the GATE is 1.0.0; the real floor for RUNNING is 0.86.x.

## What the copy must include (each item is a measured failure)

- `.git/` — `tests/doc-integrity.test.ts` resolves the commit SHAs its ledger cites through real
  history and feeds `git ls-files` into its basename-resolution baseline.
- `.codegraph/.gitignore` — doc-integrity's third baseline treats a basename as "unique in the
  repo"; without this file `.gitignore` is no longer a duplicate and the "ambiguity returns
  null" test goes red.
- `docs/`, `README.md`, `AGENTS.md`, `CONTEXT.md` — doc-integrity walks them.
- `.opencodereview/` — `tests/ocr-anchor-coverage.test.ts` reads the rule anchors.
- `.github/` — `tests/action-sha-consistency.test.ts` and `tests/site-checks-on-pr.test.ts`.
- `LICENSE` — `README.md` links it (doc-integrity's link check).
- `package.json` copied BYTE-FOR-BYTE — `tests/e2e/bgdispatch.test.ts` asserts the package name,
  and a JSON.parse/Stringify rewrite changes key order enough for `oxfmt --check` to fail.
- `scripts/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.oxlintrc.json`,
  `.oxfmtrc.json`, `pnpm-workspace.yaml` — the gate itself.
- **NOT** `pnpm-lock.yaml`. The matrix's whole point is a different resolution: with the lockfile
  present, pnpm re-pins the transitive pi family and the version under test never actually
  installs. Measured: the first run with a copied lockfile installed pi-codemode@1.2.0 under
  pi-coding-agent@1.0.0 and both `skills-section.test.ts` and `verify-dist-render` died on the
  removed `MCP_TYPESCRIPT_PREAMBLE` import.

## Transitive pinning goes to pnpm-workspace.yaml, not package.json

The `@earendil-works/*` family releases in lockstep, and pi-coding-agent imports its siblings
directly (`codemode/tool.js` imports `MCP_TYPESCRIPT_PREAMBLE` from `pi-codemode`). pnpm v10+
reads `overrides` from **pnpm-workspace.yaml** when the repo is a workspace; an `overrides`
block written into package.json is silently ignored (measured: pi-codemode@1.2.0 still installed
under pi 1.0.0). The script therefore appends an `overrides:` block to the scratch's copied
`pnpm-workspace.yaml`.

## Ordering: build before tests

`tests/tool-visibility.test.ts` spawns a real pi against the built `dist/index.js`. Running the
tests before the build reports "the probe never observed a provider request", which reads as a
product defect and is actually a missing artifact. Measured on the first run; the script builds
first.

## Adding a version

Add it to `PI_COMPAT_VERSIONS` in `scripts/pi-compat-matrix.mjs`. Keep the list ascending — a
guard test (`tests/unit/pi-compat-matrix.test.ts`) pins the floor, uniqueness, and ordering. The
floor stays: it is the claim `peerDependencies` makes.
