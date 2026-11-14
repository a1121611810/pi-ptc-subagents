// 升级提示面（pi）：版本比较 · CHANGELOG 解析 · 要点摘要 · 区间挑选 · 状态哨兵（见过哪一版）
//                  · TUI 走 widget 区（共享状态槽会被别的扩展顶掉）· entry 层的落点。
// 探针直接打产物（packages/entry/dist）——仓规：验的是发布物形态。
// 副作用 import：装一份假 pi 到 PATH（见 helpers/pi-harness.ts 的说明）
import "../helpers/pi-harness.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
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

const environment = (
  overrides: Record<string, unknown> = {},
): {
  version: string;
  repository: string;
  changelogPath: string;
  statePath: string;
} => {
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
  } as {
    version: string;
    repository: string;
    changelogPath: string;
    statePath: string;
  };
};

const collector = (): { messages: string[]; ctx: unknown } => {
  const messages: string[] = [];
  return { messages, ctx: { hasUI: true, ui: { notify: (m: string) => messages.push(m) } } };
};

it("版本比较：x.y.z 可比，其他一律 undefined", () => {
  expect(typeof versionNumber("7.5.0")).toBe("number");
  expect(versionNumber("7.5.0")!).toBeGreaterThan(versionNumber("7.4.9")!);
  expect(versionNumber("7.5.0")!).toBeGreaterThan(versionNumber("6.99.99")!);
  expect(versionNumber("7.5")).toBeUndefined();
  expect(versionNumber("v7.5.0")).toBeUndefined();
  expect(versionNumber(7.5)).toBeUndefined();
});

it("CHANGELOG 解析：版本段按文件顺序，只取 Added/Changed/Fixed", () => {
  const sections = parseChangelog(CHANGELOG);
  expect(sections.map((s) => s.version)).toEqual(["7.5.0", "7.4.0", "7.3.0"]);
  // Verification 段不是"变了什么"——不进要点
  expect(sections[0]!.bullets.length).toBe(2);
  expect(sections[0]!.bullets[0]!.startsWith("**Program-internal task output**")).toBe(true);
  // 换行的 bullet 接成一条
  expect(sections[0]!.bullets[0]).toContain("the prose answer a dispatched child wrote");
});

it("要点摘要：粗体标题优先，否则首句；链接压平、超长截断", () => {
  expect(summarize("**RouteEntry.fact** removed.")).toBe("RouteEntry.fact");
  expect(summarize("**Adds output.** More detail here.")).toBe("Adds output");
  expect(summarize("The switch is the user's own choice. Second sentence.")).toBe(
    "The switch is the user's own choice",
  );
  expect(summarize("See [the docs](https://example.com) for details.")).toBe(
    "See the docs for details",
  );
  const long = summarize(`${"x".repeat(400)} tail`);
  expect(long.length).toBeLessThanOrEqual(201);
  expect(long.endsWith("…")).toBe(true);
});

it("区间挑选：只取 (previous, current]，新版本在前", () => {
  const sections = parseChangelog(CHANGELOG);
  expect(pickBullets(sections, "7.4.0", "7.5.0")).toEqual([
    "Program-internal task output",
    "The route-index token gate now measures the real install path",
  ]);
  // 跨两版：7.3.0 与 7.4.0 都在区间里，新版本在前
  expect(pickBullets(sections, "7.2.0", "7.4.0")).toEqual([
    "Two dead exports were removed, and the stale snapshot no longer ships",
    "Task-surface recall",
  ]);
  expect(pickBullets(sections, "7.5.0", "7.5.0")).toEqual([]);
});

