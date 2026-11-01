// 升级提示 → 测试：
// ①版本比较 ②CHANGELOG 解析（只取 Added/Changed/Fixed）③要点摘要 ④区间挑选
// ⑤状态机（首装/同版/旧版/降级/状态写不进去）⑥通知文案
// ⑦格式漂移守卫：本仓真实 CHANGELOG 的顶节版本必须等于 package.json 版本
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findInstalledPackage,
  parseChangelog,
  pickBullets,
  showUpgradeNotice,
  summarize,
  versionNumber,
} from "../../packages/entry/dist/index.js";

const CHANGELOG = `# Changelog

## [7.5.0] - 2026-11-01

### Added

- **Program-internal task output** (\`tools.task_output({ taskId })\`): a PTC program can now fetch
  the prose answer a dispatched child wrote. Measured gap (real pi 1.4.0): a \`wait:false\`
  dispatch returns only a handle.

### Changed

- **The route-index token gate now measures the real install path.** It used a short relative
  path, which was green at 555 tokens.

### Verification

- Repository tests: **144 pass, 0 fail**.

## [7.4.0] - 2026-11-01

### Fixed

- Two dead exports were removed, and the stale snapshot no longer ships.

## [7.3.0] - 2026-11-01

### Added

- **Task-surface recall** (task + entry + dispatch + routes): the parent can find its old
  tasks after a compaction.
`;

function environment(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ptc-upgrade-"));
  const changelogPath = join(dir, "CHANGELOG.md");
  writeFileSync(changelogPath, CHANGELOG, "utf8");
  const statePath = join(dir, "state", "last-seen-version.json");
  mkdirSync(dirname(statePath), { recursive: true });
  return {
    version: "7.5.0",
    repository: "git+https://github.com/a1121611810/pi-ptc-subagents.git",
    changelogPath,
    statePath,
    ...overrides,
  };
}

function collector() {
  const messages = [];
  return { messages, ctx: { hasUI: true, ui: { notify: (m) => messages.push(m) } } };
}

test("版本比较：x.y.z 可比，其他一律 undefined", () => {
  assert.equal(typeof versionNumber("7.5.0"), "number");
  assert.ok(versionNumber("7.5.0") > versionNumber("7.4.9"));
  assert.ok(versionNumber("7.5.0") > versionNumber("6.99.99"));
  assert.equal(versionNumber("7.5"), undefined);
  assert.equal(versionNumber("v7.5.0"), undefined);
  assert.equal(versionNumber(7.5), undefined);
});

test("CHANGELOG 解析：版本段按文件顺序，只取 Added/Changed/Fixed", () => {
  const sections = parseChangelog(CHANGELOG);
  assert.deepEqual(
    sections.map((s) => s.version),
    ["7.5.0", "7.4.0", "7.3.0"],
  );
  // Verification 段不是"变了什么"——不进要点
  assert.equal(sections[0].bullets.length, 2);
  assert.ok(sections[0].bullets[0].startsWith("**Program-internal task output**"));
  // 换行的 bullet 接成一条
  assert.ok(sections[0].bullets[0].includes("the prose answer a dispatched child wrote"));
});

test("要点摘要：粗体标题优先，否则首句；链接压平、超长截断", () => {
  assert.equal(summarize("**RouteEntry.fact** removed."), "RouteEntry.fact");
  assert.equal(summarize("**Adds output.** More detail here."), "Adds output");
  assert.equal(
    summarize("The switch is the user's own choice. Second sentence."),
    "The switch is the user's own choice",
  );
  assert.equal(
    summarize("See [the docs](https://example.com) for details."),
    "See the docs for details",
  );
  const long = summarize(`${"x".repeat(400)} tail`);
  assert.ok(long.length <= 201, `截断后 ${long.length} 字符`);
  assert.ok(long.endsWith("…"));
});

test("区间挑选：只取 (previous, current]，新版本在前", () => {
  const sections = parseChangelog(CHANGELOG);
  assert.deepEqual(pickBullets(sections, "7.4.0", "7.5.0"), [
    "Program-internal task output",
    "The route-index token gate now measures the real install path",
  ]);
  // 跨两版：7.3.0 与 7.4.0 都在区间里，新版本在前
  assert.deepEqual(pickBullets(sections, "7.2.0", "7.4.0"), [
    "Two dead exports were removed, and the stale snapshot no longer ships",
    "Task-surface recall",
  ]);
  assert.deepEqual(pickBullets(sections, "7.5.0", "7.5.0"), []);
});

