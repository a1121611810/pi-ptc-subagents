#!/bin/bash
# Kimi 面模型 A/B（方法论借自外部：Merge 六实践 + arXiv 2504.00914 同义改写/干扰健壮性）
# 维度：命中率 / 多余调用 / 参数正确 / 错误恢复 / 同义改写一致性
# 用法：bash scripts/kimi-model-ab.sh（写死两个模型别名；日志在 /tmp/ptc-ab-logs/）
set -u
KIMI=/Users/lilianda/.kimi-code/bin/kimi
MODEL_A="kimi-code/kimi-for-coding"
MODEL_B="MiniMax Token Plan/MiniMax-M3.1-Flash-512k"
R2=/tmp/ptc-r2
LOGS=/tmp/ptc-ab-logs
CASES=/Users/lilianda/develop/pi-ptc-subagents/scripts/ab-cases
mkdir -p "$LOGS"
rm -rf "$R2"

setup_fixture() {
  rm -rf "$R2"
  mkdir -p "$R2/src"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    {
      echo "alpha foo line"
      echo "beta token token line"
      if [ "$i" = "3" ] || [ "$i" = "7" ]; then echo "URGENT handle foo now"; fi
      echo "omega line"
    } > "$R2/src/f$i.txt"
  done
  printf 'padding %s\n' "$(printf 'x%.0s' $(seq 1 120))" >> "$R2/src/f5.txt"
  echo "legacy" > "$R2/legacy.txt"
  echo "first-line-content" > "$R2/a.txt"
}

run_case() { # $1=model $2=casename
  local model="$1" name="$2"
  local log="$LOGS/${model##*/}__${name}.log"
  local start code dur used
  start=$(date +%s)
  timeout 180 "$KIMI" -m "$model" -p "$(cat "$CASES/$name.txt")" > "$log" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))
  if grep -q "ptc_run_code" "$log"; then used="program"; else used="no-program"; fi
  echo "$model | $name | ${dur}s | exit=$code | tool=$used"
}

for model in "$MODEL_A" "$MODEL_B"; do
  echo "===== model: $model ====="
  setup_fixture

  run_case "$model" h1_count_lines
  setup_fixture
  run_case "$model" h2_batch_replace
  foo_left=$(grep -ro "foo" "$R2/src" | wc -l | tr -d " ")
  echo "  check h2: foo-left=${foo_left} (expect 0)"
  run_case "$model" h3_find_pattern
  run_case "$model" h4_rank_counts
  setup_fixture
  run_case "$model" h5_filter_reduce
  run_case "$model" p1_rephrase_direct
  run_case "$model" p2_rephrase_casual
  run_case "$model" p3_rephrase_vague
  run_case "$model" n1_single_read
  run_case "$model" n2_single_delete
  setup_fixture
  run_case "$model" e1_jail_recovery
  setup_fixture
  run_case "$model" c1_multiphase
  urgent_left=$(grep -rl "URGENT" "$R2/src" 2>/dev/null | wc -l | tr -d " ")
  done_mark=$(grep -r "\[DONE\]" "$R2/src" 2>/dev/null | wc -l | tr -d " ")
  echo "  check c1: urgent-left-files=${urgent_left} (expect 0), done-lines=${done_mark} (expect 2)"
done
echo "logs: $LOGS"
