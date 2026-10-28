// Kimi 面多样性压测（手工跑，非门禁）：正确性矩阵 + 速度 + 消耗 + 占用 + 兼容性
// 用法：node scripts/kimi-bench.mjs（先 pnpm run build:kimi）。正确性断言硬失败；性能只报数。
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../release/kimi/server.js");
const FIX = mkdtempSync(join(tmpdir(), "ptc-bench-"));
const results = [];
const ok = (name) => results.push(["✓", name]);
const section = (t) => console.log(`\n== ${t} ==`);

// ---- fixture ----
mkdirSync(join(FIX, "src", "deep"), { recursive: true });
const FILE_N = 120;
for (let i = 0; i < FILE_N; i++) {
  writeFileSync(
    join(FIX, "src", `f${String(i).padStart(3, "0")}.txt`),
    `line-a-${i}\nline-b kimi-${i}\n`,
  );
}
writeFileSync(join(FIX, "src", "中文 文件.txt"), "中文内容 kimi\n");
writeFileSync(join(FIX, "src", "big.bin"), Buffer.alloc(3 * 1024 * 1024, 97));
mkdirSync(join(FIX, "src", "tree"), { recursive: true });
for (let i = 0; i < 400; i++) {
  mkdirSync(join(FIX, "src", "tree", `d${i % 20}`), { recursive: true });
  writeFileSync(
    join(FIX, "src", "tree", `d${i % 20}`, `t${i}.md`),
    `# doc ${i}\nkimi token ${i}\n`,
  );
}
writeFileSync(join(FIX, "edit.txt"), "M0\n");
writeFileSync(join(FIX, "multi.txt"), "dup dup\n");
symlinkSync(".", join(FIX, "src", "loop")); // 符号链接循环：walk 不许跟进（isDirectory 对链接为 false）

// ---- MCP client ----
function startServer(nodeBin = process.execPath) {
  const child = spawn(nodeBin, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  child.stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error(`stdout 混入非 JSON（协议污染）: ${line.slice(0, 120)}`);
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => (pending.delete(id), reject(new Error(`timeout ${method}`))),
        120_000,
      );
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (m, p) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
  return { child, request, notify, stderr };
}

const srv = startServer();
const cleanup = () => srv.child.kill();
process.on("exit", cleanup);

async function call(code, extra = {}) {
  const r = await srv.request("tools/call", {
    name: "ptc_run_code",
    arguments: { code, description: "bench", workdir: FIX, ...extra },
  });
  return r;
}
async function expectError(name, code, re, extra = {}) {
  let isError;
  let text;
  try {
    const r = await call(code, extra);
    isError = r.isError === true;
    text = r.content?.[0]?.text ?? "";
  } catch (e) {
    // 参数校验在 handler 内抛出时走 JSON-RPC error（-32603）而不是 isError 结果——两者都算拒绝
    isError = true;
    text = e instanceof Error ? e.message : String(e);
  }
  if (!isError || !re.test(text)) {
    throw new Error(
      `${name}: 期望拒绝 + ${re}，实得 isError=${isError} text=${text.slice(0, 140)}`,
    );
  }
  ok(name);
}

// ---- 协议握手 ----
section("协议握手与面清洁");
const t0 = performance.now();
const init = await srv.request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "bench", version: "0" },
});
const tInit = performance.now() - t0;
if (init.serverInfo.name !== "pi-ptc") throw new Error("serverInfo.name");
srv.notify("notifications/initialized");
const t1 = performance.now();
const tools = await srv.request("tools/list");
const tList = performance.now() - t1;
if (tools.tools[0].name !== "ptc_run_code") throw new Error("tools/list");
console.log(`initialize ${tInit.toFixed(0)}ms · tools/list ${tList.toFixed(0)}ms`);
ok("握手 + tools/list");

