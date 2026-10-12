/**
 * The site's README names the same checks the site runner invokes.
 *
 * `packages/website/README.md` is the operational reference for the site: every check, what it
 * catches, and what turns it red. It is a list, and a list in a document is a drift source — the
 * same failure this repository has now paid for three times in one week. This test is what keeps
 * the third step of "add a check" from being the step everyone forgets.
 *
 * Both directions, because both drift, and each is a different mistake:
 *
 *   - a check the runner invokes that the README does not name → a maintainer cannot find it,
 *     and the runner's own output is the only place it exists;
 *   - a check the README names that the runner does not invoke → the README is advertising a
 *     guard that does not run, which is the failure mode this repository keeps meeting head-on.
 *
 * Where it lives, and why not in the site's own runner: the site's five checks execute only in
 * `.github/workflows/pages.yml`, which triggers on a push to `main` and **never** on
 * `pull_request` (measured 2026-10-12; see issue #174). A consistency check placed there would let
 * the exact drift it exists to prevent reach `main` first, and only be discovered by the failure of
 * something else. `tests/doc-integrity.test.ts` is the same shape of job and does run on pull
 * requests, so this sits beside it.
 *
 * 口径 (why the numbers below are what they are, and not chosen):
 *   - 5 是实测值，不是估计。`run-checks.mjs` 的 CHECKS 数组在 2026-10-12 有 5 项，README 的表
 *     同样 5 行。两个下界都写 5：**抽取器失效时必须红**。全称断言在抽取器坏掉时会静默恒真，
 *     那正是 `docs/testing-constraints.md` 约束 #5 要防的东西 —— 把「空集合 == 空集合」判成通过。
 *   - 只从**表格行**里取 `check-*.mjs`，不扫全文。README 正文里还提到
 *     `check-external-links.mjs` 和 `check-repo-metadata.mjs`，它们是真实存在但**不在**检查链
 *     里的东西：前者永远不失败且不进 CI，后者是仓库级检查。按全文扫描会把它们判成
 *     「README 提了但 runner 没跑」—— 假阳性。
 *   - 脚本名逐字比对，不做 basename / 去后缀之类的宽松处理。宽松匹配会把
 *     `check-doc-claims.mjs` 和 `check-doc-claims-extra.mjs` 判成同一个。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(REPO_ROOT, "packages", "website", "scripts", "run-checks.mjs");
const README = join(REPO_ROOT, "packages", "website", "README.md");

/** 实测下界：2026-10-12 时 runner 有 5 项检查、README 表有 5 行。 */
const FLOOR = 5;

const SCRIPT_NAME = /"(check-[a-z0-9-]+\.mjs)"/g;
/** 表格行以 `|` 开头；表格里的第一列就是脚本名。 */
const TABLE_ROW = /^\|\s*`(check-[a-z0-9-]+\.mjs)`/gm;
/** 表所在的章节。只在这一节里抽，见 `readmeChecks` 的口径。 */
const CHECKS_HEADING = "## The checks";

/**
 * 抽出 runner 真正会跑的那些检查。
 *
 * 读源码而不是 import，理由是 runner 在模块顶层就调用 `main()`，import 它会把五道检查跑一遍 ——
 * 而其中三道读构建产物，在测试环境里会红。这不是「实现细节」，是避免测试反过来依赖被测物的副作用。
 *
 * 代价是要解析文本，所以抽取结果必须带下界断言（见上）。数组字面量本身找不到时也必须红，
 * 否则下面那条 `FLOOR` 断言会被一个空数组静默满足的一半绕过去。
 */
