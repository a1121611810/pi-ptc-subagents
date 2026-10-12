/**
 * The site's five checks run on a pull request, and the pull request runs the same command the
 * deploy does.
 *
 * Issue #174 recorded a finding rather than fixing it: the five checks execute only in
 * `.github/workflows/pages.yml`, which triggers on a push to `main` and on manual dispatch, so a
 * pull request that turned one of them red merged cleanly and the failure surfaced afterwards as a
 * failed deploy. This test is the fix's regression guard. It asserts five things, each of which is
 * a way the fix can rot:
 *
 *   1. **Something runs the site build on `pull_request`.** The bare existence of the fix. Without
 *      this, deleting the new workflow silently reinstates #174 and nothing else in the repository
 *      notices — the gates all still pass, the site still builds on `main`, and the only symptom is
 *      a failed deploy that no one was told to expect.
 *   2. **That job runs the same command `pages.yml` runs.** This is the assertion that earns the
 *      rest. Two sets — one guarding a merge, one guarding a deploy — can drift apart, and a
 *      drift is *worse* than the gap it replaced: it is silent, it reinstates the original bug for
 *      whichever check fell out of the merge-side set, and it does so while every gate stays green.
 *      Identity of the command makes the sets equal by construction instead of by a second gate that
 *      would need its own counterfactual test.
 *   3. **The `pull_request` trigger carries no `paths` filter.** Not a style preference — a filter
 *      scoped to the site would be *wrong*, because `check-doc-claims.mjs` binds 19 documented
 *      claims to named constants in `src/` (`DEFAULT_CONFIG` keys, exported `const`s, literals
 *      inside named exported functions). A pull request that changes `src/runtime/limits.ts` and no
 *      file under `packages/website/` can turn a site check red, so `paths: [packages/website/**]`
 *      would skip exactly the class of drift the gate exists to catch, and skip it silently.
 *   4. **The pull request job holds no deploy credentials, at either level.** `pages.yml` mints the
 *      OIDC token Pages deployment trusts. GitHub documents that a job-level `permissions` block
 *      *overrides* the top level rather than being capped by it, so reading only the top level
 *      leaves a three-line copy-paste from `pages.yml` — `permissions: {id-token: write}` on the
 *      job — passing while the PR job holds the credential. This one carries the most security
 *      weight of the five.
 *   5. **The extractors still see what they claim to.** `workflows.length` has a floor, and the
 *      deploy workflow is named by path. Without this, a broken extractor makes every universal
 *      assertion below compare the empty set against itself and pass.
 *
 * Why this sits in `tests/` rather than in the site's own runner: the site runner executes on the
 * deploy path, so a consistency check placed there lets the drift it exists to prevent reach `main`
 * first, and only be discovered by the failure of something else. That is the same argument
 * `website-readme-consistency.test.ts` makes about its own placement, and the reason
 * `doc-integrity.test.ts` sits beside them.
 *
 * 口径 (why the numbers and the extraction below are what they are, and not chosen):
 *   - 读源码文本而不 import / 不引入 YAML 库：本仓库没有任何 YAML 解析依赖，也没有既有测试读过
 *     `.yml`。`website-readme-consistency.test.ts` 已经确立了「读文本 + 下界断言」的先例，理由与
 *     它相同：为了问一句「触发器是什么」而 import 一个带副作用或需要依赖的东西，不是可接受的代价。
 *   - 每处抽取都带下界断言。抽取器坏掉时，`过滤后的集合` 与 `空集合` 比较会**静默恒真** ——
 *     那正是 `docs/testing-constraints.md` 约束 #5（反事实判据）要防的东西。一个断言如果无法在
 *     实现被改坏时变红，它就不是门禁，是装饰。
 *   - 命令比较是**精确字面量相等**：`toContain(DEPLOY_COMMAND)` 里的 `DEPLOY_COMMAND` 是一个
 *     完整命令的字面量，不是子串模式、不是正则。所以 `build --no-check` 不算命中，
 *     `prebuild && …build` 也不算 —— 集合分叉正是从这里开始的。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/** The deploy job that is the site's gate today. Both sides are named as literals on purpose: */
const DEPLOY_WORKFLOW = "pages.yml";
/** The command the deploy job runs, quoted from `pages.yml` rather than assembled here. */
const DEPLOY_COMMAND = "pnpm --filter website run build";

/** 实测下界：2026-10-12 时仓库有 6 个工作流（ci / oxlint / test / publish / pages / website）。 */
const WORKFLOW_FLOOR = 6;

/** 顶层键（无缩进），用来切出 `on:` / `permissions:` 块。 */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):\s*$/;
/**
 * `- run: <命令>`，两种缩进都收（job 内与 step 内）。
 *
 * `g` 是必需的，不是可选的：`String.prototype.matchAll` 对非全局正则直接抛
 * `TypeError`，而不是退化成单次匹配。
 */
