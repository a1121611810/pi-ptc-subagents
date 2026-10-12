#!/bin/bash
# PROTOTYPE — throwaway driver for the fullscreen TUI matrix.
#
# One variable changes across a pair: the extension path (A = this tree, B = the installed 2.0.3).
# Everything else — provider, model, flags, wait — is identical, which is the only reason a
# difference in the captures means anything.
#
# `configured` gets its own cwd: the notice fires on an EMPTY registry, so proving the pair is
# about SUPPRESSION rather than "B never warns" needs a run where the registry is NOT empty.
set -u
cd "$(dirname "$0")/.."
PROTO="prototypes/__tui-check.exp"
A="$(pwd)/dist/index.js"
B="$HOME/.pi/agent/npm/node_modules/pi-ptc-subagents"
CFG="${TUI_CFG_CWD:-/tmp/tui-cfg}"

run() { # <tag> <scenario> <ext>
  local tag="$1"
  local scenario="$2"
  local ext="$3"
  local out="/tmp/fs-${tag}.txt"
  : > "$out"
  if [ "$scenario" = "configured" ]; then
    TUI_CWD="$CFG" TUI_WAIT="${TUI_WAIT:-25}" TUI_AFTER="${TUI_AFTER:-75}" \
      expect "$PROTO" "$scenario" "$ext" "$out" 2>&1 | sed "s/^/  [$tag] /"
  else
    TUI_WAIT="${TUI_WAIT:-25}" TUI_AFTER="${TUI_AFTER:-75}" \
      expect "$PROTO" "$scenario" "$ext" "$out" 2>&1 | sed "s/^/  [$tag] /"
  fi
}

for scenario in boot configured dispatch codemode; do
  run "A-${scenario}" "$scenario" "$A"
  run "B-${scenario}" "$scenario" "$B"
done

echo
echo "=== counts: bytes altScreen typedLanded noRegisteredAgent PTC ==="
for scenario in boot configured dispatch codemode; do
  for side in A B; do
    f="/tmp/fs-${side}-${scenario}.txt"
    printf '%-22s %7s %3s %6s %10s %3s\n' \
      "${side}-${scenario}" \
      "$(wc -c < "$f" | tr -d ' ')" \
      "$(grep -ac $'\033\[?1049h' "$f")" \
      "$(grep -acE 'ptc_subagent with NO agent|ptc_run_code to compute' "$f")" \
      "$(grep -ac 'no registered agent' "$f")" \
      "$(grep -ao 'PTC' "$f" | wc -l | tr -d ' ')"
  done
done