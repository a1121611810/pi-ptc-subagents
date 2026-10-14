#!/usr/bin/env bash
#
# PROTOTYPE — throwaway. Answers ONE question:
#   Does the #73 bash opt-in actually take effect inside a real `pi` session,
#   or only inside the test suite?
#
# The suite drives the binding table directly. This drives a real pi subprocess
# with a real model, and asks the model to do the only thing that matters:
# call `tools.bash` from inside a PTC program.
#
# Two arms, identical prompt, identical extension, differing ONLY in
# `~/.pi/agent/ptc.json`:
#   arm 1  no ptc.json            → tools.bash must be REFUSED
#   arm 2  optInBindings:[bash]   → tools.bash must actually RUN
#
# Why a temp agent dir: `getAgentDir()` honours PI_CODING_AGENT_DIR, so this
# never reads or writes the real ~/.pi/agent. auth.json is symlinked in so a
# model resolves; nothing else is carried over.
#
# Run:  bash scripts/PROTOTYPE-optin-e2e.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/dist/index.js"
MODEL="${PT_SMOKE_MODEL:-deepseek/deepseek-flash}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ptc-optin-proto.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

MARKER="OPTIN_E2E_$(date +%s)"
# The program is fixed text so both arms differ only by the config file, and the
# marker is unique per run so a stale answer cannot be mistaken for a fresh one.
PROGRAM="return await tools.bash({ command: 'echo ${MARKER}' });"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

printf '\033[1m#73 opt-in · real-pi prototype\033[0m\n'
printf 'dist    : %s\n' "$DIST"
printf 'model   : %s\n' "$MODEL"
printf 'marker  : %s\n' "$MARKER"
printf 'agentdir: %s (isolated; your real ~/.pi/agent is untouched)\n\n' "$WORK"

[ -f "$DIST" ] || die "no build — run: pnpm run build"
command -v pi >/dev/null || die "pi is not on PATH"
grep -q "optInBindings" "$DIST" || die "dist/index.js has no optInBindings — you are testing the OLD build"

# auth.json only: it is what lets a model resolve. No settings, no extensions.
ln -s "$HOME/.pi/agent/auth.json" "$WORK/auth.json" 2>/dev/null || true

run_arm() {
  # $1 = arm label, $2 = expected verdict (REFUSED | RAN)
  local label="$1" expect="$2" out rc
  out="$(cd "$WORK" && PI_CODING_AGENT_DIR="$WORK" timeout 240 pi \
        -ne -nc -ns -np \
        -e "$DIST" \
        --print --no-session \
        --model "$MODEL" \
        --thinking off \
        "Call the ptc_run_code tool with this exact program and nothing else, then report the tool result verbatim, including any error text:

$PROGRAM" 2>&1)"
  rc=$?

  printf '\n\033[1m── arm %s (expect %s, exit %d) ──\033[0m\n' "$label" "$expect" "$rc"
  printf '%s\n' "$out" | tail -25 | sed 's/^/  /'

  # Verdict from the OBSERVED output, never from the exit code: pi --print
  # exits 0 on a model answer that contains a tool failure, so exit 0 would
  # report PASS for a program that was refused. This is the whole trap.
  local verdict="UNKNOWN"
  if printf '%s' "$out" | grep -q "$MARKER"; then verdict="RAN"; fi
  if printf '%s' "$out" | grep -qiE 'no binding named .bash.|bash is (not|un)|not bound|unknown binding'; then
    [ "$verdict" = "RAN" ] || verdict="REFUSED"
  fi

  printf '\n  \033[1mverdict: %s (expected %s)\033[0m\n' "$verdict" "$expect"
  [ "$verdict" = "$expect" ] && return 0 || return 1
}

fails=0

# PT_PROTO_ARMS lets a control run exercise one arm only — used to check that this
# harness actually discriminates (run arm 1 against a pre-change build: it must FAIL).
ARMS="${PT_PROTO_ARMS:-1 2}"

ran_arms=0
if [[ "$ARMS" == *1* ]]; then
  ran_arms=$((ran_arms+1))
  # arm 1 — no ptc.json at all.
  rm -f "$WORK/ptc.json"
  run_arm "1: default (no ptc.json)" REFUSED || { fails=$((fails+1)); }
fi

if [[ "$ARMS" == *2* ]]; then
  ran_arms=$((ran_arms+1))
  # arm 2 — explicit opt-in.
  printf '{ "optInBindings": ["bash"] }\n' > "$WORK/ptc.json"
  run_arm "2: optInBindings=[bash]" RAN || { fails=$((fails+1)); }
fi

printf '\n\033[1m── verdict ──\033[0m\n'
if [ "$fails" -eq 0 ]; then
  printf '\033[32m%d/%d arms matched: the opt-in takes effect in a real pi session.\033[0m\n' "$ran_arms" "$ran_arms"
else
  printf '\033[31m%d/%d arms did not match. Do not close #73 on the suite alone.\033[0m\n' "$fails" "$ran_arms"
fi
exit "$fails"