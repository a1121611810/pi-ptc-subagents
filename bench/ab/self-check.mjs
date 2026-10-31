#!/usr/bin/env node
/**
 * 判分器自检：每道题跑两条——
 *   正例：参考答案 → 判分器必须满分（failed=0 / error=0 / passed>0）
 *   负例：人为破坏 → 判分器必须抓到（failed>0）
 * 两条都过才算这道题的判分器可用；任一条不过 → 退出码非 0，**不许开跑正式实验**。
 *
 * 用法：node bench/ab/self-check.mjs
 *
 * 为什么要有这个：判分脚本是头号误差源。历史上踩过「按文件位置推仓库根 → 找到 0 个模块」、
 * 「把 Markdown 标题当条目 → 假失败」、「judge 少返回几条 check → 分母变小、分数虚高」。
 * 每写完一个用例先自检，别拿「跑出来的分数」当判分器正确的证据。
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const AB = join(REPO, "bench/ab");

/** 跑 python 脚本，返回 stdout */
function py(cwd, args) {
  const run = spawnSync("uv", ["run", "--quiet", "python", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 300000,
  });
  return { out: `${run.stdout ?? ""}${run.stderr ?? ""}`, code: run.status };
}

/** 跑判分器（按 grader 目录里的 check_*.py / test_*.py），返回归一后的结果 */
function grade(workspace, graderDir) {
  const checkerFiles = [
    "check_wide.py",
    "check_agg.py",
    "check_fanout.py",
    "check_facts.py",
  ].filter((f) => existsSync(join(graderDir, f)));
  if (checkerFiles.length > 0) {
    // 判分器要拷进工作区再跑（与台架 objectiveGrade 同款做法——脚本按 cwd 定位）
    for (const f of checkerFiles) cpSync(join(graderDir, f), join(workspace, f));
    // ground truth 也要在工作区里（判分器按 cwd 读它）
    if (existsSync(join(graderDir, "truth.json"))) {
      cpSync(join(graderDir, "truth.json"), join(workspace, "truth.json"));
    }
    const checker = spawnSync("uv", ["run", "--quiet", "python", checkerFiles[0]], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 300000,
    });
    const raw = `${checker.stdout ?? ""}`.trim().split("\n").pop() ?? "";
    try {
      return { kind: "checker", ...JSON.parse(raw) };
    } catch {
      return {
        kind: "checker",
        passed: 0,
        failed: 1,
        error: 0,
        details: [`非 JSON 输出: ${raw.slice(0, 120)}`],
      };
    }
  }
  // 窄题：隐藏 pytest
  mkdirSync(join(workspace, "tests"), { recursive: true });
  for (const file of ["test_coupons_hidden.py"]) {
    const src = join(graderDir, file);
    try {
      cpSync(src, join(workspace, "tests", file));
    } catch {
      /* 隐藏测试不在 → 判分器缺料，自检里会体现为 0 passed */
    }
  }
  const pytest = spawnSync("uv", ["run", "--quiet", "pytest", "-q", "--no-header"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 300000,
  });
  const out = `${pytest.stdout ?? ""}\n${pytest.stderr ?? ""}`;
  return {
    kind: "pytest",
    passed: Number(/(\d+) passed/.exec(out)?.[1] ?? 0),
    failed: Number(/(\d+) failed/.exec(out)?.[1] ?? 0),
    error: Number(/(\d+) error/.exec(out)?.[1] ?? 0),
    details: [],
  };
}

function makeWorkspace(taskDir) {
  const dir = mkdtempSync(join(tmpdir(), "ab-selfcheck-"));
  cpSync(join(AB, taskDir), dir, { recursive: true });
  return dir;
}

