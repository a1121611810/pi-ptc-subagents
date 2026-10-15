# pi compatibility probes (2026-10-14)

The probes behind the capability and feature matrices in
[docs/agents/pi-compat-matrix.md](../../agents/pi-compat-matrix.md). They were written as throwaway
prototypes under a gitignored `.scratch/` and moved here so the evidence survives the directory.

## What they measured

- **14 published pi versions x 15 feature points = 210 checks, all passing** (`capability-probe.mjs`,
  `run-surface-matrix.mjs` across every installed tree).
- **Runtime behaviour on a real 0.86.x install** -- the built `dist/index.js` loaded against a real pi
  tree, tools registered, `structuredContent` forwarded or dropped (`probe-runtime.mjs`).
- **The surface decision** under codemode-present and codemode-absent inputs
  (`surface-decision-probe.mjs`, `run-decision-matrix.mjs`).

`VERDICT.md` holds the finding and, more usefully, **the two claims of v1 it refuted** -- both came
from missing the surface convention: on a pi without codemode the surface is `full`, so
`exposure="direct"` is the declared design rather than a missing gate, and `structuredContent`
never reaches a model anyway because its channel is programmatic-only.

## What these are NOT

**Not gate tooling.** Nothing here runs in CI, in `pnpm run compat:pi`, or in any test. The
lasting record is the matrix's table rows and its `PI_COMPAT_VERSIONS` entry, both of which are
measured by the gate. These scripts are kept for the reasoning, not for the result.

**Not one-command re-runnable.** They read measurement trees built outside this repository:

| script                                   | requires                                 |
| ---------------------------------------- | ---------------------------------------- |
| `driver-install.mjs`, `pi086-loader.mjs` | `/tmp/pi-cap-matrix/v<ver>/node_modules` |
| `run-decision-matrix.mjs`                | `/tmp/trees-full.json`                   |
| `build-binding-probe*.mjs`               | `/tmp/lead086/node_modules`              |

Rebuilding those trees is the first step of any re-run, and it is deliberately not automated here:
a `pnpm install` per version across 14 versions is minutes of wall clock, and automating it would
make a check that belongs in `scripts/` look like a check that is in the gate.

## Reading the results honestly

The matrices this feeds are documentation, and a documentation claim is only as good as the
re-run behind it. One row in that matrix was found **wrong** by review (it claimed
`compat:pi 0.87.1` passed every step; it fails the `tests` step) -- and no probe here would have
caught it, because the claim was about the gate rather than about a version. Re-run before trusting
a cell, not after.
