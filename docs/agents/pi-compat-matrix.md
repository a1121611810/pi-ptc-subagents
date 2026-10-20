# pi compatibility matrix

`pnpm run compat:pi` runs this repo's gate against more than one version of pi. It exists
because the package makes a RANGE claim it never measured:

- `peerDependencies` declares `@earendil-works/pi-coding-agent: ">=0.86.0"`;
- `devDependencies` pins `1.3.0` (as of 2026-10-20), so the default gate measures one point of
  that range;
- the project's stated policy is to track new pi releases, so the ceiling moves.

**Those are three numbers, and the one on your PATH is a fourth.** `node_modules/@earendil-works/pi-coding-agent/package.json`
records what the dependency tree resolved to; `pi --version` records what a user's terminal runs;
neither is the declared floor and neither is necessarily the same as the other. Check both before
saying what "pi does" — a claim read off `node_modules` describes the tree, not the machine. This
is not hypothetical: a 2026-10-19 review asserted a capability was impossible, quoting 1.0.0 from
`node_modules`, while the operator was running 1.3.0, where the same question had a different
answer. The reader-visible version of that mistake is a wrong answer delivered with a file path
attached, which is the most convincing shape a wrong answer takes.

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
   version-sensitive test subset → **the throw-path leg** → `verify-dist-render`.
