#!/bin/bash
# 发版前手工全量冒烟：16 个 pi 版本 × 四腿契约（覆盖 0.99 分水岭两侧）。
# 用法：bash scripts/version-smoke.sh；SMOKE_VERSIONS="1.3.0" 只跑指定版本（快查）。
# 四腿：RUN=42（run_code 求值）· READ（程序内 tools.read——≥0.99 走 executeTool 通道返回数字，
# floor 明确报 ERR:）· PAR=2（ptc_workflow 的 parallel allSettled）· HND 非空（wait:false
# handle + 任务面 list/output 活）。判定：RUN=42 + READ/PAR/HND + 0 个 "isError":true。
# 素材自愈：shim 缺了自动 npm install pi@<ver> 到 $SHIM_ROOT/ptc-smoke-pi-<ver>；
# 已存在的 /tmp/pi-<ver>（与 /tmp/pi086）直接复用。
# 程序内建任务走扩展自己的 binding（不经 executeTool），floor 也真派发。
# 不做（版本敏感度低或不可脚本化）：codemode 面/rpc/TUI/stop 阶梯/通知/web_ds_search——
# 引擎侧有 node tests 守，真机交互有手工冒烟记录在案。
# 依赖 GNU coreutils 的 timeout（全新 macOS 需先 brew install coreutils）。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO/packages/entry/dist/index.js"
OUT="${TMPDIR:-/tmp}/ptc-version-smoke"
SHIM_ROOT="${SHIM_ROOT:-/tmp}"
mkdir -p "$OUT"; rm -f "$OUT"/*.log

VERSIONS="${SMOKE_VERSIONS:-0.86.0 0.86.1 0.87.0 0.87.1 0.99.0 0.99.1 0.99.2 1.0.0 1.0.1 1.0.2 1.0.3 1.0.4 1.1.0 1.2.0 1.3.0}"

PROMPT='做四件事，最后严格只输出一行 RUN=<r> READ=<d> PAR=<p> HND=<h>：1) 调用 ptc_run_code 求值 6*7，作为 r；2) 调用 ptc_run_code，程序体为：let d; try { const t = await tools.read({ path: "package.json" }); d = typeof t === "string" ? t.length : -1; } catch (e) { d = "ERR:" + String((e && e.message) || e).slice(0, 24); } return d; 把程序返回值作为 d；3) 调用 ptc_workflow，meta 为 {name:"smoke",description:"smoke"}，script 为：const rs = await workflow.parallel([() => Promise.resolve(1), () => Promise.resolve(2)]); return rs.length; 把程序返回值作为 p；4) 先调用 tools.pi_task_ptc({ task: "只回答：1+1 等于几", wait: false }) 拿到 handle，随后调用 ptc_task_list 和 ptc_task_output（task_id 用 handle.taskId）确认任务面有记录，把 handle.taskId 作为 h。'

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
      # ⚠️ 包名不是 `pi`：npm 上的 `pi` 是 IonicaBizau/pi-number（算 π 的数学库，没有 pi 这个 bin）。
      # 真包名是 @earendil-works/pi-coding-agent（0.80.1 起，0.86.0 = floor）。写错会装成别的包、
      # 拿不到 bin → INSTALL-FAIL，看起来像「老版本装不上」。
      (cd "$dir" && npm init -y >/dev/null 2>&1 && npm install "@earendil-works/pi-coding-agent@$want" --no-fund --no-audit >/dev/null 2>&1) || true
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
    PATH="$bindir:$PATH" timeout 300 pi -ne -e "$EXT" -p "$PROMPT" >"$log" 2>&1
  else
    realver="$(pi --version 2>/dev/null | head -1)"
    timeout 300 pi -ne -e "$EXT" -p "$PROMPT" >"$log" 2>&1
  fi
  local run_ok="FAIL"
  local read_ok="FAIL"
  local par_ok="FAIL"
  local hnd_ok="FAIL"
  local err_ok="OK"
  grep -q "RUN=42" "$log" && run_ok="OK"
  # READ 腿分侧：floor（0.86/0.87，无 executeTool 通道）明确报 ERR: 即语义正确；≥0.99 要数字
  if [[ "$want" == 0.86.* || "$want" == 0.87.* ]]; then
    grep -qE "READ=ERR:[^[:space:]]*" "$log" && read_ok="OK"
  else
    grep -qE "READ=[0-9]+" "$log" && read_ok="OK"
  fi
  grep -qE "PAR=2([^0-9]|$)" "$log" && par_ok="OK"
  grep -qE "HND=[0-9a-f-]+" "$log" && hnd_ok="OK"
  grep -q '"isError":true' "$log" && err_ok="FAIL"
  echo "$want"（实际 "$realver"）run_code="$run_ok" read="$read_ok" workflow="$par_ok" task_face="$hnd_ok" isError="$err_ok"
  [ "$run_ok" = "OK" ] && [ "$read_ok" = "OK" ] && [ "$par_ok" = "OK" ] && [ "$hnd_ok" = "OK" ] && [ "$err_ok" = "OK" ]
}

fails=0
for ver in $VERSIONS; do run "$ver" || fails=$((fails + 1)); done
run "PATH" || fails=$((fails + 1)) # 现行版 = PATH 上的 pi（实际版本号在输出里自报）
echo "SMOKE-DONE fails=$fails"（日志 "$OUT"）
exit $((fails > 0))
