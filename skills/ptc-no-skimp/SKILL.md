---
name: ptc-no-skimp
description: Toggle no-skimp mode (noSkimpPtc / noSkimpSub) — use when the user wants the agent to run the real thing instead of mock-level shortcuts, or asks how these two switches are turned on and off.
---

# No-skimp mode (a double-edged sword)

Two switches, both **off** by default:

| Switch       | Where                                                            | What it changes                                                                                                                                        |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `noSkimpPtc` | `~/.pi/agent/ptc.json` (pi), `~/.kimi-code/ptc.json` (Kimi face) | The parent's prompt gets one extra paragraph: make the real calls, run the end-to-end checks, don't substitute mocks, don't skip a slow-but-real check |
| `noSkimpSub` | `~/.pi/agent/ptc.json`                                           | Every child's system prompt gets the same paragraph                                                                                                    |

Provenance: the wording comes from DeepSeek Harness's `docs/testing.zh.md` §带密钥策略 —
「不要吝惜真实 API 测试；无密钥测试只能证明底层通路」. It says what to _do_ (run the real thing),
not how much to spend.

## Turning them on and off

- **In a pi TUI session**: `/ptc noskimp on|off|reset` and `/ptc noskimp-sub on|off|reset`.
  `reset` drops the session override and falls back to the config file. Session overrides are never written to disk.
- **Persistently**: put `{"noSkimpPtc": true, "noSkimpSub": true}` in `~/.pi/agent/ptc.json`.
  Only an explicit `true` turns a switch on — a missing file, bad JSON or any other value means off.
- On the Kimi face there is no `/ptc` command and no banner: edit `~/.kimi-code/ptc.json` and restart the MCP server.

## Rules

- **Do not edit `ptc.json` yourself.** That file is where the user grants spending; an agent editing it is an agent approving its own spending. Ask the user to run the command or to edit the file.
- While a switch is on, the pi TUI shows a standing banner and `/ptc` echoes the current state of both switches.
- The cost is real: real calls and end-to-end checks are slower and more expensive. `timeoutMs`, the stall guard and the dispatch slot counter still apply.

## What it does not do

It changes one paragraph of prompt text and nothing else: no gate, no tool narrowing, no model or thinking-level override,
and **no budget is raised** — the name describes an action, not a capacity.

Measured on this repo's harness (2026-11-03, two models, 32 usable instance-pairs across F2P=1..168):
**no quality gain**, only +8–34% tokens; the 3 discordant pairs all favoured the OFF arm.
Use it when mocked runs have actually misled you, not as a "try harder" switch.

The previous name was `maxTokenToPTC` / `maxTokenToSub` ("unlimited token budget"); it was retired on
2026-11-03 because it claimed a cap was lifted (none was) and its wording only bought more output.