it("第一次见到这套提示：基线取 CHANGELOG 的上一节 ⇒ 显示当前版本这一节", () => {
  const env = environment();
  const first = collector();
  showUpgradeNotice(first.ctx as never, env);
  expect(first.messages.length, "第一次见到这套提示也要说当前版本变了什么").toBe(1);
  expect(first.messages[0]!.startsWith("pi-ptc-subagents 7.5.0\n")).toBe(true);
  expect(first.messages[0]!.includes("Updated from"), "没有历史记录就不编「从哪版升来的」").toBe(
    false,
  );
  expect(first.messages[0]!.includes("- Program-internal task output"), "显示 7.5.0 这一节").toBe(
    true,
  );
  expect(
    first.messages[0]!.includes("Task-surface recall"),
    "不含更早的版本（7.3.0 在基线之外）",
  ).toBe(false);
  expect(
    JSON.parse(readFileSync(env.statePath, "utf8")).version,
    "也要落状态，否则每次启动都当第一次",
  ).toBe("7.5.0");
});

it("同版本不重复显示（状态哨兵记住见过的版本）", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.5.0" }), "utf8");
  const same = collector();
  showUpgradeNotice(same.ctx as never, env);
  expect(same.messages.length, "同版本不重复显示").toBe(0);
});

it("升级提示与时间无关：状态哨兵说了算，没有 TTL 窗口（假时钟）", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.5.0" }), "utf8");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const now = collector();
    showUpgradeNotice(now.ctx as never, env);
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
    const later = collector();
    showUpgradeNotice(later.ctx as never, env);
    expect(now.messages.length, "见过的那一版不该再提").toBe(0);
    expect(later.messages.length, "时间过去多久都不该重复提示").toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("有历史记录：显示旧版升上来的区间", () => {
  const older = environment();
  writeFileSync(older.statePath, JSON.stringify({ version: "7.3.0" }), "utf8");
  const upgraded = collector();
  showUpgradeNotice(upgraded.ctx as never, older);
  expect(upgraded.messages.length).toBe(1);
  expect(upgraded.messages[0]!.startsWith("pi-ptc-subagents 7.5.0\nUpdated from 7.3.0.")).toBe(
    true,
  );
  // 区间是 (previous, current]——previous 自己不在其中
  expect(upgraded.messages[0]!.includes("- Two dead exports were removed")).toBe(true);
  expect(upgraded.messages[0]!.includes("Task-surface recall")).toBe(false);
  expect(
    upgraded.messages[0]!.includes(
      "Changelog: https://github.com/a1121611810/pi-ptc-subagents/blob/main/CHANGELOG.md",
    ),
  ).toBe(true);
});

it("降级不显示也不把状态改低；状态写不进去就不显示", () => {
  const downgraded = environment();
  writeFileSync(downgraded.statePath, JSON.stringify({ version: "9.9.9" }), "utf8");
  const down = collector();
  showUpgradeNotice(down.ctx as never, downgraded);
  expect(down.messages.length, "降级不显示").toBe(0);
  expect(
    JSON.parse(readFileSync(downgraded.statePath, "utf8")).version,
    "状态记「见过的最高版本」：降级不改它，否则另一个副本每轮都被当成刚升级",
  ).toBe("9.9.9");

  const readonly = environment({ statePath: "/dev/null/nope/last-seen-version.json" }); // 父路径不可写
  const broken = collector();
  showUpgradeNotice(broken.ctx as never, readonly);
  expect(broken.messages.length, "状态写不进去就不显示").toBe(0);
});

it("没有 UI 不通知；通知文案是苹果风格", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.4.0" }), "utf8");
  const noUi = {
    messages: [] as string[],
    ctx: { hasUI: false, ui: { notify: (m: string) => noUi.messages.push(m) } },
  };
  showUpgradeNotice(noUi.ctx as never, env);
  expect(noUi.messages.length).toBe(0);

  const ui = collector();
  showUpgradeNotice(ui.ctx as never, env);
  const text = ui.messages[0]!;
  expect(text.startsWith("pi-ptc-subagents 7.5.0\nUpdated from 7.4.0.\n\nWhat's new:\n- ")).toBe(
    true,
  );
  expect(text.includes("\n\nChangelog: https://")).toBe(true);
  expect(text.includes("!"), "苹果风格：不用感叹号").toBe(false);
  expect(/We're|excited|Amazing/i.test(text), "苹果风格：不喊口号").toBe(false);
});

it("没话说就不占状态：没有可显示的版本段时，状态不写（这一版的提醒不能被烧掉）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-upgrade-"));
  const env = {
    version: "7.5.0",
    changelogPath: join(dir, "CHANGELOG.md"), // 文件不存在 ⇒ 解析不出段 ⇒ 没话说
    statePath: join(dir, "state", "last-seen-version.json"),
  };
  const messages: string[] = [];
  showUpgradeNotice({ hasUI: true, ui: { notify: (m: string) => messages.push(m) } } as never, env);
  expect(messages.length, "没 CHANGELOG 段就没话说").toBe(0);
  expect(existsSync(env.statePath), "没显示就别占状态——否则这一版的提醒被永久烧掉").toBe(false);
});