const RUN_STEP = /^\s*-\s+run:\s*(.+?)\s*$/gm;

interface Workflow {
  readonly file: string;
  readonly source: string;
}

/**
 * 抽出某个顶层键的整块内容（含该键本身），到下一个顶层键为止。
 *
 * 找不到键时抛错而不是返回空串：空串会让下面所有 `toContain` 断言以「集合为空」的方式通过，
 * 而抽取器失效与配置真的缺失在这里长得一模一样。
 */
function topLevelBlock(source: string, key: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => TOP_LEVEL_KEY.exec(line)?.[1] === key);
  if (start < 0)
    throw new Error(`no top-level "${key}:" block — the extraction is broken, not the workflow`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => TOP_LEVEL_KEY.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** `on:` 块里是否声明了 `pull_request`。 */
function triggersOnPullRequest(source: string): boolean {
  return /^ {2}pull_request:/m.test(topLevelBlock(source, "on"));
}

/**
 * `pull_request` 触发器上是否带了 `paths` / `paths-ignore` 过滤。
 *
 * 只看 `pull_request` 那一节的下一层缩进，不是整个 `on:` 块：给 `push` 加过滤与本断言无关，
 * 而把它算进来会让一次与 PR 无关的合法改动把门禁弄红。
 *
 * **按缩进终止，不按空行终止。** YAML 映射里的空行没有语义，所以
 *
 *     on:
 *       pull_request:
 *
 *         paths:
 *           - 'packages/website/**'
 *
 * 与不隔空行写法**完全等价**。早先这里以空行收尾，那种排版能让断言静默通过（实测 5 passed），
 * 而它守的正是「别用 paths 过滤掉 src/ 驱动的文档漂移」—— 静默放行是它最坏的失效方向。
 */
function pullRequestHasPathFilter(source: string): boolean {
  const block = topLevelBlock(source, "on");
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /^ {2}pull_request:/.test(line));
  if (start < 0) return false;
  // 收集 `pull_request:` 之后所有缩进 > 2 的行，直到遇到缩进 <= 2 的非空行（下一个同级键）
  // 或 `on:` 块结束。空行被跳过而不是当作终止符。
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 2) break;
    section.push(line);
  }
  return /^ {4}paths(-ignore)?:/m.test(section.join("\n"));
}

/**
 * `jobs.<job>.permissions` 里授予的权限，按 job 分组。
 *
 * GitHub 的权限优先级是 job 级覆盖顶层，且未列出的键在该 job 内被置为 `none` —— 所以顶层块
 * 不是上界。只读顶层会漏掉一个 job 自己声明的 `id-token: write`（实测：这样加仍全绿）。
 *
 * 返回 Map 而非扁平数组：合并之后报错信息会丢掉是哪个 job 声明的，而那正是复现时要找的东西。
 */
function jobLevelPermissions(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = source.split("\n");
  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsStart < 0) throw new Error("no jobs: block — the extraction is broken, not the workflow");
  let current: string | null = null;
  const rest = lines.slice(jobsStart + 1);
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i] as string;
    const jobHeader = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (jobHeader) {
      current = jobHeader[1] as string;
      out.set(current, []);
      continue;
    }
    if (/^ {4}permissions:\s*$/.test(line) && current !== null) {
      // 往下吃掉该 permissions 块的成员，直到遇到缩进 <= 4 的非空行。
      for (const member of rest.slice(i + 1)) {
        if (member.trim() === "") continue;
        const indent = member.length - member.trimStart().length;
        if (indent <= 4) break;
        const name = /^ {6}([\w-]+):/.exec(member);
        if (name) out.get(current)?.push(name[1] as string);
      }
      continue;
    }
  }
  return out;
}

/** `permissions:` 块里被授予的权限名。 */
function grantedPermissions(source: string): string[] {
  const block = topLevelBlock(source, "permissions");
  const names = [...block.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1] as string);
  if (names.length === 0)
    throw new Error(
      "permissions block granted nothing — the extraction is broken, not the workflow",
    );
  return names;
}

/** 工作流里所有 `- run:` 的命令。 */
function runCommands(source: string): string[] {
  return [...source.matchAll(RUN_STEP)].map((m) => m[1] as string);
}

function readWorkflows(): Workflow[] {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"));
  return files.map((file) => ({
    file,
    source: readFileSync(join(WORKFLOW_DIR, file), "utf-8"),
  }));
}

const workflows = readWorkflows();
const byName = new Map(workflows.map((w) => [w.file, w]));

/**
 * 跑站点构建、**且**由 pull_request 触发的工作流 —— 也就是门禁真正审的对象。
 *
 * 集合刻意只用两个谓词定义，而下面每条断言再去检查**别的**性质（无 `paths:` 过滤、无部署
 * 凭据）。早先这里把「跑那条命令」也放进定义，于是断言在复述自己的定义 —— 不可证伪，那是
 * `docs/testing-constraints.md` 约束 #4 禁的同义反复。
 *
 * 不能用「跑构建的全部」当集合：`pages.yml` 跑同一条命令，而它**持有** `pages` / `id-token`
 * 是完全正确的 —— 它就是部署工作流。凭据那条断言的对象是 PR 路径，不是部署路径。
 */
