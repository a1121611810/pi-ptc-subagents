// bench 面能力分片：判分器自检（判据脚本原地保留，探针只调用它）。
export default {
  capabilities: [
    {
      id: "grader-selfcheck",
      face: "bench",
      probe: "tests/bench/grader-selfcheck.test.ts",
      mutants: [
        {
          id: "grader-selfcheck.docstring-check-off",
          file: "bench/ab/grader-wide/check_wide.py",
          from: "if doc and doc.strip():",
          to: "if True:",
          why: "缺 docstring 不再判失败 ⇒ 宽题负例溜过去",
          kills: "判分器自检：正例满分",
        },
        {
          id: "grader-selfcheck.agg-count-check-off",
          file: "bench/ab/grader-agg/check_agg.py",
          from: "elif reported[name] != count:",
          to: "elif False:",
          why: "报的数量与真实值不符也不再判失败 ⇒ 归约题负例溜过去",
          kills: "判分器自检：正例满分",
        },
        {
          id: "grader-selfcheck.fanout-loc-check-off",
          file: "bench/ab/grader-fanout/check_fanout.py",
          from: 'check(got == expect, f"index.md: {name} 代码行数应为 {expect}，实际 {got}")',
          to: 'check(True, f"index.md: {name} 代码行数应为 {expect}，实际 {got}")',
          why: "代码行数不符不再判失败 ⇒ 扇出题负例溜过去",
          kills: "判分器自检：正例满分",
        },
      ],
    },
  ],
};