function runnerChecks(source: string): string[] {
  const start = source.indexOf("const CHECKS = [");
  if (start < 0)
    throw new Error(
      "runner has no CHECKS array literal — the extraction is broken, not the README",
    );

  const end = source.indexOf("];", start);
  if (end < 0)
    throw new Error("the CHECKS array literal is not closed — the runner was restructured");

  return [...source.slice(start, end).matchAll(SCRIPT_NAME)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * 抽出 README 表格里列出的检查。
 *
 * 只从 `## The checks` 这一节里抽，而且只认该节的表格行第一列。两条限制都是被实测逼出来的：
 *
 * 1. **不扫全文。** README 正文里还提到 `check-external-links.mjs` 和
 *    `check-repo-metadata.mjs`，它们是真实存在但**不在**检查链里的东西：前者永远不失败且不进
 *    CI，后者是仓库级检查。按全文扫描会把它们判成「README 提了但 runner 没跑」—— 假阳性。
 *
 * 2. **不扫整份文件的表格行。** 这是 review 轮 2 抓到的回归：那份文件里后来又多了一张
 *    「哪道检查需要 build 的哪个产物」的表，那张表**重复**了四个主表里的脚本名。于是抽取数从
 *    5 变成 9，而真正要守的东西被稀释了 —— 实测：删掉主表里 `check-style-scope.mjs` 那一行，
 *    名字仍然从第二张表里被抽到，**漂移方向一不再转红**。抽取器的判据是形状（表格行）而不是
 *    「这张表是给谁看的」，所以新增任何一张提到检查名的表都会把它悄悄削弱。按章节切，是唯一
 *    能让「README 在哪里声明它运行哪些检查」只有一个答案的做法。
 */
function readmeChecks(markdown: string): string[] {
  const start = markdown.indexOf(CHECKS_HEADING);
  if (start < 0) return [];

  const rest = markdown.slice(start + CHECKS_HEADING.length);
  const end = rest.search(/\n##\s/);
  const section = end < 0 ? rest : rest.slice(0, end);

  return [...section.matchAll(TABLE_ROW)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
}

const runnerSource = readFileSync(RUNNER, "utf8");
const readmeMarkdown = readFileSync(README, "utf8");
const fromRunner = runnerChecks(runnerSource);
const fromReadme = readmeChecks(readmeMarkdown);

describe("断言：站点的 README 与 runner 必须点名同一批检查（#173）", () => {
  // 防恒真的第一道门：抽取面本身非空，且达到实测下界。
  test("口径守卫：两个抽取器都非空且达到实测下界", () => {
    expect(
      fromRunner.length,
      `runner 里抽到的检查数：${fromRunner.length}。若 runner 重构过，先更新本测试的抽取器再更新下界`,
    ).toBeGreaterThanOrEqual(FLOOR);
    expect(
      fromReadme.length,
      `README 表格里抽到的检查数：${fromReadme.length}。表格格式若变了，先更新抽取器`,
    ).toBeGreaterThanOrEqual(FLOOR);
    expect(
      readmeMarkdown.includes("## The checks"),
      "README 必须有一节叫 `## The checks` —— 没有它，这份文件就不是那份操作手册",
    ).toBe(true);
  });

  test("runner 会跑而 README 没写的检查", () => {
    expect(
      fromRunner.filter((name) => !fromReadme.includes(name)),
      "runner 会跑的检查没在 packages/website/README.md 的表里点名。改动站点的人会找不到它",
    ).toEqual([]);
  });

  test("README 写了而 runner 不跑的检查", () => {
    expect(
      fromReadme.filter((name) => !fromRunner.includes(name)),
      "README 声称存在的检查，runner 其实不会跑。那是一条看着像守卫、其实什么都没守的规则",
    ).toEqual([]);
  });
});

// 约束 #5：把实现改成显然错误但符合断言的版本，这条必须红。
// 这两条不碰文件系统 —— 抽取器是纯函数，所以可以直接喂合成语料，代价为零。
describe("反事实：抽取器认得出两种漂移（约束 #5）", () => {
  const runnerFixture = `const CHECKS = [
  ["a", "check-alpha.mjs"],
  ["b", "check-beta.mjs"],
];`;

  test("README 漏掉一项 → 两侧不等", () => {
    const listed = readmeChecks(
      `${CHECKS_HEADING}\n\n| check | catches | red |\n| --- | --- | --- |\n| \`check-alpha.mjs\` | x | y |`,
    );
    const running = runnerChecks(runnerFixture);

    expect(running.filter((name) => !listed.includes(name))).toEqual(["check-beta.mjs"]);
  });

  test("README 多写一项 → 两侧不等", () => {
    const listed = readmeChecks(
      `${CHECKS_HEADING}\n\n| \`check-alpha.mjs\` | x | y |\n| \`check-ghost.mjs\` | x | y |`,
    );
    const running = runnerChecks(runnerFixture);

    expect(listed.filter((name) => !running.includes(name))).toEqual(["check-ghost.mjs"]);
  });

  test("正文里提到的、但不在检查链里的脚本不算漂移", () => {
    // check-external-links.mjs 在 README 正文被提到（它永不失败、不进 CI），
    // 也不在 runner 的 CHECKS 里。它必须**不**被判成「README 写了但没跑」。
    const readme = [
      CHECKS_HEADING,
      "",
      "| `check-alpha.mjs` | x | y |",
      "",
      "`check-external-links.mjs` is **not** in that table because it is not a gate.",
    ].join("\n");

    expect(readmeChecks(readme)).toEqual(["check-alpha.mjs"]);
  });

  test("同一文件里第二张提到检查名的表不得稀释这一节（review 轮 2 的回归）", () => {
    // 实测过的失效：文件里多了一张「哪道检查需要 build 的哪个产物」的表，它重复了主表里四个
    // 脚本名，抽取数从 5 涨到 9。于是**删掉主表里的一行**时，名字仍然能从第二张表抽到，
    // 漂移方向一不再转红 —— 守门被自己写的修复削弱了。按章节切之后这张表不再计数。
    const readme = [
      CHECKS_HEADING,
      "",
      "| `check-alpha.mjs` | x | y |",
      "",
      "## Which artifact each one needs",
      "",
      "| Check | Needs | Because |",
      "| --- | --- | --- |",
      "| `check-alpha.mjs` | the build output | it reads the built pages |",
      "| `check-beta.mjs` | the build output | same |",
    ].join("\n");

    // 主表只剩 alpha，beta 已在主表被删 —— 第二张表不能把它救回来。
    const listed = readmeChecks(readme);
    expect(listed).toEqual(["check-alpha.mjs"]);

    const running = runnerChecks(runnerFixture);
    expect(running.filter((name) => !listed.includes(name))).toEqual(["check-beta.mjs"]);
  });

  test("没有 `## The checks` 章节 → 抽成空，而不是扫全文", () => {
    // 章节被改名或删掉时，下界断言必须红。扫全文会让它悄悄变成别的答案。
    expect(readmeChecks("| `check-alpha.mjs` | x | y |")).toEqual([]);
  });

  test("runner 的数组字面量找不到时必须抛错，不能返回空数组", () => {
    // 抽取器坏掉时返回空数组，会让上面那条 FLOOR 断言变成「0 >= 5」的红，
    // 而如果有人同时把下界调成 0，这条路径就静默恒真了。抛错让重构被看见。
    expect(() => runnerChecks("const somethingElse = [];")).toThrow(/CHECKS/);
  });
});