it("TUI 模式：升级提示走 widget 区，不走共享状态槽", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.4.0" }), "utf8");
  const widgets: Array<{ key: string; content: string[] }> = [];
  const messages: string[] = [];
  showUpgradeNotice(
    {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: (key: string, content: string[]) => widgets.push({ key, content }),
        notify: (m: string) => messages.push(m),
      },
    } as never,
    env,
  );
  expect(messages.length, "TUI 里不能走 notify——那个状态槽全局共享，后调者会把文案改掉").toBe(0);
  expect(widgets.length).toBe(1);
  expect(widgets[0]!.key).toBe("ptc-upgrade");
  expect(widgets[0]!.content[0]!.startsWith("pi-ptc-subagents 7.5.0")).toBe(true);
  expect(widgets[0]!.content.includes("Updated from 7.4.0.")).toBe(true);
  expect(
    widgets[0]!.content.some((line) => line.includes("Changelog: https://")),
    "Changelog 链接要在（截断就丢了）",
  ).toBe(true);
  expect(
    widgets[0]!.content.length,
    "widget 行数上限 10（pi 的 MAX_WIDGET_LINES），超了被截",
  ).toBeLessThanOrEqual(10);
  expect(
    widgets[0]!.content.every((line) => line.length > 0),
    "空行在 widget 里不占位，送之前先去掉",
  ).toBe(true);
});

it("TUI 模式：用户一开始输入就撤下提示（widget 常驻不修）", () => {
  const env = environment();
  writeFileSync(env.statePath, JSON.stringify({ version: "7.4.0" }), "utf8");
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  let subscribed = false;
  let handler: ((data: string) => void) | undefined;
  showUpgradeNotice(
    {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
        onTerminalInput: (h: (data: string) => void) => {
          subscribed = true;
          handler = h;
          return () => {
            subscribed = false;
          };
        },
        notify: () => {},
      },
    } as never,
    env,
  );
  expect(widgets.length, "提示先画出来").toBe(1);
  if (subscribed) handler?.("\u001b[A");
  expect(widgets.length, "方向键是纯导航，不撤——用户还没输入内容").toBe(1);
  if (subscribed) handler?.("\u0012");
  expect(widgets.length, "Ctrl 组合键同理不撤").toBe(1);
  if (subscribed) handler?.("x");
  expect(widgets.at(-1), "一输入就撤下").toEqual({ key: "ptc-upgrade", content: undefined });
  if (subscribed) handler?.("y");
  expect(widgets.length, "撤一次就退订，之后每键不再白调 setWidget").toBe(2);
});

