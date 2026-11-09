import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "@pi-ptc/tui";

const PACKAGE_NAME = "pi-ptc-subagents";
const BULLET_LIMIT = 5;
const SUMMARY_MAX = 200;
/** Keep a Changelog 里只有这三段是"变了什么"；Verification/Compatibility 是测试与兼容矩阵，不是要点 */
const CHANGE_SECTIONS = ["Added", "Changed", "Fixed"];

export interface ChangelogSection {
  version: string;
  bullets: string[];
}

export interface NoticeUi {
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  setWidget?: (key: string, content: string[] | undefined) => void;
  /** pi interactive 模式的原始键盘输入（TUI 才有）；老版本 pi 没有 ⇒ 提示不自动撤下 */
  onTerminalInput?: (handler: TerminalInputHandler) => () => void;
}

export interface NoticeContext {
  hasUI?: boolean;
  /** pi 的运行模式（"tui" | "rpc" | "json" | "print"）——TUI 有独立的 widget 区可用 */
  mode?: string;
  ui?: NoticeUi;
}

/** TUI 里升级提示的落点：按 key 隔离的 widget 区（编辑器上方），不与别的扩展抢 */
const UPGRADE_WIDGET_KEY = "ptc-upgrade";

/** 已装包的事实——测试注入用，默认从 import.meta.url 定位已安装目录 */
export interface NoticeEnvironment {
  version: string;
  repository?: string;
  changelogPath: string;
  statePath: string;
}

/** x.y.z → 可比整数；非 semver → undefined */
export function versionNumber(version: unknown): number | undefined {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const parts = version.split(".").map(Number);
  return (parts[0] ?? 0) * 1e12 + (parts[1] ?? 0) * 1e6 + (parts[2] ?? 0);
}

/** CHANGELOG.md → 版本段（文件里新版本在前） */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const raw of text.split(/^## /m).slice(1)) {
    const version = /^\[(\d+\.\d+\.\d+)\]/.exec(raw)?.[1];
    if (!version) continue;
    const bullets: string[] = [];
    let inChangeSection = false;
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) bullets.push(current.join(" "));
      current = [];
    };
    for (const line of raw.split("\n")) {
      const heading = /^###\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        inChangeSection = CHANGE_SECTIONS.includes(heading[1]?.trim() ?? "");
        continue;
      }
      if (!inChangeSection) continue;
      if (line.startsWith("- ")) {
        flush();
        current = [line.slice(2).trim()];
        continue;
      }
      if (current.length > 0 && line.trim().length > 0) {
        current.push(line.trim());
        continue;
      }
      flush();
    }
    flush();
    sections.push({ version, bullets });
  }
  return sections;
}

/** bullet → 一行要点：粗体标题是作者自己的摘要，优先用它；否则取首句。列表项统一不带句点 */
export function summarize(bullet: string): string {
  const title = /^\*\*(.+?)\*\*/.exec(bullet);
  if (title) return truncate(stripMarkdown(title[1] ?? "").replace(/\.$/, ""));
  const sentence = /(?<!\d)\.(?=\s)/.exec(bullet);
  const head = sentence ? bullet.slice(0, sentence.index + 1) : bullet;
  return truncate(stripMarkdown(head).replace(/\.$/, ""));
}

/** (previous, current] 区间的要点，新版本在前 */
export function pickBullets(
  sections: ChangelogSection[],
  previous: string,
  current: string,
): string[] {
  const low = versionNumber(previous);
  const high = versionNumber(current);
  if (low === undefined || high === undefined) return [];
  const bullets: string[] = [];
  for (const section of sections) {
    const value = versionNumber(section.version);
    if (value === undefined || value <= low || value > high) continue;
    for (const bullet of section.bullets) bullets.push(summarize(bullet));
  }
  return bullets;
}

export function showUpgradeNotice(ctx: NoticeContext, environment?: NoticeEnvironment): void {
  if (!ctx.hasUI) return;
  if (typeof ctx.ui?.notify !== "function") return;
  const env = environment ?? resolveEnvironment();
  if (!env) return;
  const current = versionNumber(env.version);
  if (current === undefined) return;
  const previous = readSeenVersion(env.statePath);
  const previousNumber = versionNumber(previous);
  if (previousNumber === current) return;
  // 降级：不显示也不改状态——状态记「见过的最高版本」，否则两份副本互相顶、每轮都提示
  if (previousNumber !== undefined && previousNumber > current) return;
  const sections = parseChangelog(readText(env.changelogPath));
  // 没有历史记录（第一次见到这套提示）：基线取 CHANGELOG 里比当前版本小的最新一节 ⇒ 显示当前版本这一节
  const baseline =
    previousNumber === undefined ? newestOlderVersion(sections, env.version) : previous;
  // 没话说就不占状态：否则这一版的提醒被永久烧掉（下一版也补不回来）
  if (baseline === undefined) return;
  // 先落状态再通知：写不进去就直接不显示——否则只读安装每次启动都刷同一条
  if (!writeSeenVersion(env.statePath, env.version)) return;
  const bullets = pickBullets(sections, baseline, env.version);
  deliver(
    ctx,
    compose(
      previousNumber === undefined ? undefined : previous,
      env.version,
      bullets,
      changelogUrl(env.repository),
    ),
  );
}

