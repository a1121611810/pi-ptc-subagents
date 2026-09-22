# PTC default mode: narrow the loadout, keep bindings on a base snapshot

The package was already default-**on** (CONTEXT.md: "a user who runs `pi install npm:pi-ptc-subagents` immediately gets the PTC tools … with no extra setup"), but that only means the tools are _available_. In practice a session looks identical to one without the package: the model sees `read`/`bash`/`edit`/`write` next to `ptc_run_code` and has no reason to prefer composing a program, so the PTC surface stays unused and the transcript keeps showing file-operation rows. The requirement is a default-**use** mode: install, restart, and the session works the PTC way without any further setup.

That requires narrowing what the model may call directly, which collides with a decision this repo already recorded. ADR-0005's addendum (T7, #21) ties the binding table to the _live_ loadout: `bindings = BUILTIN_BINDING_NAMES ∩ pi.getActiveTools()`, and that was deliberate — it is what stops `tools.<name>(…)` from escaping a `--tools` restriction. But `pi.getActiveTools()` reads the very set the mode has to hide. Hiding the built-ins therefore empties the binding table, and every `tools.read(…)` fails with "not bound": the extension would neuter itself. This ADR records the resolution — a base snapshot that keeps T7's guarantee while making the mode's **own** narrowing transparent to the binding table.

Status: accepted (2026-09-22). Ticket: PTC default mode (grill rounds 1–2). Reinterprets ADR-0005 §Addendum's binding rule; does not change ADR-0005's boundary or its F1–F4 hardening.

## Decision

**1. What the mode is.** While enabled, the session's visible tool loadout is narrowed so the seven built-in tools are reachable only from inside a program (`tools.<name>(args)`). The mode is not a separate execution path: same worker, same dispatcher, same bindings. It changes only _what the model may call directly_.

**2. Bindings come from a base snapshot.** `base` is captured from `pi.getActiveTools()` immediately before the mode narrows anything, and `resolveBindingNames()` is fed `base` — not the live loadout — while the mode is on. T7's guarantee survives unchanged, because `base` is itself the session's own loadout: a session launched with `--tools read` has `base = ["read"]`, so bindings stay `["read"]`. The mode never widens access beyond what the session was launched with; it only makes its own hiding transparent.

**3. Tool visibility: hide the built-ins, keep other extensions' tools.** This is the one place where the shipped behaviour is deliberately _less_ strict than DSH's PTC preset, and the reason is a hard API limit rather than a preference: `pi.getAllTools()` returns metadata only (`name`, `description`, `parameters`, `promptGuidelines`, `sourceInfo`) — no `execute`. A binding for `web_search` or `todo` is therefore impossible to build, so hiding such a tool makes it unreachable for the whole session. Hiding only the built-ins forces the model to program for file and shell work — the bulk of a coding session — without silently revoking capabilities this package cannot re-expose. `ModeHideStrategy = "all-but-ptc"` remains implemented and unit-tested for callers who want the strict shape; it is not the default.

**4. Entry policy.** The mode turns on when all of these hold, and the decision is recorded in `decideModeEntry()`:

- **TUI only** (`ctx.mode === "tui"`). Print, JSON and RPC sessions are left exactly as launched: forcing the shape on a CI script buys nothing and breaks it.
- **Config allows it** — `~/.pi/agent/ptc.json` may set `{"defaultMode": false}`. Absent file means on. A malformed file is reported to the user and still defaults to on, because silently flipping a behaviour this visible is worse than the malformed file.
- **The PTC tools are active.** With none of `ptc_run_code` / `ptc_workflow` enabled there is nothing to run.
- **The session was not launched with an explicit restriction.** If any of pi's four default tools (`read`, `bash`, `edit`, `write`) is missing from the loadout (`--tools`, `--exclude-tools`, `--no-builtin-tools`), the session stays as launched. Narrowing further would override a deliberate instruction, and the PTC surface would be degraded anyway (bindings = `BUILTIN ∩ base`). Deliberately _not_ checked against `BUILTIN_BINDING_NAMES`: that list is every name that can be bound, not what a default session has — `grep` / `find` / `ls` are bindable but off by default, so requiring all seven would misread an ordinary session as restricted and never turn the mode on.

**5. `/ptc on|off` overrides everything but the TUI/availability checks.** A manual `on` deliberately bypasses the config and the restricted-session policy: a restricted session enters with its own smaller loadout as `base`, so bindings stay inside the user's allowlist. `/ptc off` restores `base` and clears the mode. There is no CLI flag: pi's extension boolean flags can only be set to true (`flagValues.set(name, true)`; no `--no-<extflag>` exists), and `--no-ptc "a prompt"` would swallow the prompt as the flag's value. The config file is the persistent switch.