5. Prints one row per step and exits non-zero if any step failed. Rows are per step, not a
   single pass/fail, because a floor failure reads very differently from a regression. Rows come
   in three states — `pass` / `skip` / `FAIL` — because one of them (`skip`, the throw-path leg
   on any pi >= 0.99.0) is neither a pass nor a failure, and collapsing it into `pass` is the
   defect this row exists to prevent (see [below](#the-last-two-rows-of-that-table-are-different-claims-and-only-one-of-them-runs)).

## Capability matrix — every published version from 0.86.0 to latest

Probed 2026-10-14 across the **14 versions published at that date** (each installed into its own
tree, then statically probed over the installed artifacts by the throwaway probe
`../research/pi-compat-probes-20261014/capability-probe.mjs`; the 0.86.0 / 0.86.1 / 0.99.0 / 1.0.0 /
1.2.0 columns additionally runtime-verified by `probe-runtime.mjs` loading the real built dist).
Those probes are one-off prototypes kept in
[`docs/research/pi-compat-probes-20261014/`](../research/pi-compat-probes-20261014/) — they are the
evidence behind this table, and nothing in the gate depends on them still being there.

**1.3.0 was added 2026-10-20**, when pi published it (the 15th version in this range). Its column
is a measurement of the same kind, not an inference from 1.2.0: a 1.3.0 tree was installed on its
own and the same `capability-probe.mjs` was run over it, and it answered **✓ on all sixteen
capability points** — identical to 1.2.0. 1.3.0 is also the version this repo now pins, and
`pnpm run compat:pi 1.3.0` passes every step on it (install, resolved-version, typecheck, lint,
fmt:check, build, tests, verify:dist; the throw-path leg SKIPS there because 1.3.0 resolves bash
failures through the `isError` channel, so that path is unreachable rather than broken).

| capability point                                           | 0.86.0 | 0.86.1 | 0.87.0 | 0.87.1 | 0.99.0 | 0.99.1 | 0.99.2 | 1.0.0 | 1.0.1 | 1.0.2 | 1.0.3 | 1.0.4 | 1.1.0 | 1.2.0 | 1.3.0 |
| ---------------------------------------------------------- | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `AgentToolResult.isError` + bash uses it                   | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `ToolDefinition.outputSchema`                              | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `ToolDefinition.exposure` field                            | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| agent-session honors exposure (`_getToolExposure`)         | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| agent-loop forwards `structuredContent`                    | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| codemode ships (`extensions/codemode`)                     | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| MCP extension + codemode auto-enable                       | ✗      | ✗      | ✗      | ✗      | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| extension patterns through `normalizePath` (tilde/file://) | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| codemode declares `reachesTools`                           | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| `BeforeAgentStartEvent` is a `messageType` union           | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| `ToolRenderContext.durationMs` + `outputPad`               | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     | ✓     |
| `registerToolRenderer` API                                 | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |
| `-p` truncated response exits 1                            | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| `formatSkillsForPrompt` supports `"indirect"`              | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     | ✓     | ✓     |
| published settings schema (`schemas/`)                     | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     |
| `--tools` keeps MCP tools unless `mcp__` entry             | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗      | ✗     | ✗     | ✗     | ✗     | ✓     | ✓     | ✓     | ✓     |
| **this package typechecks**                                | **✓**  | **✓**  | **✓**  | **✓**  | ✓      | ✓      | ✓      | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     | ✓     |

Three corrections this table forced, all caught by measuring instead of citing:

1. **0.99.0 is where the capabilities APPEAR, not where this package starts working.** Every API
   our ADRs attribute to "pi 1.0.0" (`isError`, `outputSchema`, `exposure`, the
   `structuredContent` forward, codemode itself, MCP auto-enable) is already present in 0.99.0 and
   absent below it. The ADRs' "1.0.0" citations name where the MEASUREMENTS were taken, not where
   the API appeared. What those missing APIs cost us below 0.99.0 is recorded under "The < 1.0.0
   (and 0.99.0) runtime note" below — a different thing from failing to compile.
2. **0.86.0 is the declared floor and this package compiles and runs on it.** Measured 2026-10-14:
   `tsc --noEmit` reports **0 errors** on 0.86.0, 0.86.1 and 0.87.1, and `pnpm run compat:pi`
   passes every step on **0.86.0 and 0.86.1** —
   install, resolved-version, typecheck, lint, fmt:check, build, tests, throw-path leg,
   verify:dist. An earlier revision of this document recorded these versions as type-broken (9
   errors on 0.86.1/0.87.1). That measurement was taken before #192 landed and no longer holds.

   **0.87.1 is the exception: it compiles but does not pass the matrix.** `compat:pi 0.87.1`
   fails exactly one step, `tests`, because `codemode-switch-differential.test.ts` has no
   measured column for 0.87.x and deliberately refuses to fall back to a neighbouring version's
   one — an unmeasured version is a failure there, not a skip. So the 0-errors claim above is
   about typecheck and stops there; it is not a claim that 0.87.1 is a green matrix leg. 0.87.1
   sits outside `PI_COMPAT_VERSIONS` (`0.86.0`, `1.0.0`, `1.2.0`, `1.3.0`), so the default run never
   touches it.

3. **The 1.2.0-only features are smaller than the changelog suggests**: `normalizePath` on
   patterns, `reachesTools`, the `messageType` union, exit-1 truncation, and the published
   schemas — each inert or handled for this package (see the 1.2.0 section below).

### The gate and the declared floor

`peerDependencies` declares `>=0.86.0`, and `compat:pi` measures that literal number — the
matrix's oldest entry IS the parsed lower bound of the peer range, tied by an equality check in
`tests/unit/pi-compat-matrix.test.ts` (it parses the range out of `package.json`; moving either
side turns the test red). Measured 2026-10-14 on the 0.86.0 tree: **0 type errors**, every gate step
passing, runtime surface registered and the built dist loading.

So there is no gap between the declared floor and the measured floor. The `✗` cells in the 0.86.x
/ 0.87.x columns of the table above are **capability absences, not defects**: pi below 0.99.0 has no
`isError` channel, no `outputSchema`, no `ToolExposure`, no codemode and no
`structuredContent` forward. This package compiles without them and its runtime behaviour on
those versions is recorded in the two tables below. Read those cells as "pi does not offer this
API", never as "we do not work here".

Note that an earlier revision of this document concluded "the real floor is 0.99.0" and left
open whether to narrow `peerDependencies` to match. That question is settled: `>=0.86.0` is both
the claim and the measured truth, so the range stays.

### The 1.0.x → 1.3.0 finding: green, with upstream behaviours worth knowing

pi 1.2.0 passes every step, and so does pi 1.3.0 (measured 2026-10-20: every step, with the
throw-path leg SKIPPED because 1.3.0 resolves bash failures through the `isError` channel). What
1.2.0 shipped that touches this package: `normalizePath` on extension patterns (inert for the
codemode answer — measured and documented in `src/mode/ptc-mode.ts`), a `reachesTools` gate on MCP
auto-enable (inert for pi's own codemode), and `read` growing an `outputSchema` (our binding
projection drops `structuredContent`, so the program-visible shape is unchanged). The one real
behavioural change — print-mode exiting 1 on a truncated response — is handled by
`truncationFailureMessage` in `src/runtime/dispatch.ts`.

**1.3.0 changed none of it.** Measured on its own install, it answers ✓ on all sixteen static
capability points, and its differential resolution of the codemode switch is identical to 1.2.0's
on all forty cases (`tests/unit/codemode-switch-differential.test.ts` now carries a measured 1.3.0
column). So the 1.2.0 column in the capability matrix above is also 1.3.0's column, and the
behaviours worth knowing are the same ones.

### Feature-level matrix: this package own surface, measured per version (the real answer)

Static capability probes say what pi HAS; they do not say what this package DOES. That needs a
second probe: drive the real built dist through factory + session_start + /ptc + a real PTC
program, per version. That probe (`../research/pi-compat-probes-20261014/surface-probe.mjs`, driven
across all 14 trees by `run-surface-matrix.mjs`, measured 2026-10-14) is a one-off prototype, not
gate tooling - it is the evidence behind this table and nothing in the gate runs it. Fourteen versions times fifteen features = 210 checks, all pass - including on the four
pre-0.99.0 versions, which are not type-broken. The 1.3.0 column below is NOT from that 2026-10-14
run: 1.3.0 was published later, and what was measured for it on 2026-10-20 is the `compat:pi
1.3.0` leg (every step green) plus the static capability probe and the forty-case differential
measurement — not this surface probe across fifteen features, which was not re-run for it.

| feature                                                          | 0.86.0-0.87.1        | 0.99.0-1.2.0           |
| ---------------------------------------------------------------- | -------------------- | ---------------------- |
| dist loads; factory + session_start register all six tools       | pass x4              | pass x10               |
| surface=full: programming pair direct (declared to model)        | pass                 | pass                   |
| /ptc command registered; on narrows read/bash out; off restores  | pass                 | pass                   |
| ADR-0011 skills section restored while narrowed                  | pass                 | pass                   |
| PTC program: tools.read / tools.bash / write-read roundtrip      | pass                 | pass                   |
| failing tools.bash REJECTS, capped at 2000 chars, exit code kept | pass (throw channel) | pass (isError channel) |
| **that row's guard, as `compat:pi` runs it**                     | **pass**             | **skipped**            |
| pi.dispatch refuses unknown agent without spawning               | pass                 | pass                   |
| ptc_task_list / ptc_child_report / renderers                     | pass                 | pass                   |
| subagents branch (independent; driven with subagents inputs)     | pass x4              | pass x10               |

#### The last two rows of that table are different claims, and only one of them runs

`pass (throw channel)` and `pass (isError channel)` are RESULTS of the prototype probe
(`surface-probe.mjs`), which drives the real built dist per version. The row beneath them is
what `pnpm run compat:pi` does with `tests/unit/bash-throw-cap-0861.test.ts`, and the two must
not be read as the same measurement:

- **On the 0.86.x leg: pass.** pi 0.86.x has no `isError` channel, so a failing builtin THROWS,
  the guard's `skipIf` does not engage, and `bash-throw-cap-0861.test.ts` really executes the cap
  assertion against the installed tree. Measured on the 0.86.0 leg of `compat:pi 0.86.0`:
  `pass 0.86.0 throw-path leg (capped bash rejection)`.
- **On every leg >= 0.99.0: skipped, NOT a pass.** The installed pi resolves bash failures
  through `isError`, so the throw path does not exist there; the file's first test skipIf's
  itself out and reports 1 passed + 1 skipped. The cap is still covered on those versions - but
  through the isError channel, by the probe row above, not by this guard.

So the guard measures exactly one channel on exactly the versions that have it. A `skip` here
is not a defect and does not turn the matrix red; a `skip` presented as a `pass` would be.

This distinction is mechanical now, not a reading convention. `scripts/pi-compat-matrix.mjs`
reports the leg as its own row with its own marker - `pass` / `skip` / `FAIL` - decided by
re-running that one file with `--reporter=json` and reading the assertion's real status out of
the machine report. The reason is printed on every run, and the summary line counts skipped
legs explicitly:

```
  pass  1.2.0 tests
  skip  1.2.0 throw-path leg (capped bash rejection)
        SKIPPED - NOT A PASS: pi 1.2.0 resolves BASH failures through the isError channel, so the
        bash throw path is unreachable there (the other builtins still reject on every version, and
        the cap covering them is pinned by tests/bindings.test.ts in the default gate).
        tests/unit/bash-throw-cap-0861.test.ts reports 1 passed + 1 skipped here; the bash-specific
        leg is measured on the 0.86.x floor instead
```

and on the floor (`pnpm run compat:pi 0.86.0`, verbatim):

```
  pass  0.86.0 throw-path leg (capped bash rejection)
```

**Why this needed a mechanism rather than a doc note.** `bash-throw-cap-0861.test.ts` was NOT
in the script's `VERSION_SENSITIVE_TESTS` list, so `compat:pi` had never run it at all while
this table recorded a passing throw-channel row - a documented leg with zero executions behind
it. List membership alone does not fix that, because on every version the matrix also measures
(`1.0.0`, `1.2.0`) the guard skipIf's itself: a green `tests` row cannot distinguish "the cap
held" from "the cap never ran". Hence both halves: the entry in the list, and a reported
verdict. The script now also refuses to start if the entry is ever removed again (exit code 2,
naming the file), because that is the exact failure mode that produced the wrong row.

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
not exist - so its absence is invisible to the model. Evidence: the throwaway prototype probe and
its verdict (`../research/pi-compat-probes-20261014/`, `VERDICT.md` v2; `probe-runtime.mjs` loads the
real built dist against a real installed tree through a realpath-resolving module loader). That
directory is a disposable prototype area, not tracked tooling - the lasting record is the two
tables above.

## What the copy must include (each item is a measured failure)

- `.git/` — `tests/doc-integrity.test.ts` resolves the commit SHAs its ledger cites through real
  history and feeds `git ls-files` into its basename-resolution baseline.
- `.codegraph/.gitignore` — doc-integrity's third baseline treats a basename as "unique in the
  repo"; without this file `.gitignore` is no longer a duplicate and the "ambiguity returns
  null" test goes red.
- `docs/`, `README.md`, `AGENTS.md`, `GLOSSARY.md` — doc-integrity walks them.
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
capability table above**. Probing the installed tree for that column means writing a probe of the
kind left behind under `../research/pi-compat-probes-20261014/` — one install, one line of answers per
capability. Those prototypes are not tracked tooling and are expected to be disposable; the
tracked artifact is the table row and the matrix entry.

Keep the list ascending. `tests/unit/pi-compat-matrix.test.ts` pins ordering and uniqueness, and
pins the drift invariant: the list's oldest entry must **equal** the lower bound parsed out of
`package.json`'s `peerDependencies`. That is a deliberate asymmetry with the rest of the file —
it PARSES the range (`>=0.86.0` -> `0.86.0`) and compares for equality, so raising the peer floor
to `>=0.99.0` without adding the matching leg turns it red. The floor stays: it is the claim
`peerDependencies` makes. The capability table is the exhaustive version-by-version record; the
script's list is the curated set the gate re-measures on demand.