/** 隔离地跑一次 entry 的 session_start：状态哨兵放 tmp，cwd 放 tmp，返回它发出的通知与 widget */
const runSessionStart = async (ctx: unknown): Promise<{ previous: string | undefined }> => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  const agentDir = mkdtempSync(join(tmpdir(), "ptc-upgrade-agent-"));
  const stateDir = join(agentDir, "pi-ptc-subagents");
  mkdirSync(stateDir, { recursive: true });
  const previous = parseChangelog(
    readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"),
  )[1]?.version;
  writeFileSync(join(stateDir, "last-seen-version.json"), JSON.stringify({ version: previous }));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir; // 状态哨兵隔离到 tmp，别碰用户真目录
  process.chdir(mkdtempSync(join(tmpdir(), "ptc-upgrade-cwd-")));
  try {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const fakePi = {
      on: (ev: string, cb: (event: unknown, ctx: unknown) => unknown) => {
        (handlers[ev] ??= []).push(cb);
      },
      registerTool: () => {},
      registerCommand: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {},
      getAllTools: () => [] as Array<{ name: string }>,
      sendMessage: () => {},
    };
    entryDefault(fakePi as never);
    await handlers.session_start?.[0]?.({}, ctx);
    return { previous };
  } finally {
    process.chdir(savedCwd);
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
};

it("entry 层：TUI 模式下升级提示进 widget 区，不进共享状态槽", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const widgets: Array<{ key: string; content: string[] }> = [];
  const messages: string[] = [];
  const { previous } = await runSessionStart({
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget: (key: string, content: string[]) => widgets.push({ key, content }),
      notify: (m: string) => messages.push(m),
    },
  });
  const upgrade = widgets.find((w) => w.key === "ptc-upgrade");
  expect(upgrade, "升级提示没进 widget 区").toBeDefined();
  expect(upgrade!.content[0]!.startsWith(`pi-ptc-subagents ${pkg.version}`)).toBe(true);
  expect(upgrade!.content.includes(`Updated from ${previous}.`), "显示从哪版升上来的").toBe(true);
  expect(
    messages.every((m) => m.startsWith("pi-ptc-subagents: surface=")),
    "共享状态槽里只该剩 surface 面包屑",
  ).toBe(true);
});

it("entry 层：没有 widget 通道时（老 pi）退回 notify，且必须是最后一条", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const messages: string[] = [];
  const { previous } = await runSessionStart({
    hasUI: true,
    ui: { notify: (m: string) => messages.push(m) },
  });
  const last = messages.at(-1) ?? "";
  expect(
    last.startsWith(`pi-ptc-subagents ${pkg.version}`),
    `退回 notify 时升级提示必须排最后——共享状态槽里后发的会顶掉先发的（实得：${last.slice(0, 60)}）`,
  ).toBe(true);
  expect(last.includes(`Updated from ${previous}.`), "显示从哪版升上来的").toBe(true);
  expect(
    messages.some((m) => m.startsWith("pi-ptc-subagents: surface=")),
    "surface 面包屑仍然要发",
  ).toBe(true);
});

it("格式漂移守卫：本仓真实 CHANGELOG 的顶节版本 == package.json 版本", () => {
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const sections = parseChangelog(changelog);
  expect(sections.length, "真实 CHANGELOG 解析不出版本段——格式变了").toBeGreaterThan(0);
  expect(sections[0]!.version, "顶节版本与 package.json 不一致").toBe(pkg.version);
  expect(sections[0]!.bullets.length, "顶节没有要点——解析器或 CHANGELOG 格式变了").toBeGreaterThan(
    0,
  );
});

it("已安装包的定位：发布形态 <pkg>/dist/ 与开发形态仓库根都认得出", () => {
  // 发布形态（npm 装出来的样子）：<pkg>/package.json + <pkg>/dist/index.js
  const dir = mkdtempSync(join(tmpdir(), "ptc-installed-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "pi-ptc-subagents", version: "7.5.0" }),
    "utf8",
  );
  const installed = findInstalledPackage(`file://${join(dir, "dist", "index.js")}`);
  expect(installed, "认不出已安装包——产物目录一变，功能会静默失效").toBeDefined();
  expect(installed!.version).toBe("7.5.0");
  expect(installed!.dir).toBe(dir);

  // 开发形态：这个 bundle 自己在 packages/entry/dist/，包根在仓库根
  const self = findInstalledPackage();
  expect(self, "开发形态认不出仓库根").toBeDefined();
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(self!.version).toBe(pkg.version);
});
