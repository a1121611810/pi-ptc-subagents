/**
 * Every third-party action is pinned to a SHA that at least one other workflow in this repository
 * already uses.
 *
 * A GitHub Actions SHA is 40 hex characters, so a typo in the last one produces another 40
 * characters. Copying one by eye is the whole failure mode: nothing in `oxlint`, `oxfmt`,
 * `tsc --noEmit` or the test suite reads a workflow file's action references, and a wrong SHA
 * does not fail locally — it fails on the runner, where the action cannot be resolved, as a red
 * build attributed to the commit that introduced it.
 *
 * Measured while adding `.github/workflows/website.yml`: the SHA was written as
 * `3d3c42e5aac5ba805825da76410c181273ba90c1` where every other workflow uses
 * `3d3c42e5aac5ba805825da76410c181273ba90b1`. One character, at index 38, both 40 long, and
 * invisible in a diff. It was caught only by comparing byte-for-byte across workflows because the
 * writer happened to suspect it.
 *
 * ## What this catches, and what it does not
 *
 * It catches a SHA that disagrees with the rest of the repository — which is every transcription
 * error, because a workflow never invents a SHA on purpose. It does **not** verify that a SHA is
 * the real upstream commit, that it names the version the comment claims, or that the action
 * exists. Those need the network and are out of scope here; a wrong-but-consistent SHA is caught by
 * the runner, not by this test.
 *
 * It therefore needs a known-good majority to compare against: a SHA appearing exactly once in the
 * repository is the suspicious one, which is also the only shape a transcription error can take.
 * That makes "appears exactly once" the finding, and this test reports the whole set rather than
 * the first offender.
 *
 * ## Why it lives here rather than in the pre-commit hook
 *
 * The hook (`.githooks/pre-commit`) refuses exactly two things by design — a packaged artifact and
 * a staged path the formatter would rewrite — because a slow hook gets `--no-verify`'d and a
 * bypassed hook protects nothing. This check is fast but it is not one of those two, and adding a
 * third refusal changes a decision that record documents deliberately. This file runs in the
 * release chain, on every push to `main` and on every pull request, which is where a bad SHA has to
 * be caught anyway.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/** 40 lowercase hex characters: the shape git object IDs have. */
const SHA = /^[0-9a-f]{40}$/;

/** 实测下界：2026-10-12 时仓库有 6 个工作流文件。 */
const WORKFLOW_FLOOR = 6;

interface Reference {
  readonly file: string;
  readonly action: string;
  readonly ref: string;
}

function readWorkflows(): Array<{ file: string; source: string }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((file) => ({ file, source: readFileSync(join(WORKFLOW_DIR, file), "utf-8") }));
}

const workflows = readWorkflows();

/** 每一条 `uses:` 引用，带它出现的文件。 */
const references: Reference[] = workflows.flatMap(({ file, source }) =>
  [...source.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([^\s#]+)/g)].map((m) => ({
    file,
    action: m[1] as string,
    ref: m[2] as string,
  })),
);

/**
 * 引用上的版本注释：`…@<sha> # v7`。
 *
 * 有了它才能区分两种情况：同一个 action 在同一个版本上出现两个不同 SHA（誊写错误，必须红），
 * 与同一个 action 出现在两个版本上（有意为之，不是错误 —— `pages.yml` 的
 * `actions/setup-node@v7` 与其余工作流的 `v6` 就是这种，见下面的 `KNOWN_VERSION_SPLITS`）。
 */