test("第一次见到这套提示：基线取 CHANGELOG 的上一节 ⇒ 显示当前版本这一节", () => {
  const env = environment();
  const first = collector();
  showUpgradeNotice(first.ctx, env);
  assert.equal(first.messages.length, 1, "第一次见到这套提示也要说当前版本变了什么");
  assert.ok(first.messages[0].startsWith("pi-ptc-subagents 7.5.0\n"));
  assert.ok(!first.messages[0].includes("Updated from"), "没有历史记录就不编「从哪版升来的」");
  assert.ok(first.messages[0].includes("- Program-internal task output"), "显示 7.5.0 这一节");
  assert.ok(
    !first.messages[0].includes("Task-surface recall"),
    "不含更早的版本（7.3.0 在基线之外）",
  );
  assert.equal(
    JSON.parse(readFileSync(env.statePath, "utf8")).version,
    "7.5.0",
    "也要落状态，否则每次启动都当第一次",
  );

  const same = collector();
  showUpgradeNotice(same.ctx, env);
  assert.equal(same.messages.length, 0, "同版本不重复显示");
});

test("有历史记录：显示旧版升上来的区间", () => {
  const older = environment({ version: "7.5.0" });
  writeFileSync(older.statePath, JSON.stringify({ version: "7.3.0" }), "utf8");
  const upgraded = collector();
  showUpgradeNotice(upgraded.ctx, older);
  assert.equal(upgraded.messages.length, 1);
  assert.ok(upgraded.messages[0].startsWith("pi-ptc-subagents 7.5.0\nUpdated from 7.3.0."));
  // 区间是 (previous, current]——previous 自己不在其中
  assert.ok(upgraded.messages[0].includes("- Two dead exports were removed"));
  assert.ok(!upgraded.messages[0].includes("Task-surface recall"));
  assert.ok(
    upgraded.messages[0].includes(
      "Changelog: https://github.com/a1121611810/pi-ptc-subagents/blob/main/CHANGELOG.md",
    ),
  );
});

test("降级不显示也不把状态改低（两份副本会互相顶）；状态写不进去就不显示", () => {
  const downgraded = environment();
  writeFileSync(downgraded.statePath, JSON.stringify({ version: "9.9.9" }), "utf8");
  const down = collector();
  showUpgradeNotice(down.ctx, downgraded);
  assert.equal(down.messages.length, 0, "降级不显示");
  assert.equal(
    JSON.parse(readFileSync(downgraded.statePath, "utf8")).version,
    "9.9.9",
    "状态记「见过的最高版本」：降级不改它，否则另一个副本每轮都被当成刚升级",
  );

  const readonly = environment({ statePath: "/dev/null/nope/last-seen-version.json" }); // 父路径不可写
  const broken = collector();
  showUpgradeNotice(broken.ctx, readonly);
  assert.equal(broken.messages.length, 0, "状态写不进去就不显示");
});

test("没有 UI 不通知；通知文案是苹果风格", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.4.0" }), "utf8");
  const noUi = {
    messages: [],
    ctx: { hasUI: false, ui: { notify: (m) => noUi.messages.push(m) } },
  };
  showUpgradeNotice(noUi.ctx, env);
  assert.equal(noUi.messages.length, 0);

  const ui = collector();
  showUpgradeNotice(ui.ctx, env);
  const text = ui.messages[0];
  assert.ok(text.startsWith("pi-ptc-subagents 7.5.0\nUpdated from 7.4.0.\n\nWhat's new:\n- "));
  assert.ok(text.includes("\n\nChangelog: https://"));
  assert.ok(!text.includes("!"), "苹果风格：不用感叹号");
  assert.ok(!/We're|excited|Amazing/i.test(text), "苹果风格：不喊口号");
});

test("格式漂移守卫：本仓真实 CHANGELOG 的顶节版本 == package.json 版本", () => {
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const sections = parseChangelog(changelog);
  assert.ok(sections.length > 0, "真实 CHANGELOG 解析不出版本段——格式变了");
  assert.equal(sections[0].version, pkg.version, "顶节版本与 package.json 不一致");
  assert.ok(sections[0].bullets.length > 0, "顶节没有要点——解析器或 CHANGELOG 格式变了");
});

test("已安装包的定位：发布形态 <pkg>/dist/ 与开发形态仓库根都认得出", () => {
  // 发布形态（npm 装出来的样子）：<pkg>/package.json + <pkg>/dist/index.js
  const dir = mkdtempSync(join(tmpdir(), "ptc-installed-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "pi-ptc-subagents", version: "7.5.0" }),
    "utf8",
  );
  const installed = findInstalledPackage(`file://${join(dir, "dist", "index.js")}`);
  assert.ok(installed, "认不出已安装包——产物目录一变，功能会静默失效");
  assert.equal(installed.version, "7.5.0");
  assert.equal(installed.dir, dir);

  // 开发形态：这个 bundle 自己在 packages/entry/dist/，包根在仓库根
  const self = findInstalledPackage();
  assert.ok(self, "开发形态认不出仓库根");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(self.version, pkg.version);
});
