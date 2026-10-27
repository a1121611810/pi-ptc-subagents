#!/bin/bash
# 发版前手工全量冒烟：16 个 pi 版本 × (ptc_run_code + 程序内真派发 wait)。
# 用法：bash scripts/version-smoke.sh（不进 CI——装 16 个 pi 版本是网络重活，价值在发版前这一次）
# 素材自愈：shim 缺了自动 npm install pi@<ver> 到 $SHIM_ROOT/ptc-smoke-pi-<ver>；
# 已存在的 /tmp/pi-<ver>（与 /tmp/pi086）直接复用。
# 判定（与 6.1.0 基线一致，全版本统一）：RUN=42 + TASK= 非空 + 0 个 "isError":true。
# 程序内建任务走扩展自己的 binding（不经 executeTool），floor 也真派发——无版本豁免。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO/packages/entry/dist/index.js"
OUT="${TMPDIR:-/tmp}/ptc-version-smoke"
SHIM_ROOT="${SHIM_ROOT:-/tmp}"
mkdir -p "$OUT"; rm -f "$OUT"/*.log

VERSIONS="0.86.0 0.86.1 0.87.0 0.87.1 0.99.0 0.99.1 0.99.2 1.0.0 1.0.1 1.0.2 1.0.3 1.0.4 1.1.0 1.2.0 1.3.0"

PROMPT='做两件事，最后严格只输出一行 RUN=<结果1> TASK=<结果2>：1) 调用 ptc_run_code 求值 6*7，把程序返回值作为结果1；2) 再调用 ptc_run_code，程序体为：const r = await tools.pi_task_ptc({ task: "只回答：1+1 等于几", wait: true }); return r.report?.summary ?? r.text; 把程序返回值作为结果2。'

shim_for() { # $1=version → 输出 bin 目录；缺 shim 先装
  local want="$1"
  local dir=""
  if [ "$want" = "0.86.0" ] && [ -x "$SHIM_ROOT/pi086/node_modules/.bin/pi" ]; then
    dir="$SHIM_ROOT/pi086"
  elif [ -x "$SHIM_ROOT/pi-$want/node_modules/.bin/pi" ]; then
    dir="$SHIM_ROOT/pi-$want"
  else
    dir="$SHIM_ROOT/ptc-smoke-pi-$want"
    if [ ! -x "$dir/node_modules/.bin/pi" ]; then
      echo "… 装 pi@$want 到 $dir" >&2
      mkdir -p "$dir"
      (cd "$dir" && npm init -y >/dev/null 2>&1 && npm install "pi@$want" --no-fund --no-audit >/dev/null 2>&1) || true
    fi
  fi
  [ -x "$dir/node_modules/.bin/pi" ] && echo "$dir/node_modules/.bin"
}

run() { # $1=version（"PATH" = 当前 PATH 上的现行版）
  local want="$1"
  local bindir=""
  local log="$OUT/${want//./-}.log"
  if [ "$want" != "PATH" ]; then
    bindir="$(shim_for "$want")"
    if [ -z "$bindir" ]; then echo "$want INSTALL-FAIL"; return 1; fi
  fi
  local realver=""
  if [ -n "$bindir" ]; then
    realver="$(PATH="$bindir:$PATH" pi --version 2>/dev/null | head -1)"
    PATH="$bindir:$PATH" timeout 180 pi -ne -e "$EXT" -p "$PROMPT" >"$log" 2>&1
  else
    realver="$(pi --version 2>/dev/null | head -1)"
    timeout 180 pi -ne -e "$EXT" -p "$PROMPT" >"$log" 2>&1
  fi
  local run_ok="FAIL"
  local task_ok="FAIL"
  local err_ok="OK"
  grep -q "RUN=42" "$log" && run_ok="OK"
  grep -qE "TASK=[^[:space:]]+" "$log" && task_ok="OK"
  grep -q '"isError":true' "$log" && err_ok="FAIL"
  echo "$want"（实际 "$realver"）run_code="$run_ok" dispatch="$task_ok" isError="$err_ok"
  [ "$run_ok" = "OK" ] && [ "$task_ok" = "OK" ] && [ "$err_ok" = "OK" ]
}

fails=0
for ver in $VERSIONS; do run "$ver" || fails=$((fails + 1)); done
run "PATH" || fails=$((fails + 1)) # 现行版 = PATH 上的 pi（实际版本号在输出里自报）
echo "SMOKE-DONE fails=$fails"（日志 "$OUT"）
exit $((fails > 0))
