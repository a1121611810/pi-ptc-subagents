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
  (`loader.js:106-108`), which is after every factory body has returned.
- Calling one from a factory **throws**. `initializeExtension` catches that throw and
  `loadExtension` answers `{ extension: null, error }`, so the extension is dropped rather than
  half-loaded (`loader.js:493-520`). It does not return an empty list.

  Both line numbers are pi **0.99.1**'s `dist/core/extensions/loader.js`, read from a real
  install. 0.86.1 -- the version this repo compiles against -- has the same two regions at
  106-108 and 445-473, so the shape of the argument is version-independent even though the
  offsets are not.

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
   (`../extensions/codemode`, `../../extensions/codemode`, `extensions/codemode`).

   Only the first is **measured**: on a real 0.99.1 install `extensions/` sits one level above
   `dist/bundle/`, and that is the entry that answers. The other two are hypotheses about a pi
   packaged differently, and their coverage is uneven. The third has a test, but that test builds
   the layout by hand rather than observing an install, so "a test caught it" would be a claim
   nobody can check. The second has no test at all. Both are here because a miss on either calls a
   pi that does ship codemode a pi that does not, and the real-pi e2e probe test is where such a
   miss would surface. The cost of guessing is one extra `statSync` on a path that is normally
   absent; the cost of missing the layout is a silent fallback.

3. **Every failure of the probe resolves to `full`** (`FALLBACK_SURFACE_MODE`, the false branch
   of `detectedSurfaceMode`). No argv, an unresolvable shim, a pi packaged somewhere unguessable,
   a permission error: all of them are `full`. The direction is the design. A probe that cannot
   answer must not be allowed to answer yes, because `subagents` as a failure mode silently
   takes away the orchestration tool a session was relying on.

   Falling back silently is the other half of that failure, so the outcome is **reported**. At
   `session_start`, when the surface was not read from the file, the probe result is named
   through `ctx.ui.notify`: how it came out and what the default therefore is. The expected
   case -- probe found codemode, default resolved to `subagents` -- says nothing, because a
   notice on every healthy session is noise. What is left is a probe that could not answer,
   which is exactly the pi-restructured-its-`dist` case this design is most exposed to.

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

7. `readSurfaceModeConfig` takes the probe result as an **optional parameter**, and the factory
   takes it as a test seam. Neither a test nor a caller can be surprised by the machine it
   happens to run on.

   Omitted, the parameter is resolved **inside the fallback branches** rather than in a default
   parameter, because a default parameter is evaluated on every call -- including the ones an
   explicit `surfaceMode` key short-circuits, where the user would pay a `realpathSync` plus up
   to three `statSync` per factory construction to set one line of JSON and get a constant. That
   was measured, not assumed: with an explicit key the probe's `argv[1]` read goes from 1 to 0.

8. A probe that walks the filesystem fails in **both** directions, and the first fix only handled
   one of them. Decision 3's notice covers the under-estimate (probe `not-found`, default quietly
   becomes `full`). The over-estimate is the one this decision is about:

   - The probe answers `present`, so the surface becomes `subagents`; the session runs under
     `--no-extensions` or `--exclude-tools codemode`, so pi registers no `codemode` at all. The
     user is left holding `ptc_subagent` and no way to compose anything. **ADR-0025 decision 4's
     warning cannot catch it**: that one asks whether `codemode` is _active_, and with the tool
     absent both questions are false for the same reason.
   - The mirror: the probe answers `not-found` on a pi that plainly registers `codemode` (a
     restructured `dist`, a layout no candidate covers), so the session gets `ptc_run_code` and
     `ptc_workflow` **beside** a live `codemode` -- the duplicate model-facing surface this whole
     setting exists to remove -- while decision 3's notice calls that outcome "the safe direction,
     not an error", which is the opposite of what the user just got.

   So at `session_start`, where -- and only where -- `pi.getAllTools()` is real rather than a
   `notInitialized` stub, the filesystem answer is cross-checked against pi's own registry and a
   disagreement is reported, in **both** directions. It asks `getAllTools()`, not
   `getActiveTools()`: the question is "does pi know this tool at all", not "can this session call
   it", and only the registry answer survives `--no-extensions`. A session whose surface came from
   the file (`source === "file"`) is exempt: the user decided, and a notice telling them their own
   key is wrong for this session is a different product.

   This makes the probe result read at **`session_start` by two readers** -- decision 3's outcome
   notice and this cross-check -- not once. What the cross-check adds is one registry read
   (`pi.getAllTools()`) on a path that already reads the active set for the mode decision, so the
   cost of asking the question the probe cannot is one `some()` over the registry.

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
  `not-found` and the default becomes `full` -- the safe direction, but one the user cannot
  otherwise see. The probe result is carried on `SurfaceModeConfig.codemode` and read at
  `session_start` by **two** readers in `src/index.ts`: decision 3's outcome notice and
  decision 8's registry cross-check. Those readers are why the field exists, and they are the
  only place the detection is visible to a human.
