// 能力矩阵的单一事实源（ADR-0029）：能力 → 探针 → 变异清单。
//
// 为什么映射只存在这里、不在探针文件里反向声明：事实副本会烂，而且没人发现——
// 同一个能力在两处各有一份清单，改了一处，另一处静默说谎（网站 checks.mjs 的头注释讲的就是这件事）。
// 各面分片放在 tests/registry/<面>.mjs（一份能力一片），本文件是唯一的读取入口与校验点。
//
// 三条机械判据：
//   ① 杀死归属核对 —— 在 scripts/mutate.mjs：红的用例必须就是 kills 指定的那条（别的用例红 = 假杀死）。
//   ② 锚点唯一性 —— mutant.from 在目标文件里必须只出现一次（这里静态查一次，运行时再查一次）。
//   ③ 能力矩阵完整性 —— 每个能力都有存在的探针；孤儿探针（没有条目指向它）= 红。
//
// 校验按面切（problemsFor(scope)）：正在写一个面的分片时，别的面还没写完不该把它判红。
// 分片自检用 problemsForShard(shard)：只查自己那一片（别的面的探针还没写出来不算红）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FRAGMENT_DIR = join(HERE, "registry");

const fragmentFiles = existsSync(FRAGMENT_DIR)
  ? readdirSync(FRAGMENT_DIR)
      .filter((f) => f.endsWith(".mjs"))
      .sort()
  : [];

const fragments = await Promise.all(
  fragmentFiles.map(async (f) => (await import(join(FRAGMENT_DIR, f))).default),
);

/** 58 条能力：每条 ≥1 条 mutant，22 条高风险能力各 3 条（出处见 ADR-0029 §4.9） */
export const CAPABILITIES = fragments.flatMap((f) => f.capabilities ?? []);

/** 非能力探针：真机冒烟接线、登记表自检——有归属但不吃 mutant 预算 */
export const EXTRAS = fragments.flatMap((f) => f.extras ?? []);

/** 快腿：四个面进 `pnpm test`；重资产面（website/bench/live）各有独立命令 */
export const FAST_FACES = ["pi", "output", "kimi", "standalone"];

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

const entries = [...CAPABILITIES, ...EXTRAS];

/** 查一批条目自身的问题；orphanCheck=true 时另查没人指向的孤儿探针 */
function problemsForEntries(list, { orphanCheck = false } = {}) {
  const problems = [];
  const seenCapability = new Set();
  const seenMutant = new Set();
  const referencedProbes = new Set();
  for (const cap of list) {
    if (seenCapability.has(cap.id)) problems.push(`能力重复：${cap.id}`);
    seenCapability.add(cap.id);
    if (!cap.probe || !cap.probe.endsWith(".test.ts")) {
      problems.push(`${cap.id}：probe 必须是 .test.ts（现在 ${cap.probe}）`);
      continue;
    }
    referencedProbes.add(join(ROOT, cap.probe));
    if (!existsSync(join(ROOT, cap.probe))) {
      problems.push(`${cap.id}：探针不存在 ${cap.probe}`);
    }
    const mutants = cap.mutants ?? [];
    if (!cap.exempt && mutants.length === 0) {
      problems.push(`${cap.id}：一条 mutant 都没有（要么补，要么写 exempt 理由）`);
    }
    for (const m of mutants) {
      if (seenMutant.has(m.id)) problems.push(`变异重复：${m.id}`);
      seenMutant.add(m.id);
      if (!existsSync(join(ROOT, m.file))) {
        problems.push(`${m.id}：目标文件不存在 ${m.file}`);
        continue;
      }
      const text = readFileSync(join(ROOT, m.file), "utf8");
      const hits = countOccurrences(text, m.from);
      if (hits !== 1) {
        problems.push(`${m.id}：锚点在 ${m.file} 出现 ${hits} 次（必须恰好 1 次）`);
      }
      if (m.from === m.to) problems.push(`${m.id}：from 与 to 相同（这不是变异）`);
      if (!m.kills) problems.push(`${m.id}：没写 kills（归属核对要知道该红的是哪条用例）`);
    }
  }
  if (orphanCheck) {
    for (const file of walk(join(ROOT, "tests"))) {
      if (!referencedProbes.has(file)) {
        problems.push(`孤儿探针：${relative(ROOT, file)}（没有条目指向它）`);
      }
    }
  }
  return problems;
}

export function problemsFor(scope) {
  const inScope = (face) =>
    scope === "all" ? true : scope === "fast" ? FAST_FACES.includes(face) : face === scope;
  return problemsForEntries(
    entries.filter((e) => inScope(e.face)),
    { orphanCheck: scope === "all" },
  );
}

/** 单片自检：只查这一片的条目（别的面的探针还没写出来时不算红） */
export function problemsForShard(shard) {
  return problemsForEntries([...(shard.capabilities ?? []), ...(shard.extras ?? [])]);
}

export const MUTANTS = CAPABILITIES.flatMap((cap) =>
  (cap.mutants ?? []).map((m) => ({ ...m, capability: cap.id, face: cap.face, probe: cap.probe })),
);

export const capabilitiesFor = (scope) =>
  CAPABILITIES.filter((cap) =>
    scope === "all" ? true : scope === "fast" ? FAST_FACES.includes(cap.face) : cap.face === scope,
  );

export const probesFor = (caps) => [...new Set(caps.map((c) => c.probe))];
