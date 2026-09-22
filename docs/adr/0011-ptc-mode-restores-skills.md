# PTC mode restores the skills section pi withholds

pi advertises skills in the system prompt only when the session can actually open a skill file —
`const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool))`
(`pi-coding-agent`: `dist/core/system-prompt.js`). PTC mode (ADR-0010) hides exactly those two
tools, so the gate silently drops the whole `<available_skills>` section, and the model loses its
only way to learn that skills exist. The mode therefore writes `sections.skills` back itself.

Status: accepted (2026-09-22). Fixes a regression introduced by ADR-0010 (its Consequences did not
consider pi's prompt-side gating). Supersedes nothing; extends ADR-0010 §3.

## What the regression looked like

Session files record the built prompt as `SystemMessage.sections`. Every session in this repo
before PTC-mode-by-default carried a `skills` section with 43 skills; the first PTC session
carried none. Nothing in this package was broken — the section simply never got built, and
because it had never been tested from inside the mode, the loss was invisible until a skill could
not be loaded. A user-invoked `/skill:name` still works (it expands the body directly), which is
what made the failure look like "the model can't read skills" rather than "the prompt lost a
section".

## Decision

**1. Restore the section from the mode's own hook.** `before_agent_start` already runs in this
extension; it now writes `event.systemPromptOptions.sections.skills` whenever the mode is on and
neither `read` nor `bash` is directly callable. Custom sections are merged after pi's own
(`system-prompt.js`), so this one wins, and pi still does the `<skills>…</skills>` wrapping and
the `SystemMessage.sections` bookkeeping.

**2. The list body stays pi's.** `formatSkillsForPrompt` is a public export
(`@earendil-works/pi-coding-agent`) and its XML shape is the agentskills.io spec, so the body is
used verbatim — including its `disable-model-invocation` filter, which is the correct behaviour to
inherit (`/skill:name`-only skills must not be advertised). Re-deriving the format here would only
create drift, and a test asserts pi's wording is still the one being replaced.

**3. Only the loading sentence changes.** pi's "Use the read tool to load a skill's file…" is false
in a session where `read` is hidden; it becomes `Use tools.read({ path }) inside a ptc_run_code
program to load a skill's file…`. If pi ever rewords its header, the code prepends the PTC
sentence instead of inheriting a sentence that names a tool the session cannot call.

**4. The injection is undone when the mode stops hiding those tools.** The options object outlives
the mode (and is reused on resume), so a `/ptc off` — or a peer extension taking the loadout —
must not leave PTC-flavoured instructions behind while `read` is callable again. Both paths clear
the section, and the model gets pi's native one back.

## Considered options

- **A compact index (names + locations, descriptions dropped).** Much cheaper, but the description
  is what lets the model pick the right skill; the whole point of restoring the section is that
  selection works as it does outside the mode.
- **On-demand discovery only.** Tell the model the skill directories in the briefing and let it
  `ls`/`read` when it thinks to. Costs zero tokens per turn, and was rejected: the model cannot
  look for what it does not know exists, so skill use becomes a coincidence.
- **Patch pi so the gate considers extension-provided file access.** The honest long-term fix
  (an extension that binds `read` _can_ load a skill file), but it is upstream's call. Worth
  filing; not a reason to keep the regression.

## Consequences

- **Every turn in PTC mode pays for the section.** With this developer's setup it is 68 loaded
  skills, 41 advertisable, ~17.8k characters ≈ 4.9k tokens per request. That is the price of
  parity with a non-PTC session, and it is also why pi gated it; the compact and on-demand options
  above are the levers if the cost ever needs to come down.
- The mode now depends on one public pi export plus one documented hook contract, both of which the
  tests exercise through the real handler rather than a copy of it.
