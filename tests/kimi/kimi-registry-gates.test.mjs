// P2 → 测试：Kimi 区机械门禁——模型可见工具的唯一出处是册子 KIMI_MCP_TOOLS（ADR-0020 决策 6 落地）
// 守门：tools/list ↔ 册子记录双向一致 · schema 字段描述全覆盖 · 描述 token 预算 · server 散文必须来自册子渲染
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIMI_MCP_TOOLS } from "../../packages/routes/dist/index.js";

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/kimi-mcp/dist/server.js",
);
const DESCRIPTION_TOKEN_BUDGET = 400; // 单工具描述的启发式预算（中英混排 2 字符/token）

function startServer(envOverride) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: envOverride ?? process.env,
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, request };
}

test("门禁 K1 册子自检：每条 Kimi 工具描述非空且在 token 预算内", () => {
  for (const [key, entry] of Object.entries(KIMI_MCP_TOOLS)) {
    const description = entry.description();
    assert.ok(description.length > 20, `${key} 描述过短——散文必须真在册子里`);
    const tokens = Math.ceil(description.length / 2);
    assert.ok(
      tokens <= DESCRIPTION_TOKEN_BUDGET,
      `${key} 描述 ${tokens} token 超预算 ${DESCRIPTION_TOKEN_BUDGET}——详情挪进 SKILL.md`,
    );
    for (const [field, text] of Object.entries(entry.inputSchemaDescriptions)) {
      assert.ok(text.length > 4, `${key}.inputSchemaDescriptions.${field} 缺描述`);
    }
  }
});

test("门禁 K2 双向覆盖：server tools/list 与册子 KIMI_MCP_TOOLS 完全一致（两向都不许多/少）", async (t) => {
  const srv = startServer();
  t.after(() => srv.child.kill());
  await srv.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gate", version: "0" },
  });
  const { tools } = await srv.request("tools/list");
  const listed = tools.map((tool) => tool.name).sort();
  const registered = Object.values(KIMI_MCP_TOOLS)
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(listed, registered, "server 工具表必须逐名等于册子记录（shape 漂移即红）");
  for (const tool of tools) {
    const entry = Object.values(KIMI_MCP_TOOLS).find((e) => e.name === tool.name);
    assert.equal(tool.description, entry.description(), `${tool.name} 描述必须逐字来自册子渲染`);
    for (const field of tool.inputSchema.required) {
      assert.ok(
        tool.inputSchema.properties[field].description,
        `${tool.name}.required.${field} 缺 schema 描述（散文覆盖）`,
      );
    }
  }
});

test("门禁 K3 web_ds_search 参数校验：缺 query/url、count 越界都拒（fail-soft 不炸 server）", async (t) => {
  const srv = startServer();
  t.after(() => srv.child.kill());
  await srv.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gate", version: "0" },
  });
  const call = (arguments_) =>
    srv.request("tools/call", { name: "web_ds_search", arguments: arguments_ });

  const missingQuery = await call({ action: "search" });
  assert.equal(missingQuery.isError, true);
  assert.match(missingQuery.content[0].text, /search 动作需要 query/);

  const missingUrl = await call({ action: "open" });
  assert.equal(missingUrl.isError, true);
  assert.match(missingUrl.content[0].text, /open 动作需要 url/);

  const badCount = await call({ action: "search", query: "x", count: 99 });
  assert.equal(badCount.isError, true);
  assert.match(badCount.content[0].text, /count 必须是 1–50/);

  // 缺 key 的 fail-soft：合法参数走到 provider，报可读错误而不是崩 server
  // 本机 kimi config 配了 DeepSeek——必须把 key 来源全掐了才测得到 missing-key 分支
  const noKeyEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: "",
  };
  const noKeySrv = startServer({
    ...noKeyEnv,
    KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), "ptc-nokey-home-")),
  });
  const noKey = await noKeySrv.request("tools/call", {
    name: "web_ds_search",
    arguments: { action: "search", query: "kimi" },
  });
  assert.equal(noKey.isError, true);
  noKeySrv.child.kill();

  // 注释掉的 api_key 不许被捡起来（「注释即停用」）：段内只留注释 key → 同样落 missing-key
  const commentedHome = mkdtempSync(join(tmpdir(), "ptc-commented-home-"));
  writeFileSync(
    join(commentedHome, "config.toml"),
    '[providers.DeepSeek]\ntype = "openai"\n# api_key = "sk-stale-disabled"\n',
  );
  const commentedSrv = startServer({ ...noKeyEnv, KIMI_CODE_HOME: commentedHome });
  const commented = await commentedSrv.request("tools/call", {
    name: "web_ds_search",
    arguments: { action: "search", query: "kimi" },
  });
  assert.equal(commented.isError, true, "注释掉的 api_key 必须视为停用");
  commentedSrv.child.kill();
});
