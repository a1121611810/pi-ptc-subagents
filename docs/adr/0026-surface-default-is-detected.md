# The surface default is detected from the pi that loaded us

status: accepted (2026-09-30)

## Context

ADR-0025 made `surfaceMode` a setting and gave it a constant default of `full`, on the
reason that an upgrade must be invisible. That reason was right about the _setting_ and wrong
about the _default_: it assumed a pi either has our orchestration surface or has nothing, when
in fact pi 0.99.1 ships its own.

So a user who installs this package on a modern pi and sets nothing gets two model-facing
orchestration tools and two system-prompt sections, and the model picks a programming model
per request (ADR-0025's motivation, measured in
`docs/research/codemode-vs-ptc-capability-20260930.md`). The obvious remedy -- hand
orchestration to `codemode` when it is there -- needs to know whether it is there.

## The constraint that decides the design

Registration has to happen in the extension factory, because pi has no unregister call. The
default therefore has to be knowable in the factory. pi's own tool listing is not:

- `getAllTools()` and `getActiveTools()` are `notInitialized` stubs until `bindCore` runs
  (`loader.js:106`), which is after every factory body has returned.
- Calling one from a factory **throws**, and a throwing factory makes the extension fail to load
  entirely (`loader.js:447-455`). It does not return an empty list.
- 0.86.1, which this repo compiles against, has no `getSettings`, and its `ToolInfo` has no
  `exposure` field, so a check has to be name-only against `getAllTools()` even when deferred.

The alternative -- register the union and narrow the active set at `session_start`, where the
API does work -- is recorded as rejected below. It is the only approach that sees
`--exclude-tools`, and it is the one that costs `off` its meaning.

## Decision

1. With no `surfaceMode` in `~/.pi/agent/ptc.json`, the surface is **detected**: a pi that
   ships `codemode` gets `subagents`, a pi that does not gets `full`.

2. Detection is a filesystem probe over `process.argv[1]`, resolved with `realpathSync`
   first because a package-manager install makes `argv[1]` a shim. Three layouts are tried
   (`../extensions/codemode`, `../../extensions/codemode`, `extensions/codemode`); the third
   was added because a test caught a pi with no `dist/bundle` level being misread.

3. **Every failure of the probe resolves to `full`.** No argv, an unresolvable shim, a pi
   packaged somewhere unguessable, a permission error: all of them are `full`. The direction
   is the design. A probe that cannot answer must not be allowed to answer yes, because
   `subagents` as a failure mode silently takes away the orchestration tool a session was
   relying on.

4. An explicit `surfaceMode` key always wins, whichever way the probe came out. Detection is a
   default, never an override.

5. A malformed file reports `invalid` and falls back to the **detected** default, not to a
   constant. The same argument as decision 3 applies to a broken file: a user who cannot
   parse their config should still get the surface their pi implies.

6. Existence is not callability, and the two are asked in different places. `codemode`
   registers with `defaultActive: false`, so it is absent from `getActiveTools()` even when
   fully present. The factory-time probe answers "does this pi ship codemode"; `session_start`
   answers "can this session call it" and warns when the answer is no. That warning is ADR-0025
   decision 4 and it now fires on a stock pi 0.99.1 session, which is a consequence of
   decision 1 and not a bug in it.

7. `readSurfaceModeConfig` takes the probe result as a **parameter** with a real-probe default,
   and the factory takes it as a test seam. Neither a test nor a caller can be surprised by the
   machine it happens to run on.

## What this costs, stated plainly

ADR-0025's story 3 -- an upgrade must change nobody's behaviour -- is **false for this**
change, and the record should not pretend otherwise. A user on pi 0.99.1+ who has never set
`surfaceMode` moves from `full` to `subagents` on upgrade. Concretely, on a stock 0.99.1:

- they lose `ptc_run_code` and `ptc_workflow` until they set `"surfaceMode": "full"`;
- because `codemode` is `defaultActive: false`, they also have no active orchestrator until they
  add it to their tool list, so the session-start warning fires.

The remedy is one line of JSON, the warning names it, and the alternative is every user
being taught two programming models forever. That trade is the user's call to make and this
record is the place to look up what was decided.

## Rejected

- **Register the union, narrow at `session_start`.** Uses pi's own API, so it sees
  `--exclude-tools` and a mid-session `--tools`. Rejected because it makes `off` mean
  "registered but inactive" rather than "nothing exists", which is the property ADR-0025 was
  written to guarantee, and because every factory-time guard against a malformed file has to
  move to a point where the damage is already done.
- **Version-gate on pi.** The package exports no `VERSION`, and an extension living outside the
  package cannot resolve it by name. Gating on a version string also breaks on every patch
  release that ships the tool.
- **Read `codemode.mode` from the agent dir.** It records a user _preference_, not a tool's
  presence: it says "configured" under `--no-extensions` or `--exclude-tools codemode`, where
  the tool genuinely is not there.
- **Keep the constant default and document the duplicate surface.** That is the state ADR-0025
  was written to end.

## Consequences

- The filesystem layout becomes an input. If pi restructures its `dist`, the probe returns
  `not-found` and the default quietly becomes `full` -- the safe direction, but silent. The
  probe result is carried on `SurfaceModeConfig.codemode` so a session can report it.
- `scripts/verify-dist-render.mjs` must keep writing an explicit `surfaceMode`, and its reason
  is now stronger: a gate run under a pi that ships codemode would resolve to `subagents` and
  fail on a set difference unrelated to the build.
- Two tests here were passing for the wrong reason before this change: the one asserting a
  missing file gives `full` was reading the real probe against the test runner's argv, which has
  no pi next to it. Both branches are now stated explicitly.

## Reopen triggers

- pi gains a way to report registered tools to an extension during loading. That would retire
  the filesystem probe and its layout dependency in one move.
- pi changes `codemode`'s registration from `defaultActive: false`, or ships a setting that
  activates it. The warning in decision 6 would stop firing and the default would become
  strictly better.
- A pi ships a second orchestration tool. The probe asks one yes/no question; that question
  would need to become a set.

See also: ADR-0025 (the setting itself), ADR-0016 (the binding contract `ptc_subagent`
forwards to), `docs/research/codemode-vs-ptc-capability-20260930.md` (the comparison).
