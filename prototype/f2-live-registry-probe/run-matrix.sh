#!/usr/bin/env bash
# PROTOTYPE — throwaway. Runs f2-probe-ext.mjs against each pi version's OWN binary, in a
# controlled project, under both trust decisions, and prints one verdict row per version.
#
# Two trust scenarios per version because G2 is only meaningful as a DIFF:
#   trusted   → the project's `defaultTools` should be visible in pi's settings
#   untrusted → pi must NOT be showing it, or "read pi's answer" buys nothing
#
# Real credentials are read from the real agent dir (never copied, never printed) because
# G4 is unanswerable without a real provider request. Session output goes to a temp dir.
set -uo pipefail

MATRIX="${MATRIX:-/tmp/pi-matrix}"
EXT="$(cd "$(dirname "$0")" && pwd)/f2-probe-ext.mjs"
VERSIONS="${VERSIONS:-v0.86.1 v0.87.1 v0.99.0 v0.99.1 v0.99.2 v1.0.0 v1.0.4 v1.1.0}"

WORK="$(mktemp -d /tmp/f2probe.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/proj/.pi" "$WORK/sess"
printf '{ "defaultTools": ["+codemode"] }\n' > "$WORK/proj/.pi/settings.json"

for v in $VERSIONS; do
  PKG="$MATRIX/$v/node_modules/@earendil-works/pi-coding-agent"
  BIN="$PKG/dist/bundle/cli.js"
  [ -f "$BIN" ] || { printf '%s\t%s\n' "$v" "NO_BINARY"; continue; }
  VERSION="$(node -p "require('$PKG/package.json').version" 2>/dev/null || echo '?')"

  for trust in -a -na; do
    LABEL="$trust"
    OUT="$WORK/$v$trust.log"
    (
      cd "$WORK/proj" || exit 1
      F2_PROBE_VERSION="$VERSION" timeout 180 node "$BIN" "$trust" \
        --session-dir "$WORK/sess" -e "$EXT" \
        --mode json -p "reply with the single word OK" >"$OUT" 2>&1
    )
    echo "=== $v ($VERSION) trust=$LABEL ==="
    grep -o '\[F2PROBE\].*' "$OUT" | sed 's/^\[F2PROBE\] //'
    grep -iE "Extension error|Command not found|ERR_MODULE" "$OUT" | head -2
  done
done

echo
echo "WORK_DIR_WIPED=$WORK"