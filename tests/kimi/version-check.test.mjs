// Kimi 面：插件自带的新版探测（UserPromptSubmit hook 的那份脚本）——版本比较、去重、离线静默、tag 解析
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/kimi-version-check.mjs",
);
const NOW = Date.now();

function fixture(version = "7.6.0", state) {
  const root = mkdtempSync(join(tmpdir(), "ptc-upd-"));
  writeFileSync(join(root, "kimi.plugin.json"), JSON.stringify({ name: "ptc-tools", version }));
  const home = mkdtempSync(join(tmpdir(), "ptc-upd-home-"));
  if (state !== undefined) {
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "ptc-tools-update-check.json"), JSON.stringify(state));
  }
  return { root, home };
}

async function check(fx, url = "http://127.0.0.1:1/unreachable") {
  const { stdout } = await run(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      KIMI_PLUGIN_ROOT: fx.root,
      KIMI_CODE_HOME: fx.home,
      PTC_UPDATE_CHECK_URL: url,
    },
  });
  return stdout;
}

test("同版本：不出声", async () => {
  const out = await check(fixture("7.6.0", { checkedAt: NOW, latest: "7.6.0" }));
  assert.equal(out, "");
});

test("有新版：出声，并给出当前版本、最新版本与更新命令", async () => {
  const out = await check(fixture("7.6.0", { checkedAt: NOW, latest: "7.7.0" }));
  assert.match(out, /ptc-tools 有新版本/);
  assert.match(out, /7\.6\.0/);
  assert.match(out, /7\.7\.0/);
  assert.match(out, /github\.com\/a1121611810\/pi-ptc-subagents/);
});

test("同一版本只提醒一次（不每轮唠叨）", async () => {
  const out = await check(
    fixture("7.6.0", {
      checkedAt: NOW,
      latest: "7.7.0",
      notifiedVersion: "7.7.0",
      notifiedAt: NOW,
    }),
  );
  assert.equal(out, "");
});

test("同一版本被无视一周后：再提一次", async () => {
  const out = await check(
    fixture("7.6.0", {
      checkedAt: NOW,
      latest: "7.7.0",
      notifiedVersion: "7.7.0",
      notifiedAt: NOW - 8 * 24 * 60 * 60 * 1000,
    }),
  );
  assert.match(out, /7\.7\.0/);
});

test("离线（拉不到 latest）：静默且不报错", async () => {
  const out = await check(fixture("7.6.0"));
  assert.equal(out, "");
});

test("拉到 latest release：解析 tag 并出声", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const fx = fixture("7.6.0");
  try {
    const out = await check(fx, `http://127.0.0.1:${port}/releases/latest`);
    assert.match(out, /9\.9\.9/);
    assert.match(out, /7\.6\.0/);
  } finally {
    server.close();
  }
  // 结果落进缓存：下一条消息不再走网络
  const state = JSON.parse(
    readFileSync(join(fx.home, "cache", "ptc-tools-update-check.json"), "utf8"),
  );
  assert.equal(state.latest, "9.9.9");
  assert.ok(state.checkedAt > 0);
});

test("已是最新时也落缓存（不每条消息都去问 GitHub）", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.test/releases/tag/v7.7.0" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const fx = fixture("7.7.0");
  try {
    const out = await check(fx, `http://127.0.0.1:${port}/releases/latest`);
    assert.equal(out, "", "已是最新就不该出声");
  } finally {
    server.close();
  }
  const state = JSON.parse(
    readFileSync(join(fx.home, "cache", "ptc-tools-update-check.json"), "utf8"),
  );
  assert.ok(state.checkedAt > 0, "checkedAt 没落盘 ⇒ TTL 失效，每条消息都重新拉");
  assert.equal(state.latest, "7.7.0");
});

test("TTL 窗口内不再问 GitHub（用缓存里的 latest 出声）", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const out = await check(
      fixture("7.6.0", { checkedAt: NOW - 30 * 1000, latest: "7.7.0" }),
      `http://127.0.0.1:${port}/releases/latest`,
    );
    assert.equal(hits, 0, "TTL 窗口内不该再走网络");
    assert.match(out, /7\.7\.0/, "窗口内仍要用缓存里的 latest 出声");
  } finally {
    server.close();
  }
});

test("TTL 过期就重新问 GitHub（发布后最迟一个窗口就知道）", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: "https://example.test/releases/tag/v9.9.9" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const out = await check(
      fixture("7.6.0", { checkedAt: NOW - 90 * 1000, latest: "7.6.0" }),
      `http://127.0.0.1:${port}/releases/latest`,
    );
    assert.equal(hits, 1, "TTL 过期就该重新拉");
    assert.match(out, /9\.9\.9/);
  } finally {
    server.close();
  }
});

test("插件根没有 manifest：静默退出", async () => {
  const home = mkdtempSync(join(tmpdir(), "ptc-upd-home-"));
  const root = mkdtempSync(join(tmpdir(), "ptc-upd-"));
  const { stdout } = await run(process.execPath, [SCRIPT], {
    env: { ...process.env, KIMI_PLUGIN_ROOT: root, KIMI_CODE_HOME: home },
  });
  assert.equal(stdout, "");
  assert.ok(!existsSync(join(home, "cache", "ptc-tools-update-check.json")));
});