// ---- 正确性矩阵 ----
section("正确性矩阵");
{
  const r = await call("return await tools.nope({});");
  const text = r.content[0].text;
  if (r.isError !== true || !/is not a function|unknown binding/.test(text)) {
    throw new Error(`未知绑定断言失败: isError=${r.isError} text=${text.slice(0, 140)}`);
  }
  ok("未知绑定 → 程序侧 TypeError（is not a function）");
}
await expectError("语法错误", "const = 1;", /Unexpected token|SyntaxError/);
await expectError("缺 workdir", "return 1;", /workdir/, { workdir: undefined });
await expectError("workdir 不存在", "return 1;", /workdir 不存在/, { workdir: "/nope-xyz" });
await expectError("timeoutMs 类型错", "return 1;", /timeoutMs/, { timeoutMs: "abc" });
await expectError(
  "read 越界",
  'await tools.read({ path: "/etc/passwd" }); return 1;',
  /escapes workdir/,
);
await expectError(
  "edit 越界",
  'await tools.edit({ path: "/etc/hostname", old_string: "x", new_string: "y" }); return 1;',
  /escapes workdir/,
);
await expectError(
  "read 大文件拒",
  'await tools.read({ path: "src/big.bin" }); return 1;',
  /too large/,
);
await expectError("read 目录拒", 'await tools.read({ path: "src" }); return 1;', /not a file/);
await expectError(
  "edit 多匹配拒",
  'await tools.edit({ path: "multi.txt", old_string: "dup", new_string: "x" }); return 1;',
  /must be unique/,
);
await expectError("无限循环超时取消", "while (true) {}", /timeout/, { timeoutMs: 2000 });
{
  const r = await call('const t = await tools.read({ path: "src/中文 文件.txt" }); return t;');
  if (r.isError || !r.content[0].text.includes("中文内容")) throw new Error("中文+空格文件名");
  ok("中文+空格文件名 read");
}
{
  const r = await call('return (await tools.grep({ pattern: "不存在词xyz" })).length;');
  if (r.isError || !r.content[0].text.trim().startsWith("0")) throw new Error("空结果应为 0");
  ok("grep 空结果 = 0（不报错）");
}
{
  const r = await call(
    'try { await tools.read({ path: "/etc/passwd" }); } catch (e) { return "CAUGHT:" + String(e.message || e).slice(0, 30); }',
  );
  if (!/CAUGHT:.*escapes/.test(r.content[0].text))
    throw new Error("程序内 try/catch 应拿到越界错误");
  ok("程序内 try/catch 捕获越界（Kimi 面错误形态）");
}
{
  const r = await call('return "x".repeat(60000);');
  if (!r.content[0].text.includes("已截断")) throw new Error("超大单行值应截断");
  ok("超大值截断（砍头留尾 + 全文指针）");
}
{
  const r = await call('return await tools.glob({ pattern: "src/f*.txt" });');
  if (r.isError || !r.content[0].text.includes("f000.txt")) throw new Error("glob");
  if (srv.stderr.join("").length > 0 && !/ExperimentalWarning/.test(srv.stderr.join(""))) {
    throw new Error("server stderr 有意外输出");
  }
  ok("glob 走真 server（stderr 无意外，ExperimentalWarning 在 stderr 不污染协议）");
}
{
  const race = await Promise.all([
    call("return 1;"),
    call('return (await tools.grep({ pattern: "kimi", path: "src/tree" })).length;'),
    call('return await tools.read({ path: "src/f001.txt" });'),
  ]);
  if (race.some((r) => r.isError)) throw new Error("并发三调用应全部成功");
  ok("并发 3 个 tools/call 同时处理");
}

// ---- 符号链接循环安全 ----
section("符号链接");
{
  const t = performance.now();
  const r = await call('return (await tools.grep({ pattern: "kimi" })).length;');
  const dt = performance.now() - t;
  if (r.isError) throw new Error("符号链接循环下 grep 应正常完成");
  console.log(
    `全 workdir grep（含 loop 链接、520 文件、big.bin 3MB）: ${dt.toFixed(0)}ms, hits=${r.content[0].text.trim()}`,
  );
  ok("符号链接循环不死循环（isDirectory 对链接为 false，天然不跟进）");
}

// ---- 速度 ----
section("速度（中位 of 3）");
async function bench(label, code, extra = {}) {
  const ts = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await call(typeof code === "function" ? code(i) : code, extra);
    ts.push(performance.now() - t);
    if (r.isError) throw new Error(`${label} 出错: ${r.content[0].text.slice(0, 100)}`);
  }
  ts.sort((a, b) => a - b);
  console.log(`${label}: ${ts[1].toFixed(0)}ms`);
  return ts[1];
}
await bench("最小调用（worker 起停全程）", "return 1;");
await bench("read ×1", 'return (await tools.read({ path: "src/f000.txt" })).length;');
await bench(
  "read ×100 串行扇出",
  `let n = 0; for (let i = 0; i < 100; i++) { n += (await tools.read({ path: "src/f" + String(i).padStart(3, "0") + ".txt" })).length; } return n;`,
);
await bench(
  "read ×100 Promise.all 并行",
  `const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => tools.read({ path: "src/f" + String(i).padStart(3, "0") + ".txt" }))); return rs.reduce((a, b) => a + b.length, 0);`,
);
await bench(
  "grep 大树（src/tree 400 文件）",
  'return (await tools.grep({ pattern: "kimi token" })).length;',
);
await bench("edit 单次", (i) =>
  `await tools.edit({ path: "edit.txt", old_string: "M${i}", new_string: "M${i + 1}" }); return 1;`);