const siteChecksOnPullRequest = workflows.filter(
  (w) => triggersOnPullRequest(w.source) && runCommands(w.source).includes(DEPLOY_COMMAND),
);

describe("the site's checks run on a pull request (#174)", () => {
  test("the extractor still sees every workflow — 抽取器失效必须红", () => {
    // 全称断言在抽取器坏掉时会静默恒真。这是 `docs/testing-constraints.md` 约束 #5 的形状：
    // 「空集合 == 空集合」会被判成通过，而那不是通过，是没看。
    expect(workflows.length).toBeGreaterThanOrEqual(WORKFLOW_FLOOR);
    expect(byName.has(DEPLOY_WORKFLOW)).toBe(true);
  });

  test("a pull request runs the same site build the deploy runs", () => {
    // 两个方向分开断言，因为它们的集合**不同**：
    //
    //   (a) 存在性：`siteChecksOnPullRequest` 非空 —— #174 的原样回归（删掉 website.yml，
    //       或撤掉它的 pull_request 触发）会让这一半红。这是全套断言的承重点。
    //   (b) 完备性：每个跑站点构建的工作流都要么由 PR 触发，要么是 pages.yml 那个已知的
    //       部署侧 —— 防止将来新增一个「跑构建却只在 main 上跑」的工作流，那会重新打开一个
    //       和 #174 同形状的缺口。
    //
    // 不能写成「每个 PR 工作流都跑站点构建」—— `ci.yml` / `oxlint.yml` / `test.yml` 由 PR
    // 触发但**不该**跑站点构建，那是要求无关工作流做没有理由的事。
    expect(
      siteChecksOnPullRequest.length,
      `no workflow runs \`${DEPLOY_COMMAND}\` on a pull_request — this is issue #174`,
    ).toBeGreaterThan(0);
    expect(
      workflows
        .filter((w) => runCommands(w.source).includes(DEPLOY_COMMAND))
        .map((w) => w.file)
        .filter((f) => !siteChecksOnPullRequest.some((w) => w.file === f)),
      "a workflow runs the site build but is not covered by a pull_request trigger",
    ).toEqual([DEPLOY_WORKFLOW]);
  });

  test("the deploy command this test compares against is still what pages.yml runs", () => {
    // 逐字符相等，不是「包含」：分叉的失效方向是静默放过，所以判据必须精确。
    const deploy = byName.get(DEPLOY_WORKFLOW);
    if (!deploy) throw new Error(`${DEPLOY_WORKFLOW} is missing — the extraction is broken`);
    expect(runCommands(deploy.source)).toContain(DEPLOY_COMMAND);
  });

  test("the pull_request trigger carries no paths filter", () => {
    // `check-doc-claims.mjs` 把文档声明绑到 `src/` 的具名常量上，所以改 `src/` 而不碰站点的
    // PR 也能让站点检查变红。按站点路径过滤会漏掉这一整类漂移。
    //
    // 非空由上一条钉住，这里断言集合里**每个**元素的性质，不重复「非空」——重复的断言无法被
    // 证伪，因此不是门禁，是装饰。
    for (const w of siteChecksOnPullRequest)
      expect(
        pullRequestHasPathFilter(w.source),
        `${w.file} filters its pull_request trigger, so a src/-only change that turns a site ` +
          `check red would skip it — see check-doc-claims.mjs`,
      ).toBe(false);
  });

  test("the pull request job holds no deploy credentials", () => {
    // `pages.yml` mints the OIDC token Pages deployment trusts. A pull request — a fork one
    // included — must never reach those permissions to run a check.
    //
    // **job 级与顶层都要看。** GitHub 文档：job 内的 `permissions` 覆盖顶层，未列出的键在该
    // job 内被置为 `none` —— 也就是说顶层的 `contents: read` 并不封顶 job 自己声明的
    // `id-token: write`。只读顶层块的门禁在一个三行复制粘贴面前形同虚设（实测：加 job 级
    // `id-token: write` 时旧版本仍 5 passed）。
    for (const w of siteChecksOnPullRequest) {
      // 顶层
      for (const scope of grantedPermissions(w.source))
        expect(
          scope,
          `${w.file} grants \`${scope}\` at the top level; a pull request runs with it`,
        ).not.toMatch(/^(pages|id-token)$/);
      // job 级（每个 job 一组）
      for (const [job, perms] of jobLevelPermissions(w.source))
        for (const scope of perms)
          expect(
            scope,
            `${w.file} grants \`${scope}\` to job \`${job}\`; a pull request runs that job`,
          ).not.toMatch(/^(pages|id-token)$/);
    }
  });
});
