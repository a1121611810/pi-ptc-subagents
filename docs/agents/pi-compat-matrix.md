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

## Capability matrix — every published version from 0.86.0 to latest

Probed 2026-10-14 across **all 14 published versions** (each installed into its own tree, then
statically probed over the installed artifacts by
`.scratch/prototype-pi086-runtime/capability-probe.mjs`; the 0.86.1 / 0.99.0 / 1.0.0 / 1.2.0
columns additionally runtime-verified by `probe-runtime.mjs` loading the real built dist).

| capability point                                           | 0.86.0 | 0.86.1 | 0.87.0 | 0.87.1 | 0.99.0 | 0.99.1 | 0.99.2 | 1.0.0 | 1.0.1 | 1.0.2 | 1.0.3 | 1.0.4 | 1.1.0 | 1.2.0 |
| ---------------------------------------------------------- | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `AgentToolResult.isError` + bash uses it                   | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `ToolDefinition.outputSchema`                              | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `ToolDefinition.exposure` field                            | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| agent-session honors exposure (`_getToolExposure`)         | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| agent-loop forwards `structuredContent`                    | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| codemode ships (`extensions/codemode`)                     | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| MCP extension + codemode auto-enable                       | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| extension patterns through `normalizePath` (tilde/file://) | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     |
| codemode declares `reachesTools`                           | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     |
| `BeforeAgentStartEvent` is a `messageType` union           | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     |
| `ToolRenderContext.durationMs` + `outputPad`               | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| `registerToolRenderer` API                                 | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `-p` truncated response exits 1                            | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     |
| `formatSkillsForPrompt` supports `"indirect"`              | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     | ✓     |
| published settings schema (`schemas/`)                     | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     |
| `--tools` keeps MCP tools unless `mcp__` entry             | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     | ✓     |
| **this package typechecks**                                | ✗      | ✗      | ✗      | ✗      | **✓**  | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |

Three corrections this table forced, all caught by measuring instead of citing:

1. **The capability floor is 0.99.0, not 1.0.0.** Every API this package's ADRs attribute to
   "pi 1.0.0" (`isError`, `outputSchema`, `exposure`, the `structuredContent` forward,
   codemode itself, MCP auto-enable) is already present in 0.99.0 — and our source typechecks
   with ZERO errors against 0.99.0 (bisected: 0.87.1 = 9 errors, 0.99.0 = 0), and the runtime
   probe passes on it. The ADRs' "1.0.0" citations name where the MEASUREMENTS were taken, not
   where the API appeared.
2. **0.86.x/0.87.x fail the gate but not the runtime.** Their gap is type-level only; the
   built dist loads and the full surface registers on 0.86.1 (probed).
3. **The 1.2.0-only features are smaller than the changelog suggests**: `normalizePath` on
   patterns, `reachesTools`, the `messageType` union, exit-1 truncation, and the published
   schemas — each inert or handled for this package (see the 1.2.0 section below).

### The gate and the declared floor

pi 0.86.x/0.87.x fail typecheck with **9 errors in two classes** — `ToolExposure` not exported,
`outputSchema`/`exposure`/`defaultActive` not on `ToolDefinition`, plus the same names reaching
the tests (`ExtensionToolContext`, `AgentToolResult.structuredContent`). These are compile-time
gaps; the runtime rows above pass there.

**Conclusion: the real floor is 0.99.0, for the gate and for runtime alike.** The matrix reports
the floor failure as a failing `typecheck` row instead of hiding it. Whether to narrow
`peerDependencies` to `>=0.99.0` (matching reality) or keep `>=0.86.0` and document 0.86.x/0.87.x
as installable-but-type-broken is a product decision this script deliberately does not make.

### The 1.0.x → 1.2.0 finding: green, with upstream behaviours worth knowing

pi 1.2.0 passes every step. What it shipped that touches this package: `normalizePath` on
extension patterns (inert for the codemode answer — measured and documented in
`src/mode/ptc-mode.ts`), a `reachesTools` gate on MCP auto-enable (inert for pi's own codemode),
and `read` growing an `outputSchema` (our binding projection drops `structuredContent`, so the
program-visible shape is unchanged). The one real behavioural change — print-mode exiting 1 on a
truncated response — is handled by `truncationFailureMessage` in `src/runtime/dispatch.ts`.

### Feature-level matrix: this package own surface, measured per version (the real answer)

Static capability probes say what pi HAS; they do not say what this package DOES. That needs a
second probe: drive the real built dist through factory + session_start + /ptc + a real PTC
program, per version (destination `.scratch/prototype-pi086-runtime/surface-probe.mjs`, driven across all 14
trees by `run-surface-matrix.mjs`; measured 2026-10-14). Fourteen versions times fifteen features =
210 checks, all pass - including on the two type-broken 0.86.x/0.87.x versions:

| feature                                                          | 0.86.0-0.87.1        | 0.99.0-1.2.0           |
| ---------------------------------------------------------------- | -------------------- | ---------------------- |
| dist loads; factory + session_start register all six tools       | pass x4              | pass x10               |
| surface=full: programming pair direct (declared to model)        | pass                 | pass                   |
| /ptc command registered; on narrows read/bash out; off restores  | pass                 | pass                   |
| ADR-0011 skills section restored while narrowed                  | pass                 | pass                   |
| PTC program: tools.read / tools.bash / write-read roundtrip      | pass                 | pass                   |
| failing tools.bash REJECTS, capped at 2000 chars, exit code kept | pass (throw channel) | pass (isError channel) |
| pi.dispatch refuses unknown agent without spawning               | pass                 | pass                   |
| ptc_task_list / ptc_child_report / renderers                     | pass                 | pass                   |
| subagents branch (independent; driven with subagents inputs)     | pass x4              | pass x10               |

### The subagents branch is INDEPENDENT - it exists on every version

An earlier draft of this section recorded the subagents branch as "n/a - no codemode" on the
pre-codemode versions. That was a PROBE error, not a fact: it conflated two independent things.
The branch is selected by `detectedSurfaceMode` (ptc-mode.ts:1127), a pure function of three
probe answers - presence, switch, activation - and none of those is "which pi is running".
What varies per version is one INPUT: presence, read off the real pi entry by
`probeCodemodePresence`. The decision (and the registration it produces) is this package own code
and must be exercised on every version by feeding it the inputs that select it.

Measured with `surface-decision-probe.mjs` across all 14 trees: driving the decision with
subagents-selecting inputs yields "subagents" on EVERY version, and on every version that
resolves to registering `ptc_subagent` with `ptc_run_code` at `codemode` reach:

| version                           | presence (read from real pi) | decision with subagents inputs | driven by the real pi | ptc_subagent registered |
| --------------------------------- | ---------------------------- | ------------------------------ | --------------------- | ----------------------- |
| 0.86.0 / 0.86.1 / 0.87.0 / 0.87.1 | not-found (no codemode dir)  | subagents x4                   | full x4               | true x4                 |
| 0.99.0 - 1.2.0                    | found                        | subagents x10                  | subagents x10         | true x10                |

The last two columns are the honest split. The decision resolves "subagents" on all 14 because
the decision is ours; it only resolves "subagents" WHEN DRIVEN BY THE REAL PI on 0.99.0+, because
only those pis have a codemode directory for the presence input to find. On 0.86.x/0.87.x the
real-pi inputs correctly land on "full" - the package own PTC face - which is the surface
convention working, not a missing branch.

Probe finding recorded: `detectedSurfaceMode` is not re-exported from the built dist (only the
factory-level `detectSurfaceMode` is), so a probe must drive it through that seam - which is what
this measurement does, and is the reason an earlier probe substituted the presence check for the
decision check.

The two pre-codemode columns are the point, verified: with no codemode the package registers
its OWN PTC face as direct, /ptc works, programs run, and the only N/A is the subagents branch -
which cannot exist where there is no codemode to hand off to. The 0.86.x F7 row passes through
the THROW channel (pi throws; our catch caps it, #190); the 0.99.0+ rows through the isError
channel: two routes, one cap, one shape.

### The < 1.0.0 (and 0.99.0) runtime note: two bounded known limitations

An earlier draft recorded the prototype's first cost model - three degradations - and it was
WRONG on two of three, because it missed the surface convention: on a pi without `codemode`
(0.86.x/0.87.x), the detected surface is `full`, and `src/index.ts` registers the programming
pair as `exposure: "direct"` - declared to the model - which is exactly what the package's own
PTC face is supposed to do. Measured (prototype probe, real 0.86.1 tree): `ptc_run_code` /
`ptc_workflow` register `direct`, all six tools register, and the built dist loads. What actually
differs on a pre-codemode pi:

1. **The bash binding failure message bypassed our 2000-char cap on the throw path.** Pre-0.99.0
   there is no `isError` channel - a failing builtin THROWS with its own text - and the binding
   wrapper had no catch there. Measured: a 5 KB failing output reached the program as a
   5051-char rejection, head intact (0.99.0+ resolve through `isError` and arrive capped at
   2014, head dropped). **Fixed** (#190): the binding's catch routes thrown failures through the
   same `bindingFailureMessage`, so both failure channels share one cap and one shape.
2. **ADR-0032's child-report tool channel is dead on < 0.99.0.** pi-agent-core 0.86.x/0.87.x
   does not forward `structuredContent` on `tool_execution_end`, so
   `extractChildReportFromToolEvent` never fires. The `prompt-json` channel is independent (it
   scans the assistant text) and still delivers, so reports arrive via the fallback and
   `reportChannel` reads `"prompt-json"`. Not fixable here - the missing forward is upstream.

Not a cost, worth stating so it is never re-classified as one: `structuredContent` is documented
as not-sent-to-the-model, and on a pre-codemode pi the only programmatic caller (codemode) does
not exist - so its absence is invisible to the model. Evidence: the prototype probe and its
verdict (`.scratch/prototype-pi086-runtime/`, `VERDICT.md` v2; `probe-runtime.mjs` loads the
real built dist against a real installed tree through a realpath-resolving module loader).

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

Add it to `PI_COMPAT_VERSIONS` in `scripts/pi-compat-matrix.mjs` **and add a column to the
capability table above** (probe the installed tree with
`.scratch/prototype-pi086-runtime/capability-probe.mjs` — one install, sixteen one-line answers).
Keep the list ascending — a guard test (`tests/unit/pi-compat-matrix.test.ts`) pins the floor,
uniqueness, and ordering. The floor stays: it is the claim `peerDependencies` makes. The
capability table is the exhaustive version-by-version record; the script's list is the curated
set the gate re-measures on demand.
