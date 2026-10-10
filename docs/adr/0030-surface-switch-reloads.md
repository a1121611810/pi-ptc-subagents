---

status: **withdrawn 2026-10-10** by
[ADR-0034](./0034-surface-is-detected-not-set.md). The `/ptc surface` command this record is about
no longer exists — the `surfaceMode` key it wrote is gone — so the whole "switch the surface by
writing the file and reloading" subject is moot. There is no surface to switch.

Nothing here is left standing, and nothing needs to be carried forward: the reload-on-switch path
existed only to make an in-session change to a value that no longer exists. The underlying
observation in §Context — pi has no `unregisterTool`, so a factory-time registration is
irreversible — is **still true** and still constrains ADR-0026, which is why detection has to
happen in the factory. That fact outlives this record; the command does not.

Read the record below as history: what was decided on 2026-10-03, and the reload table that
justified it. None of it describes current behaviour.

status (original): accepted (2026-10-03)

# The surface is switched by writing the file and reloading, not by mutating the loadout

## Context

`surfaceMode` (ADR-0025) is read once, in the extension factory, and that is forced rather than
chosen: pi has `unregisterProvider` and `unregisterVirtualModel` but **no `unregisterTool`**
(`ExtensionRunner.bindCore`'s runtime table), so a registration made in the factory cannot be
undone. Everything downstream inherits that — ADR-0026 and ADR-0029 both have to answer their
question on the filesystem, at factory time, because it is the only moment the answer can be used.

The cost lands on the user. Choosing a surface means editing `~/.pi/agent/ptc.json` by hand and
**starting a new session**, and the README has to say so in as many words. The setting is
discoverable, well documented, and awkward — three properties that together mean most people never
change it.

There are two ways to make it comfortable, and only one of them is available.

## What we add

`/ptc surface [off|subagents|full]`, as a subcommand of the existing `/ptc`, which writes the key
and then performs pi's own reload.

**A reload does re-run the factories.** This is the load-bearing fact and it is not a guess:

| step                             | what happens                                                                                                                   | where                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `DefaultResourceLoader.reload()` | calls `clearExtensionCache()`, then re-resolves packages and calls `loadExtensionsCached`                                      | `resource-loader.js:350-353`          |
| `AgentSession.reload()`          | `_buildRuntime()` reads `getExtensions()`, builds a **new** `ExtensionRunner`, re-binds core, and calls `_refreshToolRegistry` | `agent-session.js:2899`, `:2878-2884` |
| the same method                  | re-emits `session_start` with `reason: "reload"`                                                                               | `agent-session.js:2928`               |

That last row is the one that matters: `session_start` is where every surface notice in this
package is issued, so a reloaded session reports itself through the same channel as a fresh one.
`ExtensionCommandContext.reload()` is the same path from inside an extension
(`types.d.ts:322`), so the user types one command.

**The notice is emitted before the reload, never after.** `ctx.reload()` invalidates the command
context — `runner.js:482` says so explicitly, naming `ctx.reload()` in the list of things that
make a captured `ctx` stale. Reading `ctx.ui` afterwards is stale by contract rather than by
accident, so the confirmation is raised first and the reload is the last statement. The test pins
the ORDER, not just the presence: the stub records how many notifications existed when
`reload()` was called.

## What the write has to get right

`setSurfaceMode()` (since deleted by ADR-0034) is a pure-ish function over the filesystem, and
three of its rules exist because
the obvious implementation is wrong in a way that loses data:

- **A malformed file is never overwritten.** An unparseable `ptc.json` is a file someone may be
  mid-edit on. Replacing it with a valid document silently discards whatever was in it, and the
  read side already treats that shape as "report it, do not act on it"
  (`readSurfaceModeConfig`, since deleted by ADR-0034). The write side refusing is the same rule
  applied to the other direction, and the test asserts the file is byte-for-byte unchanged.
- **`defaultMode` survives.** It is ADR-0010's key and it lives in the same file. Writing
  `{"surfaceMode": …}` wholesale would reset the user's mode preference with no error anywhere.
- **An unchanged value writes nothing.** A reload replaces every extension instance in the
  session. Doing that because the user re-typed the value they already had would drop in-flight
  state — background task handles, the briefing flag — that nobody asked to lose.

## What we deliberately do not do

**We do not switch the loadout in place.** The obvious alternative is to register both surfaces and
let `setActiveTools` choose visibility, which needs no reload and feels instant. It is rejected for
the reason ADR-0029 gives: it puts a **second writer** on the loadout, and
`ptc-mode.ts:27-31` already documents that axis as contested — the mode's fail-safe is a
fingerprint of the exact array it wrote, and a surface switch from another writer would trip it
into exiting and restoring `base`. Two features that both narrow one loadout, with no shared
ownership rule, is the failure this repo has already paid for once in this file.

**We do not add a third entry point.** `/ptc` already owns "what is this session doing", and a
`/ptc surface` subcommand is discoverable from the same place `/ptc on` is. A separate
`/ptc-surface` command would be a second thing to document and a second thing to remember.

**We do not make `off` reachable from the command.** An `off` surface returns from the factory
before any command is registered (ADR-0025), so a session already at `off` has no `/ptc` to type.
The value is still accepted and written, because a user who typed it wants it recorded; but it is
not a way back, and the test that reports the surface deliberately does not use `off` for that
reason rather than working around it.

**We do not warn about every interaction.** `subagents` additionally needs `codemode` in the
loadout (ADR-0029), and that is said once, on the switch that can cause it, rather than on every
session afterwards — the startup warning already covers the sessions.

## Consequences

- The surface becomes a session action rather than a config edit, and the README's "needs a new
  session" caveat becomes "this command reloads for you".
- **A surface change still costs a reload.** Background task handles, the mode's persisted entry,
  and the briefing flag are re-derived. That is unavoidable while registration is irreversible, and
  the command says what it is doing before it does it.
- **Switching to `subagents` or `off` ends a running PTC mode**, because `decideModeEntry` policy 3
  refuses to enter without `ptc_run_code` / `ptc_workflow`. The command says so rather than letting
  the user discover it from a mode that silently stopped.

## Verification

Fourteen cases in `tests/unit/surface-command.test.ts`, over the write and the command. The ones
that carry the design:

| claim                              | case                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| a reload is what applies a surface | the command calls `ctx.reload()` — a stub without one cannot run these tests at all, which is why the test context grew a recording `reload` |
| the notice precedes the reload     | `stub.reloads[0] === stub.notifications.length`                                                                                              |
| a bad write changes nothing        | five malformed bodies, each asserted byte-for-byte unchanged, plus six out-of-set values asserted to create no file                          |
| a no-op does not reload            | `surface full` on a file already saying `full`                                                                                               |
| a refusal does not reload          | both the out-of-set value and the malformed file                                                                                             |

The reload path itself is **not** exercised end to end here: a unit test cannot re-run a factory,
so "the reload re-reads the file" is covered by `tests/tool-visibility.test.ts` (which spawns real
pi) and by ADR-0029's own verification table, not by this file. Stated rather than implied.