// ---- 消耗：上下文经济比 ----
section("消耗");
{
  const totalBytes = Array.from(
    { length: 100 },
    (_, i) => statSync(join(FIX, "src", `f${String(i).padStart(3, "0")}.txt`)).size,
  ).reduce((a, b) => a + b, 0);
  const r = await call(
    `const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => tools.read({ path: "src/f" + String(i).padStart(3, "0") + ".txt" }))); return "READ100_TOTAL=" + rs.reduce((a, b) => a + b.length, 0);`,
  );
  const text = r.content[0].text;
  const resultBytes = Buffer.byteLength(text);
  console.log(
    `100 文件裸读总量 ${totalBytes}B → 程序只回统计值，工具结果 ${resultBytes}B（经济比 1:${(totalBytes / resultBytes).toFixed(0)}）`,
  );
  ok("上下文经济：扇出归约只回摘要");
  const tmpBefore = readdirSync(tmpdir()).filter((f) => f.startsWith("pi-ptc-output-")).length;
  await call(`return "y\\n".repeat(3000);`);
  const tmpAfter = readdirSync(tmpdir()).filter((f) => f.startsWith("pi-ptc-output-")).length;
  console.log(
    `截断临时文件：压测前 ${tmpBefore} 个 → 截断用例后 ${tmpAfter} 个（差 ${tmpAfter - tmpBefore}，无清理策略——只增不减）`,
  );
}
{
  const rss = () =>
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(srv.child.pid)])
        .toString()
        .trim(),
    );
  const before = rss();
  for (let i = 0; i < 30; i++) {
    await call(
      `const r = await tools.grep({ pattern: "kimi", path: "src/tree" }); return r.length;`,
    );
  }
  const after = rss();
  console.log(
    `server RSS：30 连打前 ${(before / 1024).toFixed(1)}MB → 后 ${(after / 1024).toFixed(1)}MB（Δ ${((after - before) / 1024).toFixed(1)}MB）`,
  );
  ok("30 连打稳定性（无泄漏即不报）");
}

// ---- 兼容性 ----
section("兼容性");
console.log(`本机 node ${process.version}（server 实际运行版本）`);
for (const alt of [
  "node22",
  "/opt/homebrew/opt/node@22/bin/node",
  "/usr/local/opt/node@22/bin/node",
]) {
  try {
    const v = execFileSync(alt, ["--version"]).toString().trim();
    const altSrv = startServer(alt);
    const r = await altSrv.request("tools/call", {
      name: "ptc_run_code",
      arguments: { code: "return 1+1;", description: "v", workdir: FIX },
    });
    console.log(
      `node ${v}（${alt}）: call ${r.isError ? "✗ " + r.content[0].text.slice(0, 80) : "✓ = " + r.content[0].text.trim()}`,
    );
    altSrv.child.kill();
    break;
  } catch {
    /* 尝试下一个候选 */
  }
}
{
  const { readdirSync: rd } = await import("node:fs");
  const nvm = join(process.env.HOME ?? "~", ".nvm/versions/node");
  try {
    const vers = rd(nvm).filter((v) => v.startsWith("v22"));
    if (vers.length > 0) {
      const nodeBin = join(nvm, vers[0], "bin/node");
      const altSrv = startServer(nodeBin);
      const r = await altSrv.request("tools/call", {
        name: "ptc_run_code",
        arguments: {
          code: 'return (await tools.grep({ pattern: "kimi", path: "src/tree" })).length;',
          description: "v22",
          workdir: FIX,
        },
      });
      console.log(
        `nvm ${vers[0]}: call ${r.isError ? "✗ " + r.content[0].text.slice(0, 80) : "✓ = " + r.content[0].text.trim()}`,
      );
      altSrv.child.kill();
    } else {
      console.log("无 node 22 在场（nvm 无 v22）——floor 兼容性未实测，只验证过当前版本");
    }
  } catch {
    console.log("无 nvm——floor 兼容性未实测");
  }
}

cleanup();
console.log(`\n压测结论：${results.length} 项通过，0 硬失败。fixture 在 ${FIX}`);
process.exit(0);
