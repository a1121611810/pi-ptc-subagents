// Kimi 面的运行时三件事：采用率闸门（PreToolUse 拦截）/ 插件自带新版探测（UserPromptSubmit hook）/ server 正确性矩阵。
// 前两件是插件自带的两个 hook 脚本（scripts/ 下，发布物里在 release/kimi/），第三件调用判据脚本本身——
// 判据不重写：spawn 判据脚本，断言退出码与关键输出。
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  NUDGE_BUDGET,
  RUN_THRESHOLD,
  RunDetector,
  classifyTool,
} from "../../scripts/lib/tool-shape.mjs";
import { runScript } from "../helpers/run-script.ts";

const NUDGE = fileURLToPath(new URL("../../scripts/kimi-nudge.mjs", import.meta.url));
const VERSION_CHECK = fileURLToPath(
  new URL("../../scripts/kimi-version-check.mjs", import.meta.url),
);

// ---- 采用率闸门 ----

const sessionId = () => `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const nudge = (
  toolName: string,
  toolInput: unknown,
  session: string,
  env: Record<string, string> = {},
) =>
  runScript(
    NUDGE,
    { PTC_NUDGE: "1", ...env },
    JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: session }),
  );

it("同形态连打第 5 次被阻断（exit 2 + 阻断理由）", async () => {
  const session = sessionId();
  const codes: number[] = [];
  for (let i = 0; i < RUN_THRESHOLD; i++) {
    codes.push((await nudge("Grep", { pattern: "x" }, session)).code);
  }
  expect(codes.slice(0, RUN_THRESHOLD - 1)).toEqual([0, 0, 0, 0]);
  expect(codes[RUN_THRESHOLD - 1]).toBe(2);
});

it("阻断理由只陈述既有规则并给重试出口", async () => {
  const session = sessionId();
  let last: Run | undefined;
  for (let i = 0; i < RUN_THRESHOLD; i++) {
    last = await nudge("Grep", { pattern: "x" }, session);
  }
  expect(last?.code).toBe(2);
  expect(last?.stderr).toContain(`连续第 ${RUN_THRESHOLD} 次`);
  expect(last?.stderr).toContain("Grep 扇出");
  expect(last?.stderr).toContain("ptc_run_code");
  expect(last?.stderr).toContain("原样重试本调用即可");
});

it("形态切换打断 run（Read 之后重新攒 5 连）", async () => {
  const session = sessionId();
  const codes: number[] = [];
  for (let i = 0; i < RUN_THRESHOLD - 1; i++) codes.push((await nudge("Grep", {}, session)).code);
  codes.push((await nudge("Read", { path: "a" }, session)).code);
  for (let i = 0; i < RUN_THRESHOLD - 1; i++) codes.push((await nudge("Grep", {}, session)).code);
  expect(codes.every((code) => code === 0)).toBe(true);
  expect((await nudge("Grep", {}, session)).code).toBe(2); // 重新攒满 5 连才拦
});

it("PTC_NUDGE=0 整体关停：连打 5 次也不拦", async () => {
  const session = sessionId();
  const codes: number[] = [];
  for (let i = 0; i < RUN_THRESHOLD + 1; i++) {
    codes.push((await nudge("Grep", {}, session, { PTC_NUDGE: "0" })).code);
  }
  expect(codes.every((code) => code === 0)).toBe(true);
});

it("fail-open：钩子自身异常（坏 JSON）也放行", async () => {
  const broken = await runScript(NUDGE, { PTC_NUDGE: "1" }, "{not json");
  expect(broken.code).toBe(0);
  expect(broken.stderr).not.toContain("连续第");
});

it("分类器：文件五件套映射，ptc 自身与其余工具透明", () => {
  expect(classifyTool("Read", {})).toBe("Read");
  expect(classifyTool("Grep", {})).toBe("Grep");
  expect(classifyTool("Glob", {})).toBe("Glob");
  expect(classifyTool("Edit", {})).toBe("Edit");
  expect(classifyTool("Write", {})).toBe("Write");
  expect(classifyTool("Bash", { command: "grep -r foo src" })).toBe("BashRead");
  expect(classifyTool("Bash", { command: "git status" })).toBe(null);
  expect(classifyTool("mcp__plugin-ptc-tools_ptc__ptc_run_code", {})).toBe(null);
  expect(classifyTool("mcp__plugin-ptc-tools_ptc__web_ds_search", {})).toBe(null);
  expect(classifyTool("WebSearch", {})).toBe(null);
});

it("RunDetector：恰第 N 次触发一次，触发后归零可重试", () => {
  const detector = new RunDetector();
  const hits = Array.from({ length: RUN_THRESHOLD * 2 }, () => detector.step("Grep"));
  expect(hits.filter(Boolean).length).toBe(2);
  expect(hits[RUN_THRESHOLD - 1]).toBe(true);
  expect(hits[RUN_THRESHOLD * 2 - 1]).toBe(true);
});

it(`RunDetector：预算 ${NUDGE_BUDGET} 次封顶`, () => {
  const detector = new RunDetector();
  const hits = Array.from({ length: RUN_THRESHOLD * (NUDGE_BUDGET + 1) }, () =>
    detector.step("Grep"),
  );
  expect(hits.filter(Boolean).length).toBe(NUDGE_BUDGET);
  expect(hits[RUN_THRESHOLD * (NUDGE_BUDGET + 1) - 1]).toBe(false);
});

// ---- 插件自带新版探测 ----

const NOW = Date.now();

function versionFixture(version = "7.6.0", state?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ptc-upd-"));
  writeFileSync(join(root, "kimi.plugin.json"), JSON.stringify({ name: "ptc-tools", version }));
  const home = mkdtempSync(join(tmpdir(), "ptc-upd-home-"));
  if (state !== undefined) {
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "ptc-tools-update-check.json"), JSON.stringify(state));
  }
  return { root, home };
}

const checkVersion = (fx: { root: string; home: string }, url = "http://127.0.0.1:1/unreachable") =>
  runScript(VERSION_CHECK, {
    KIMI_PLUGIN_ROOT: fx.root,
    KIMI_CODE_HOME: fx.home,
    PTC_UPDATE_CHECK_URL: url,
  });

it("同版本：不出声", async () => {
  const out = await checkVersion(versionFixture("7.6.0", { checkedAt: NOW, latest: "7.6.0" }));
  expect(out.stdout).toBe("");
});

it("有新版：出声，并给出当前版本、最新版本与更新命令", async () => {
  const out = await checkVersion(versionFixture("7.6.0", { checkedAt: NOW, latest: "7.7.0" }));
  expect(out.stdout).toMatch(/ptc-tools 有新版本/);
  expect(out.stdout).toContain("7.6.0");
  expect(out.stdout).toContain("7.7.0");
  expect(out.stdout).toContain("github.com/a1121611810/pi-ptc-subagents");
});

it("UserPromptSubmit 通道：提示走 stdout（模型看得见），stderr 干净", async () => {
  const out = await checkVersion(versionFixture("7.6.0", { checkedAt: NOW, latest: "7.7.0" }));
  expect(out.stdout).toContain("ptc-tools 有新版本");
  expect(out.stderr).toBe("");
  expect(out.code).toBe(0);
});

it("同一版本只提醒一次（不每轮唠叨）", async () => {
  const out = await checkVersion(
    versionFixture("7.6.0", {
      checkedAt: NOW,
      latest: "7.7.0",
      notifiedVersion: "7.7.0",
      notifiedAt: NOW,
    }),
  );
  expect(out.stdout).toBe("");
});

it("同一版本被无视一周后：再提一次", async () => {
  const out = await checkVersion(
    versionFixture("7.6.0", {
      checkedAt: NOW,
      latest: "7.7.0",
      notifiedVersion: "7.7.0",
      notifiedAt: NOW - 8 * 24 * 60 * 60 * 1000,
    }),
  );
  expect(out.stdout).toContain("7.7.0");
});

it("离线（拉不到 latest）：静默且不报错", async () => {
  const out = await checkVersion(versionFixture("7.6.0"));
  expect(out.stdout).toBe("");
  expect(out.code).toBe(0);
});

it("拉到 latest release：解析 tag 并出声（并落缓存）", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const fx = versionFixture("7.6.0");
  try {
    const out = await checkVersion(fx, `http://127.0.0.1:${port}/releases/latest`);
    expect(out.stdout).toContain("9.9.9");
    expect(out.stdout).toContain("7.6.0");
  } finally {
    server.close();
  }
  const state = JSON.parse(
    readFileSync(join(fx.home, "cache", "ptc-tools-update-check.json"), "utf8"),
  ) as { latest: string; checkedAt: number };
  expect(state.latest).toBe("9.9.9");
  expect(state.checkedAt).toBeGreaterThan(0);
});

