// P1 → 测试：Kimi 面 MCP 协议探针——真 spawn server.js 走 stdio JSON-RPC（initialize/tools/list/tools/call）
// 防假绿：tools/call 真起 worker 运行格，程序经四件套读写 fixture；workdir 越界走 isError 分支
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/kimi-mcp/dist/server.js",
);

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  child.stdout.on("data", (d) => {
    buf += String(d);
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting ${method}; stderr=${stderr.join("").slice(0, 400)}`));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, request, notify, stderr };
}

test("MCP 全握手 + tools/call 真跑程序（含 workdir 锁两分支）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-mcp-"));
  writeFileSync(join(dir, "a.txt"), "kimi-mcp-fixture");
  const srv = startServer();
  t.after(() => srv.child.kill());

  const init = await srv.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  });
  assert.equal(init.serverInfo.name, "ptc-tools");
  srv.notify("notifications/initialized");

  const tools = await srv.request("tools/list");
  assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0].name, "ptc_run_code");
  assert.ok(tools.tools[0].description.includes("tools.<name>"), "工具描述必须是册子渲染的散文");
  assert.deepEqual(tools.tools[0].inputSchema.required, ["code", "description", "workdir"]);

  const ok = await srv.request("tools/call", {
    name: "ptc_run_code",
    arguments: {
      code: 'const t = await tools.read({ path: "a.txt" }); return "LEN=" + t.length;',
      description: "probe read",
      workdir: dir,
    },
  });
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, new RegExp(`LEN=${"kimi-mcp-fixture".length}`));

  const jail = await srv.request("tools/call", {
    name: "ptc_run_code",
    arguments: {
      code: 'await tools.read({ path: "/etc/passwd" }); return "unreachable";',
      description: "probe jail",
      workdir: dir,
    },
  });
  assert.equal(jail.isError, true);
  assert.match(jail.content[0].text, /escapes workdir/);

  const unknown = await srv.request("tools/call", {
    name: "nope",
    arguments: {},
  });
  assert.equal(unknown.isError, true);
});
