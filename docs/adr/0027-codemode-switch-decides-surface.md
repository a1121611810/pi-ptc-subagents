---

status: accepted (2026-10-02)

# The detected surface follows whether pi will LOAD codemode, not whether it ships it

## Context

ADR-0026 made the surface default DETECTED rather than constant, and the detection was a single
question: `probeCodemodePresence()` walks the filesystem from pi's entry script looking for the
`codemode` extension directory. Found means `subagents`, not found means `full`. Its own
docstring states the scope of the answer:

> The answer is "does this pi ship codemode", NOT "can this session call it": codemode registers
> with `defaultActive: false`, so it is absent from `getActiveTools()` even when fully present.

That scoping was correct when it was written, and it is still correct as far as it goes. What
changed is the world it sits in. **pi 0.99.0 added `-builtin:<name>`**, so a user can now tell pi
not to load a built-in extension at all. From that release on, "the directory exists" and "the
extension will run" are different questions with different answers, and the probe only asks the
first one.

Measured on a real 1.0.0 install, with `extensions: ["-builtin:codemode"]` in the user settings:

```
codemode in pi's tool list : False        <- the switch worked
this package registered     : ptc_subagent, ptc_task_list, ptc_task_output, ptc_task_stop
```

`ptc_run_code` and `ptc_workflow` were still absent. The user turned pi's orchestrator off, and
this package — reading only the directory — kept handing the orchestration to it. The session had
**no orchestration surface at all**, and the only symptom was two missing tools.

## What we add

A second probe, kept as separate from the first as the two questions are, and a four-case table
over both of them.

| codemode on disk | switch   | surface     | why                                                   |
| ---------------- | -------- | ----------- | ----------------------------------------------------- |
| yes              | absent   | `subagents` | pi loads built-ins by default, so it can orchestrate  |
| yes              | enabled  | `subagents` | ditto, and the user said so explicitly                |
| yes              | disabled | `full`      | the orchestrator we would hand away to is not loading |
| no               | any      | `full`      | nothing to hand it to                                 |

`absent` is not a third state to reason about — it is pi's own default, so it groups with
`enabled`. It is carried separately only so a notice can say "you never configured this" as
distinct from "you turned it on".

### Reading the switch

`readCodemodeSwitch()` reads the same three places pi reads, and resolves in the same order, taken
from `DefaultPackageManager` in pi 1.0.0 rather than from the prose in `docs/settings.md`:

1. `-e builtin:codemode` / `--extension builtin:codemode` on the command line — **enabled**
2. `-ne` / `--no-extensions` — **disabled**
3. an `extensions` entry in `<cwd>/.pi/settings.json`
4. the same in `<agentDir>/settings.json`
5. otherwise pi's default: **loaded**

**The two settings files are resolved by two different functions in pi, and reading them as one is
a defect this ADR's first draft shipped.** Steps 3 and 4 look interchangeable and are not. Both
functions are now called rather than described:

| scope   | pi's function, and where it is called                              | rule                                                                                                                            |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| project | `applyAutoloadDisabledPatterns`, defined `:593-606`, called `:741` | iterate in order; each MATCHING entry of any sign overwrites the last. `+` / `-` matched exactly, `!` by glob. Position matters |
| user    | `isEnabledByOverrides`, defined `:523-539`, called `:742`          | split into `!` / `+` / `-` buckets and **assign** through them in that fixed order. Position is irrelevant and `-` outranks `+` |

So user `["-builtin:codemode", "+builtin:codemode"]` is `disabled` in pi and would have been
`enabled` under a shared last-match-wins rule — and `enabled` there is precisely the failure this
ADR exists to prevent: the session would be told pi's `codemode` is orchestrating when it is not
loading.

Both are **mirrored, not approximated**, and that was a change of approach rather than another case.
pi matches the `!` bucket with `minimatch` and normalises `+` / `-` through `normalizeExactPattern`
(which strips a leading `./`, so `-./builtin:codemode` disables), so this package calls the same
`minimatch` through ports of the same two helpers, with pi's own `baseDir` per scope. The previous
version compared a pattern's literal prefix instead and documented its over-match as an accepted
cost. That was the wrong shape of fix: the `!` bucket is a continuum — globs, character classes,
extglobs, nested negations, backslash escapes, multi-segment paths — so each review round found one
more member. Four costful defects in four rounds (R1-01, R3-01, R4-01, R4-02), and a 412-case sweep
of the prefix version still had 24 divergences. A case list cannot be finished; mirroring pi's call
can. A 192-case sweep of the mirror has **zero divergences in either direction**.

