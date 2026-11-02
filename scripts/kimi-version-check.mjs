// 插件自带的新版探测：比对本插件 manifest 的版本与 GitHub 最新 Release
// 挂在 UserPromptSubmit hook 上——stdout 会作为 <hook_result> 挂到用户消息上，模型看得见，
// 于是「有新版」这件事不会沉默（Kimi Code 自己的更新徽标只认市场目录条目，见 ADR-0021/0022）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = "a1121611810/pi-ptc-subagents";
// 测试缝：指向别处的 latest-release 端点（默认走 GitHub 的 /releases/latest 重定向，不打 api.github.com）
const RELEASES_URL =
  process.env["PTC_UPDATE_CHECK_URL"] ?? `https://github.com/${REPO}/releases/latest`;
// 多久查一次 GitHub——发布到「用户知道」的上限。窗口越长越容易「刚查完就发版」：
// 6h 那版把 7.8.0/7.9.0 两次发布全吞了；15min 那版让 7.9.2（发在检查之后 26 秒）隐身一整个窗口
const TTL_MS = 60 * 1000;
const REMIND_MS = 7 * 24 * 60 * 60 * 1000; // 同一版本过这么久再提一次（用户可能无视了上一轮）
const FETCH_TIMEOUT_MS = 6000; // 冷启动首连可能 >3s（实测有过一次 5s+）——别让慢网络把提示拖没了

const root = process.env["KIMI_PLUGIN_ROOT"] ?? process.cwd();
const home = process.env["KIMI_CODE_HOME"] ?? join(tmpdir(), "kimi-code");
const statePath = join(home, "cache", "ptc-tools-update-check.json");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // 缓存写不进去不影响本次判断
  }
}

// 只认 x.y.z 形态（纯 semver；GitHub tag 常带 v 前缀）
function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw ?? "");
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(latest, installed) {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== installed[i]) return latest[i] > installed[i];
  }
  return false;
}

async function fetchLatestVersion() {
  const resp = await fetch(RELEASES_URL, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const location = resp.headers.get("location");
  if (location === null) return undefined;
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
  if (parseVersion(tag) === undefined) return undefined;
  return tag.replace(/^v/, "");
}

async function main() {
  const manifest =
    readJson(join(root, "kimi.plugin.json")) ?? readJson(join(root, ".kimi-plugin", "plugin.json"));
  const installed = parseVersion(manifest?.version);
  if (installed === undefined) return;

  const state = readJson(statePath) ?? {};
  const now = Date.now();

  if (now - (state.checkedAt ?? 0) > TTL_MS) {
    const latest = await fetchLatestVersion().catch(() => undefined);
    state.checkedAt = now; // 查失败也记时间：离线时不每条消息都卡一次超时
    if (latest !== undefined) state.latest = latest;
    writeState(state); // 已是最新也要落盘——否则每条消息都去问一次 GitHub
  }

  const latest = parseVersion(state.latest);
  if (latest === undefined || !isNewer(latest, installed)) return;
  if (state.notifiedVersion === state.latest && now - (state.notifiedAt ?? 0) < REMIND_MS) return;

  state.notifiedVersion = state.latest;
  state.notifiedAt = now;
  writeState(state);

  const current = installed.join(".");
  const newest = latest.join(".");
  console.log(
    `ptc-tools 有新版本（当前 ${current} → 最新 ${newest}）。` +
      `更新：/plugins install https://github.com/${REPO}（裸仓库 URL 会装最新 Release）；` +
      `或在 /plugins 面板选中 ptc-tools 按 Enter。这条提示每个版本只出现一次，说一次就够。`,
  );
}

await main().catch(() => {
  // fail-open：探测失败不该打断用户的回合
});