it("已是最新时也落缓存（不每条消息都去问 GitHub）", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.test/releases/tag/v7.7.0" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const fx = versionFixture("7.7.0");
  try {
    const out = await checkVersion(fx, `http://127.0.0.1:${port}/releases/latest`);
    expect(out.stdout).toBe("");
  } finally {
    server.close();
  }
  const state = JSON.parse(
    readFileSync(join(fx.home, "cache", "ptc-tools-update-check.json"), "utf8"),
  ) as { latest: string; checkedAt: number };
  expect(state.checkedAt).toBeGreaterThan(0);
  expect(state.latest).toBe("7.7.0");
});

it("TTL 窗口内不再问 GitHub（用缓存里的 latest 出声）", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const out = await checkVersion(
      versionFixture("7.6.0", { checkedAt: NOW - 30 * 1000, latest: "7.7.0" }),
      `http://127.0.0.1:${port}/releases/latest`,
    );
    expect(hits).toBe(0);
    expect(out.stdout).toContain("7.7.0");
  } finally {
    server.close();
  }
});

it("TTL 过期就重新问 GitHub（发布后最迟一个窗口就知道）", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const out = await checkVersion(
      versionFixture("7.6.0", { checkedAt: NOW - 90 * 1000, latest: "7.6.0" }),
      `http://127.0.0.1:${port}/releases/latest`,
    );
    expect(hits).toBe(1);
    expect(out.stdout).toContain("9.9.9");
  } finally {
    server.close();
  }
});

it("插件根没有 manifest：静默退出", async () => {
  const home = mkdtempSync(join(tmpdir(), "ptc-upd-home-"));
  const root = mkdtempSync(join(tmpdir(), "ptc-upd-"));
  const out = await runScript(VERSION_CHECK, { KIMI_PLUGIN_ROOT: root, KIMI_CODE_HOME: home });
  expect(out.stdout).toBe("");
});