**6. Fail-safe on external loadout changes.** `ourLoadout` records the exact array written to `setActiveTools()`. Another extension may take ownership of the loadout (pi's own `preset.ts` and `tools.ts` examples call `setActiveTools`), so a mismatch on the next turn is treated as "someone else owns this now": the mode exits, restores `base`, and says so. It never re-asserts itself over another actor.

**7. The mode announces itself.** Footer status plus a notification on entry naming what became unreachable and what the bindings are, and a one-shot instruction message in the conversation listing the session's actual bindings. The briefing is generated from those bindings rather than hardcoded, because `base` varies per session and a stale list would have the model calling names that are not bound. It is injected once per entry, not per turn.

**8. `promptSnippet` on both tools.** Custom tools are omitted from the prompt's "Available tools" section unless they set it. In PTC mode the two PTC surfaces are the only callable tools, so an empty section would contradict the tool declarations — the model would be told nothing is available while the declarations say otherwise.

## Consequences

- **`src/mode/ptc-mode.ts`** (new) — config reader, entry policy, loadout shape, binding source, external-change detection, briefing builder. Pure functions plus the persisted-record shape; no pi imports beyond `BUILTIN_BINDING_NAMES`.
- **`src/index.ts`** — `session_start` (read config, restore a persisted record, decide, enter, announce), `before_agent_start` (external-change check, one-shot briefing), `registerCommand("ptc")`, footer status. Both tools are handed `getBindingSourceNames` instead of `getActiveTools`.
- **`src/tools/common.ts`** — `PtcToolOptions.getActiveToolNames` renamed to `getBindingSourceNames` (the option no longer means "the active tools"), plus the `promptSnippet` / `promptGuidelines` constants.
- **`package.json`** — `@earendil-works/pi-tui` added as a devDependency. The renderers import `Text` from it; at runtime it resolves through `pi-coding-agent`'s dependency, but `tsc` needs the types. `dist/index.js` grows accordingly (55 kB → ~146 kB).
- **Downstream** — installing the package now changes the default shape of a TUI session. That is the point of the mode, and it is why the config opt-out and `/ptc off` exist.
- **Not covered by tests** — the TUI narrowing path itself. The mode is TUI-only by design and a test process has no TTY, so it is covered in halves: `tests/ptc-mode.test.ts` drives the extension through a stub (the mode's half), and `tests/tool-visibility.test.ts` runs real pi against a canned provider to prove that `setActiveTools()` actually changes what the provider is offered (pi's half).
- **A default session binds four tools, not seven.** Bindings are `BUILTIN ∩ base`, and a default session's `base` is pi's four defaults, so `tools.grep` / `tools.find` / `tools.ls` are absent until the session enables them (`defaultTools` / `--tools`). This is the pre-existing ADR-0005/T7 behaviour, now also visible in PTC mode.

### Considered options (and why rejected)

- **Guidance only (`promptGuidelines`, no loadout change).** Cheapest and zero-risk, and it was the recommended first step in the grill round. Rejected by the operator, who wants the mode to be the default rather than a tendency. Kept in the shipped build as a complement: the guidelines still apply whenever the mode is off.
- **Bindings from `pi.getAllTools()` instead of a snapshot.** Would give near-DSH parity (the full built-in registry regardless of session flags) at the cost of explicitly breaking T7: a `pi --tools read` session could write files through `tools.write`. Rejected — the PTC surface has no sandbox (ADR-0007), so the enablement policy is one of the few boundaries that does exist, and it should keep working.
- **Mutating `systemPromptOptions.selectedTools` per turn instead of `setActiveTools()` once.** Explored and rejected as equivalent-but-worse: `getActiveToolNames()` returns `agent.state.tools`, which is derived from `selectedTools`, so the bindings trap is identical; the per-turn route additionally aliases pi's `_baseSystemPromptOptions` and re-decides every turn.
- **Re-asserting the narrowed loadout whenever it drifts.** Rejected: it would fight another extension for control of the tool set with no way to tell whose intent is newer. Yielding is the safer failure direction.
- **A `--no-ptc` extension flag as the opt-out.** Rejected for the two mechanics in decision 5.

## Reopen triggers

- **pi exposes `execute` through `getAllTools()`** (or an equivalent tool-dispatch surface, ADR-0005's own reopen trigger) — then non-builtin tools can become bindings and `DEFAULT_HIDE_STRATEGY` can move to `"all-but-ptc"`.
- **pi gains a real negation form for extension boolean flags** — a `--no-ptc` flag becomes a viable opt-out alongside the config file.
- **Someone reports the mode fighting another extension** — the detection in decision 6 is set-membership based; a reported case would mean a peer is writing the loadout every turn, and the yield policy may need to become "disable for the session".
- **A `--tools`-restricted session is expected to still get the mode** — decision 4's fourth condition is the policy to revisit, not the code.

## Revert path

Delete `src/mode/`, drop the `session_start` / `before_agent_start` / `registerCommand` / status wiring from `src/index.ts` (restoring `getActiveToolNames: () => pi.getActiveTools()`), drop `promptSnippet` / `promptGuidelines` from both tool definitions, and remove `@earendil-works/pi-tui` from `devDependencies`. `tests/ptc-mode.test.ts` and the mode-specific cases in `tests/tool-visibility.test.ts` go with them. The renderer work (ADR-less, in `src/tools/render.ts`) is independent and stays.