/**
 * 送达：TUI 走按 key 隔离的 widget 区，其它模式走 notify。
 * ⚠️ TUI 里不能用 notify：那个状态槽全局共享，而且每个状态文本都动态读同一个 lastStatusMessage
 * ——任何扩展（ponytail / session-title / tok-speed…）后调一次 showStatus，我们的文案就被改成别人的，
 * 连一次都没被画出来（2026-11-02 真机复现：字节流里搜不到我们的字）。
 */
function deliver(ctx: NoticeContext, text: string): void {
  const ui = ctx.ui;
  if (ctx.mode === "tui" && typeof ui?.setWidget === "function") {
    // widget 不自带关闭：用户一开始输入就撤下，不然常驻编辑器上方
    const setWidget = ui.setWidget;
    setWidget(
      UPGRADE_WIDGET_KEY,
      text.split("\n").filter((line) => line.length > 0),
    );
    let off: (() => void) | undefined;
    off = ui.onTerminalInput?.((data) => {
      // 只认「真输入」：方向键等只产生转义序列，剥掉后没内容就不撤
      if (stripAnsi(data).length === 0) return;
      off?.();
      setWidget(UPGRADE_WIDGET_KEY, undefined);
    });
    return;
  }
  ui?.notify?.(text, "info");
}

export interface InstalledPackage {
  dir: string;
  version: string;
  repository?: string;
}

/** 已安装包：bundle 往上找 package.json，name 对上就是它——发布形态 <pkg>/dist/index.js，开发形态仓库根 */
export function findInstalledPackage(
  bundleUrl: string = import.meta.url,
): InstalledPackage | undefined {
  for (const relative of ["..", "../../.."]) {
    try {
      const dir = fileURLToPath(new URL(`${relative}/`, bundleUrl)).replace(/[\\/]+$/, "");
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        repository?: string | { url?: string };
      };
      if (pkg.name !== PACKAGE_NAME || !pkg.version) continue;
      return {
        dir,
        version: pkg.version,
        repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      };
    } catch {
      // 下一个候选
    }
  }
  return undefined;
}

function resolveEnvironment(): NoticeEnvironment | undefined {
  const pkg = findInstalledPackage();
  if (!pkg) return undefined;
  return {
    version: pkg.version,
    repository: pkg.repository,
    changelogPath: join(pkg.dir, "CHANGELOG.md"),
    statePath: join(getAgentDir(), PACKAGE_NAME, "last-seen-version.json"),
  };
}

/** CHANGELOG 里比当前版本小的最新一节——没有历史记录时用它当基线 */
function newestOlderVersion(sections: ChangelogSection[], current: string): string | undefined {
  const high = versionNumber(current);
  if (high === undefined) return undefined;
  let best: string | undefined;
  for (const section of sections) {
    const value = versionNumber(section.version);
    if (value === undefined || value >= high) continue;
    if (best === undefined || value > (versionNumber(best) ?? 0)) best = section.version;
  }
  return best;
}

function compose(
  previous: string | undefined,
  version: string,
  bullets: string[],
  url: string | undefined,
): string {
  const lines = [`${PACKAGE_NAME} ${version}`];
  if (previous !== undefined) lines.push(`Updated from ${previous}.`);
  if (bullets.length > 0) {
    lines.push("", "What's new:");
    for (const bullet of bullets.slice(0, BULLET_LIMIT)) lines.push(`- ${bullet}`);
    if (bullets.length > BULLET_LIMIT) lines.push(`...and ${bullets.length - BULLET_LIMIT} more`);
  }
  if (url) lines.push("", `Changelog: ${url}`);
  return lines.join("\n");
}

function changelogUrl(repository: string | undefined): string | undefined {
  if (!repository) return undefined;
  const url = repository.replace(/^git\+/, "").replace(/\.git$/, "");
  return url.startsWith("https://github.com/") ? `${url}/blob/main/CHANGELOG.md` : undefined;
}

function readSeenVersion(statePath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function writeSeenVersion(statePath: string, version: string): boolean {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ version }));
    return true;
  } catch {
    return false;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

function truncate(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : SUMMARY_MAX).trimEnd()}…`;
}