const CASES = [
  {
    name: "窄题（隐藏 pytest）",
    task: "task-repo",
    grader: "grader",
    solve(ws) {
      // 参考解必须自包含：题面要求同时改 pricing.py 的 calculate_total，
      // 只塞 coupons.py 会因缺字段而假失败（自检的意义就在这）
      mkdirSync(join(ws, "src/ordercalc"), { recursive: true });
      cpSync(join(AB, "fixtures/narrow/src/ordercalc"), join(ws, "src/ordercalc"), {
        recursive: true,
      });
    },
    break(ws) {
      rmSync(join(ws, "src/ordercalc/coupons.py"), { force: true });
    },
  },
  {
    name: "宽题（check_wide.py）",
    task: "task-repo-wide",
    grader: "grader-wide",
    solve(ws) {
      py(ws, [join(AB, "fixtures/wide-solution.py")]);
    },
    break(ws) {
      const target = join(ws, "src/inventory/collections_01.py");
      const text = readFileSync(target, "utf8");
      writeFileSync(target, text.replace(/^""".*?"""\n\n/s, ""), "utf8");
    },
  },
  {
    name: "归约题（check_agg.py）",
    task: "task-repo-wide",
    grader: "grader-agg",
    solve(ws) {
      py(ws, [join(AB, "fixtures/agg-solution.py")]);
    },
    break(ws) {
      const target = join(ws, "docs/stats.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(target, text.replace(/\| (\w+_\d+\.py) \| \d+ \|/, "| $1 | 999 |"), "utf8");
    },
  },
  {
    name: "扇出题（check_fanout.py）",
    task: "task-repo-fanout",
    grader: "grader-fanout",
    solve(ws) {
      py(ws, [join(AB, "fixtures/fanout-solution.py")]);
    },
    break(ws) {
      // 破坏汇总表里的一个行数（其余保持正确）——判分器必须抓到，不能放过
      const target = join(ws, "docs/pkgcards/index.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(
        target,
        text.replace(/\| alpha \| [^|]*\| (\d+) \|/, "| alpha | $1x| 999 |"),
        "utf8",
      );
    },
  },
  {
    name: "扇出题 24 包版（同一份判分器）",
    task: "task-repo-wide",
    grader: "grader-fanout",
    solve(ws) {
      py(ws, [join(AB, "fixtures/fanout-solution.py")]);
    },
    break(ws) {
      // 破坏一张卡里的一个参数名——判分器必须抓到
      const target = join(ws, "docs/pkgcards/totals_01.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(
        target,
        text.replace("| sum_values | values |", "| sum_values | values, bogus |"),
        "utf8",
      );
    },
  },
  {
    name: "facts 题（check_facts.py：父汇总 + 子代理 + 保真度）",
    task: "task-facts",
    grader: "grader-facts",
    solve(ws) {
      py(ws, [join(AB, "fixtures/facts-solution.py")]);
    },
    break(ws) {
      // 改错父汇总里的一条数值——判分器必须抓到
      const target = join(ws, "final_answer.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(target, text.replace("F1-3 = 218.25", "F1-3 = 999"), "utf8");
    },
  },
  {
    name: "facts 题·保真度（子代理没产出 + 父自己补 = 幻觉）",
    task: "task-facts",
    grader: "grader-facts",
    solve(ws) {
      py(ws, [join(AB, "fixtures/facts-solution.py")]);
    },
    break(ws) {
      // 删掉 topic-2 的子代理记录（它没产出），但父汇总里 F2-* 还在 → 判分器必须报幻觉
      rmSync(join(ws, ".pi/ptc-tasks/records/child-2.json"), { force: true });
    },
    // 幻觉不体现在 passed/failed 里（父的答案确实对）→ 必须靠 fidelity 字段抓住
    check: (r) => (r.fidelity?.hallucinated ?? []).length > 0,
  },
  {
    name: "facts 题·编造（父输出里出现 ground truth 没有的事实 id）",
    task: "task-facts",
    grader: "grader-facts",
    solve(ws) {
      py(ws, [join(AB, "fixtures/facts-solution.py")]);
    },
    break(ws) {
      const target = join(ws, "final_answer.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(target, `${text}\nF9-9 = 42`, "utf8");
    },
    check: (r) => (r.fidelity?.fabricated ?? []).includes("F9-9"),
  },
];

let allOk = true;
const rows = [];
for (const c of CASES) {
  const graderDir = join(AB, c.grader);
  const ws = makeWorkspace(c.task);
  c.solve(ws);
  const positive = grade(ws, graderDir);
  c.break(ws);
  const negative = grade(ws, graderDir);
  rmSync(ws, { recursive: true, force: true });

  const positiveOk =
    positive.passed > 0 && (positive.failed ?? 0) === 0 && (positive.error ?? 0) === 0;
  const negativeOk =
    (negative.failed ?? 0) > 0 ||
    (negative.error ?? 0) > 0 ||
    (c.check ? Boolean(c.check(negative)) : false);
  if (!positiveOk || !negativeOk) allOk = false;
  rows.push({
    用例: c.name,
    正例: `${positive.passed} passed / ${positive.failed} failed / ${positive.error} error`,
    正例判定: positiveOk ? "PASS" : "FAIL",
    负例: `${negative.passed} passed / ${negative.failed} failed / ${negative.error} error`,
    负例判定: negativeOk ? "PASS" : "FAIL",
  });
}

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
if (!allOk) {
  process.stdout.write("\n[自检 FAIL] 判分器不可信——先修判分器，别开跑正式实验。\n");
  process.exit(1);
}
process.stdout.write("\n[自检 PASS] 四道题的判分器正例满分、负例能抓到。\n");
