#!/usr/bin/env bash
# PROTOTYPE — throwaway. The last open question for F2.
#
# ADR-0033 exists because the settings-side mirror cannot see MCP auto-enable: pi calls
# setActiveTools when an enabled MCP server's tools are codemode-only. If that happens
# BEFORE session_start, getActiveTools() sees it and the file-side evidence is redundant.
# If it happens AFTER, getActiveTools() at session_start is a stale answer and F2 would
# regress every MCP user from `subagents` to `full`.
#
# Three fixtures, same project, same trust decision:
#   mcp-on    — autoEnableCodemode default (true), one codemode-exposed server
#   mcp-off   — autoEnableCodemode: false, otherwise identical
#   no-mcp    — no project mcp.json at all (the control)
#
# A server that will not actually start is deliberate: ADR-0033 records that pi computes
# the decision from the config BEFORE servers connect, so a dead server is the honest test.
set -uo pipefail

MATRIX="${MATRIX:-/tmp/pi-matrix}"
EXT="$(cd "$(dirname "$0")" && pwd)/f2-probe-ext.mjs"
VERSIONS="${VERSIONS:-v0.99.0 v1.0.0 v1.0.4 v1.1.0}"

WORK="$(mktemp -d /tmp/f2mcp.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/proj/.pi" "$WORK/sess"

SERVER='{"mcpServers":{"probe":{"command":"probe-never-starts","exposure":"codemode"}}}'

for v in $VERSIONS; do
  PKG="$MATRIX/$v/node_modules/@earendil-works/pi-coding-agent"
  BIN="$PKG/dist/bundle/cli.js"
  [ -f "$BIN" ] || { echo "$v NO_BINARY"; continue; }
  VERSION="$(node -p "require('$PKG/package.json').version" 2>/dev/null || echo '?')"

  for fixture in no-mcp mcp-on mcp-off; do
    printf '{ "defaultTools": [] }\n' > "$WORK/proj/.pi/settings.json"
    case "$fixture" in
      mcp-on)  printf '%s\n' "$SERVER" > "$WORK/proj/.pi/mcp.json" ;;
      mcp-off) printf '%s\n' "${SERVER/\"probe\"/\"probe\"}" | sed 's/^{/{"autoEnableCodemode": false,/' > "$WORK/proj/.pi/mcp.json" ;;
      *)       rm -f "$WORK/proj/.pi/mcp.json" ;;
    esac

    OUT="$WORK/$v-$fixture.log"
    (
      cd "$WORK/proj" || exit 1
      F2_PROBE_VERSION="$VERSION" timeout 180 node "$BIN" -a \
        --session-dir "$WORK/sess" -e "$EXT" \
        --mode json -p "reply with the single word OK" >"$OUT" 2>&1
    )
    # Only the two fields that answer the question.
    LINE=$(grep -o '\[F2PROBE\].*"phase":"session_start".*' "$OUT" | head -1)
    if [ -z "$LINE" ]; then
      printf '%-8s %-8s %s\n' "$VERSION" "$fixture" "NO_SESSION_START_LINE"
      grep -iE "Extension error|ERR_MODULE" "$OUT" | head -1
      continue
    fi
    ACTIVE=$(printf '%s' "$LINE" | grep -o '"codemodeInActiveSet":[a-z]*' | cut -d: -f2)
    DT=$(printf '%s' "$LINE" | grep -o '"settingsDefaultTools":[^,]*' | cut -d: -f2-)
    printf '%-8s %-8s codemodeInActiveSet=%-6s defaultTools=%s\n' "$VERSION" "$fixture" "${ACTIVE:-?}" "${DT:-?}"
  done
  echo "---"
done

echo "WORK_DIR_WIPED=$WORK"