- **The `--print` gap is new here, and it is worse than the one ADR-0025 records.** Both notices
  this record adds are `ctx.ui.notify`, which is TUI-only. That is inherited for the ADR-0025
  decision-4 warning, which that record introduced; it is **introduced here**, and measured: three
  `--print` runs that each emit one of these notices produced **0 bytes on stdout and 0 on
  stderr**. A `--print` session is scripted or piped, so the consequence is not "a line the user
  misses" -- it is that the diagnostic this record's whole reporting design rests on does not
  exist on that channel at all, and the README is the only place a `--print` user can learn it.
  Nothing here is deleted on that account: `ui.notify` is the documented TUI channel and the
  mechanism is the right one where it works. The obligation it leaves is a channel that is not
  the TUI.
- **What is established about the notices, and what is not.** What is established: the outcome is
  reported through the documented TUI channel (`ctx.ui.notify`) at `session_start`, and the
  registry cross-check is covered by a test that forces the check to fail. What is **not**
  established: that a user sees either notice in a real pi TUI. A pty capture of the round-4
  review showed neither the notice nor a control marker, and the reason is the harness's, not the
  code's -- a TUI quits on stdin EOF before a toast paints -- so this is an unproven end to end,
  not a refuted one. No test in this repository observes a notice through a real TUI. Anyone
  reading this record should treat "the user is told" as the design intent and "the user is
  shown" as unmeasured.
- `scripts/verify-dist-render.mjs` must keep writing an explicit `surfaceMode`, and its reason
  is now stronger: a gate run under a pi that ships codemode would resolve to `subagents` and
  fail on a set difference unrelated to the build.
- Two tests here were passing for the wrong reason before this change: the one asserting a
  missing file gives `full` was reading the real probe against the test runner's argv, which has
  no pi next to it. Both branches are now stated explicitly.

## Accepted limitations

Recorded here as **accepted**, with the trigger that would retire each, so a later round does not
file them as new findings. Both were live questions at review round 6 and both were answered "we
accept this for now", which is a decision and should not live only in a review ledger.

1. **The two `session_start` notices are TUI-only.** `ctx.ui.notify` emits nothing in `--print`,
   measured at 0 bytes on stdout and stderr across three runs that each emit a notice. A piped user
   therefore learns why they got their surface from the README and nowhere else. **Accepted** because
   `ui.notify` is this package's only session-scoped human channel and every `console.warn` site is a
   runtime-failure path that would be wrong to overload here; writing to stdout from a library that is
   silent by design is a worse trade than an under-documented notice. **Retired when** pi offers a
   session-scoped non-TUI notification path, or when the rendering question becomes a measurement. It
   can be, and round 7 says how: hold a real pi TUI stdin **open** (the round-4 attempt fed it EOF,
   which quits the TUI before a toast can paint, and is why that attempt was inconclusive rather
   than negative) and read the terminal bytes for the notice string. A positive there closes this
   item; a negative with a held-open TUI turns it from "unverified" into "the notice does not render",
   which is a different and more serious finding.
2. **A `ptc_subagent` background child gets no ADR-0022 session triple — ANSWERED, not accepted.**
   The binding forwards `context.sessionDir` into the DispatchContext; the tool reads a value at
   session start and cannot, so its children are spawned `--no-session` while the identical spawn
   from inside a program gets the session dir.

   This was **accepted** in round 6, **split** in round 8, and **closed by measurement** in round 9.
   The evidence is `scripts/measure-session-triple.mjs` and its recorded output, both checked in; the
   script is idempotent and re-runnable, and either can be verified rather than trusted. Measured
   against pi 0.99.1 with three real spawns into a temp session directory:

   - **Where a child writes.** With the triple, exactly one file appears in `<sessionDir>`, named
     `<ISO8601-timestamp>_<sessionId>.jsonl`. With `--no-session` and no session dir, nothing is
     written there. That is the whole of the output-location effect, and it is per-child.
   - **`--session-id` really does make a retry idempotent** — the claim most likely to be false, and it
     holds. A second spawn carrying the _same_ id produced **no second file**, and it **appends**
     rather than truncating: the retried session held **10** JSONL entries where a fresh one held
     **7**, so the first attempt's transcript survives the retry. ADR-0022's parenthetical
     ("retry idempotence") is accurate, and it is now measured rather than asserted.
   - **No collision.** Two children with different task ids in one directory get two distinctly named
     files. Same id is the idempotence case above, and is unreachable from the normal path:
     `sessionId` is the freshly minted `taskId` (`dispatch.ts:1096`) and one task id is one TaskRecord.
   - **Not established by that measurement, and closed by a different argument:** where the child's
     output is _routed_ on our side. That is a different sink — `OutputStorage` and the subscription
     pipeline, ours — from the child's session file. The two do not interact, and the round-8
     pre-session seam covers our side, so the child session file cannot displace what
     `ptc_task_output` returns.

   Recorded as a process note, because it is the shape of this whole record: this took a temp
   directory, three real spawns and `ls`. The price was never high. The retirement condition had
   been written at the wrong altitude, asking for one measurement when there were two of different
   cost — and, the first time, the answer was left in a chat message rather than in a file the next
   round could open.

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