function versionOf(comment: string | undefined): string | undefined {
  return comment?.match(/#\s*v?(\d[\w.-]*)/)?.[1];
}

/** 逐条 `uses:`，连同它所在行上的版本注释。 */
function readsWithVersion(
  source: string,
): Array<{ action: string; ref: string; version?: string }> {
  return source.split("\n").flatMap((line) => {
    const m = /uses:\s*([\w.-]+\/[\w.-]+)@([^\s#]+)\s*(#.*)?/.exec(line);
    if (!m) return [];
    return [{ action: m[1] as string, ref: m[2] as string, version: versionOf(m[3]) }];
  });
}

/**
 * 已知且有意的版本分裂：同一个 action 在不同工作流钉不同版本。
 *
 * 列在这里而不是靠「版本不同就放过」，是因为放过得太宽就等于没有断言 —— 一个 SHA 若真的
 * 抄错，而它旁边恰好有个 `# v6` 注释，分裂检测就会静默失效。这一条把豁免写成显式清单：新增
 * 一次分裂必须有人在这里加一行，而加这一行的人看得到它意味着两个版本都在维护。
 */
const KNOWN_VERSION_SPLITS: ReadonlyArray<{ action: string; versions: readonly string[] }> = [
  // pages.yml 用 v7 / v6，其余工作流用 v6 / v4。发布路径与测试路径本来就不是同一套依赖，
  // 合并它们是一次行为变更，不属于「把 action 钉到 SHA」这件事的范围。
  { action: "actions/setup-node", versions: ["7", "6"] },
  { action: "pnpm/action-setup", versions: ["6", "4"] },
];

const shaWithVersion = workflows.flatMap(({ file, source }) =>
  readsWithVersion(source)
    .filter(({ ref }) => SHA.test(ref))
    .map(({ action, ref, version }) => ({ file, action, ref, version })),
);

/** 同一 action + 同一版本被钉到的不同 SHA 集合 —— 这才是誊写错误。 */
const refsByActionVersion = new Map<string, Set<string>>();
for (const { action, version, ref } of shaWithVersion) {
  const key = `${action}@${version ?? "(no version comment)"}`;
  const seen = refsByActionVersion.get(key) ?? new Set<string>();
  seen.add(ref);
  refsByActionVersion.set(key, seen);
}

/** 用了标签而非 SHA 的引用。这些不是誊写错误，是「还没钉」的记录。 */
const tagReferences = references.filter(({ ref }) => !SHA.test(ref));

describe("third-party action SHAs (#174 review)", () => {
  test("the extractor sees every workflow and every uses: reference", () => {
    // 抽取器坏掉时，`refsByActionVersion` 会是空的，下面「同版本只钉一个 SHA」会对空集合
    // 恒真通过。那正是 docs/testing-constraints.md 约束 #5 的形状：空集合 == 空集合。
    expect(workflows.length).toBeGreaterThanOrEqual(WORKFLOW_FLOOR);
    expect(references.length).toBeGreaterThan(0);
    expect(shaWithVersion.length).toBeGreaterThan(0);
  });

  test("one action at one version is not pinned to two different SHAs", () => {
    // 报告整个集合而不是第一个 offender：同一个错 SHA 会同时出现在两条消息里，只报第一个
    // 会让人以为只有一处需要改。
    const inconsistent = [...refsByActionVersion.entries()]
      .filter(([, refs]) => refs.size > 1)
      .map(([key, refs]) => `${key} is pinned to ${[...refs].sort().join(" and ")}`);
    expect(
      inconsistent,
      "one action at one version is pinned to two different SHAs — one is a transcription " +
        "error, and 40 hex characters differ invisibly in a diff. Find it with:\n" +
        "  grep -rn 'uses: <owner>/<repo>@' .github/workflows/",
    ).toEqual([]);
  });

  test("every version split between two SHAs is a recorded decision", () => {
    // `KNOWN_VERSION_SPLITS` 是显式豁免清单，所以它自己也会腐烂：一个 action 从此只用单一
    // 版本之后，清单里的旧条目会永远挂着，而一个**真正的新**分裂会被这条挡住，直到有人
    // 来看一眼并决定。
    const actual = [...refsByActionVersion.keys()]
      .map((key) => {
        const at = key.lastIndexOf("@");
        return { action: key.slice(0, at), version: key.slice(at + 1) };
      })
      .reduce<Map<string, Set<string>>>((acc, { action, version }) => {
        const seen = acc.get(action) ?? new Set<string>();
        seen.add(version);
        acc.set(action, seen);
        return acc;
      }, new Map());

    // 比对**版本集合本身**，不是集合大小：只比大小的话，一个 action 多出第三个版本
    // （v6 / v7 / v8）时 3 ≠ 2 会漏过；而一旦记录里也变成三个版本，大小又相等了 ——
    // 数量相等与「就是那一组版本」是两件事，只有集合相等才说明有人真的看过。
    const unrecorded = [...actual.entries()]
      .filter(([, versions]) => versions.size > 1)
      .filter(
        ([action, versions]) =>
          !KNOWN_VERSION_SPLITS.some(
            (s) =>
              s.action === action &&
              s.versions.length === versions.size &&
              [...versions].sort().join(",") === [...s.versions].sort().join(","),
          ),
      )
      .map(([action, versions]) => `${action} is pinned at ${[...versions].sort().join(" and ")}`);

    expect(
      unrecorded,
      "an action is pinned at two versions and that split is not in KNOWN_VERSION_SPLITS — " +
        "either it should be one version, or someone should record the split there on purpose",
    ).toEqual([]);
  });

  test("every action reference is pinned to a SHA", () => {
    // 标签是可变引用：`@v7` 指向的东西可以在任何时刻变，而一次 PR 的门禁结果不该取决于
    // 上游当天发了什么。
    expect(
      tagReferences.map(({ file, action, ref }) => `${file}: ${action}@${ref}`),
      "these references use a mutable tag rather than a SHA — copy the SHA from another " +
        "workflow that already uses the same action, or from `gh api repos/<owner>/<repo>/" +
        "commits/<tag>`",
    ).toEqual([]);
  });
});
