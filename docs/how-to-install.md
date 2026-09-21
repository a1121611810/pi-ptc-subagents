# Installing pi-ptc-subagents

## Global install (the "default-on" flow)

```bash
pi install /abs/path/to/pi-ptc-subagents    # local checkout
# or, once published:
pi install npm:pi-ptc-subagents
```

What this does: appends the source to the `packages` array in
`~/.pi/agent/settings.json`, e.g.

```json
{ "packages": ["…", "../../develop/pi-ptc-subagents"] }
```

Note the stored form: pi rewrites a local path **relative to the settings file's
directory** — an absolute path you pass becomes a `../../…`-style entry, and
`pi list` resolves it back to the absolute path. That is pi's normalization, not
a different install method: the command is always `pi install <path>`.

pi reads the package's `pi.extensions` manifest field (`./dist/index.js`), so on
the **next pi startup** the extension loads with no further steps — `ptc_run_code`
and `ptc_workflow` are simply there.

Local installs load `dist/` in place: run `npm run build` after source changes,
and re-run `pi install` only if the path itself moves.

## Verify

```bash
pi list   # the package appears, resolved to its absolute path

pi -p --no-session --no-builtin-tools --tools ptc_run_code --mode json \
  "Use ptc_run_code with this program: return 'ok';" | grep tool_execution
```

The second command should show a `tool_execution_end` whose result text is `ok`.

## Project-scoped install

```bash
pi install -l /abs/path/to/pi-ptc-subagents
```

Writes `.pi/settings.json` instead (commit-shareable with a team; pi installs
project packages after the project is trusted).

## Uninstall / disable

```bash
pi remove /abs/path/to/pi-ptc-subagents    # drops the settings entry
pi uninstall /abs/path/to/pi-ptc-subagents # alias
```

Runtime disable without a full uninstall: `pi config` (interactive), or edit the
entry in `settings.json` to `{"source": "…", "extensions": []}`.

## Notes

- **Tool-name conflict**: the legacy `pi-ptc` extension registers the same
  `ptc_run_code` / `ptc_workflow` names — do not keep both enabled.
- **Trust posture**: installing this package grants it your user identity; PTC
  tool calls bypass pi's `tool_call` hooks. See the README and ADR-0005/0007
  before deploying it somewhere that relies on those guards.