`tests/unit/codemode-switch-differential.test.ts` is the standing oracle for that claim: it drives
pi 1.0.0's real `DefaultPackageManager.resolve()` and compares case by case, and it re-measures the
table's own expected values so a future pi release turns the file red rather than letting it agree
with a stale expectation. `tests/unit/codemode-switch.test.ts` pins the same rules as literals, for
the case where that differential is skipped.

One further limit, unchanged:

- **No attached short form.** `-ebuiltin:codemode` is not recognised, because pi rejects it
  outright — measured: `Error: Unknown option: -ebuiltin:codemode` — and `dist/cli/args.js` only
  reads `args[++i]` after a bare `-e`. Mirroring that is the point.

**The project directory is read as `process.cwd()`.** pi's own `DefaultPackageManager` gets its
`cwd` from `DefaultResourceLoader`, which applies `resolvePath(options.cwd)` whose `baseDir`
defaults to `process.cwd()` — so the two coincide for the shipping CLI. They diverge only for an
SDK embedder that passes an explicit different `cwd` (`core/sdk.ts:78`), and that caller has no way
to hand the value to an extension, which sees only `process.cwd()`. Recorded as a known limit rather
than treated as covered.

### Reporting

The factory cannot ask pi anything: `getSettings()` is a `notInitialized` stub until `bindCore`
runs (`loader.js:126`), which is after every factory body returns, and pi has no `unregisterTool`
— only `unregisterProvider` — so a decision made later cannot be undone. The disk read is
therefore the only oracle available at the only moment the decision can be made.

Two things are reported at `session_start`, where a `ctx` exists:

- a settings file that could not be read as a JSON object. The switch has already fallen through
  to the next source; the notice names the file. A malformed setting must never half-apply.
- ~~an explicit `surfaceMode` that disagrees with the table. The pinned value **wins** — that is
  what an override is for — and this only says so. `off` is exempt: it is a statement about the
  package rather than a claim about who orchestrates, and warning about it every session would be
  crying wolf.~~ **Removed 2026-10-10 by
  [ADR-0034](./0034-surface-is-detected-not-set.md)**: there is no `surfaceMode` key and no pinned
  value, so there is no disagreement to report. Only the settings-file notice above remains.

Both are `info` or `warning` about a value that was honoured, never an error about a broken one.

## What we deliberately do not do

**We do not make the probe authoritative about tool availability.** The table still asks the
directory question, and a pi that ships codemode but is told not to load it is now handled by the
switch rather than by changing what the probe means. Folding the two together would make
`CodemodePresence.how` — which exists to distinguish "pi restructured its dist" from "no pi next
to argv[1]" — carry a second, unrelated answer.

**We do not read `defaultTools`.** `-codemode` there turns the tool off while the extension stays
loaded, which is the same user intent by another route. It is out of scope for this ADR because
the four cases above are about the extension, and because `defaultTools` is resolved after the
factory. A user who writes both `-builtin:codemode` and `+codemode` in `defaultTools` has asked
for a contradiction, and gets the extension's answer.

## Consequences

- The failure this fixes is a **silent** one. Nothing errored; two tools were simply missing. The
  regression test asserts on the registered tool set rather than on `detectedSurfaceMode`,
  because the latter would stay green if the factory stopped consulting the switch at all.
- The switch adds two file reads to factory startup on the path where no `surfaceMode` is pinned.
  The explicit-key path runs them too, because the disagreement notice needs them — that is one
  extra `statSync`/`readFileSync` pair on a path that already paid for a `realpathSync`.
- `CodemodePresence` and `CodemodeSwitch` are separate types with separate test seams, so a test
  states both facts it is reasoning about rather than inheriting either from the machine.

## Verification

The three reachable cells, each on a real 1.0.0 install, each confirmed by the tool set a model
would see:

| scenario                          | codemode in pi | this package registered                      |
| --------------------------------- | -------------- | -------------------------------------------- |
| user settings `-builtin:codemode` | absent         | `ptc_run_code`, `ptc_workflow`, `ptc_task_*` |
| no switch entry (pi's default)    | present        | `ptc_subagent`, `ptc_task_*`                 |
| user settings `+builtin:codemode` | present        | `ptc_subagent`, `ptc_task_*`                 |

The fourth cell — no codemode on disk at all — is not reachable on a machine that has 1.0
installed, and is covered by unit tests only. That asymmetry is stated rather than papered over.
