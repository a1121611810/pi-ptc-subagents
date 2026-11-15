// 真机探针：OCR「没识别出正文」这个形态在真宿主上的表现。
//   腿 A · pi 真子代理：真 pi + 真模型 + 真派发链 + 真产品代码（只把官方端点换成本地假响应）
//   腿 B · Kimi 真 MCP：真 bundle + 真 JSON-RPC + 真产品代码（同一份假响应）
//
// 用法：node scripts/ocr-smoke.mjs   （可选 SMOKE_MODEL=<provider/id> 换模型）
// 断言不靠模型配合：判定读**工具结果原文**（模型怎么转述都不进断言）。
// 缺依赖显式失败，不许 skip（仓规）：没有真 pi / 没有 release/kimi 装配产物 ⇒ 直接红。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerFailureFromText } from "./provider-error.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(REPO, "packages/entry/dist/index.js");
const SHIM = join(REPO, "scripts/lib/fake-official-fetch.mjs");
const KIMI_SERVER = join(REPO, "release/kimi/server.js");
const MODEL = process.env.SMOKE_MODEL || "magpie/deepseek/deepseek-flash";
const NOTICE = "没识别出正文";

// 1×1 PNG（没有文本层）：模型自己读不出内容 ⇒ 才会去调 OCR
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** shim 的注入环境 */
const shimEnv = (countFile) => ({
  NODE_OPTIONS: `--import ${pathToFileURL(SHIM).href}`,
  OCR_FAKE_COUNT_FILE: countFile,
  OCR_FAKE_LOAD_FILE: `${countFile}.loads`,
});

/**
 * pi 包装器：让**每一次** pi 调用都显式带上 shim。
 * 为什么不能只靠 NODE_OPTIONS：pi 是 bun 软链，它启动时把 NODE_OPTIONS 从 process.env 里删掉
 * （预载模块本身已生效，所以父进程能加载）⇒ 引擎派生的孩子进程拿不到 shim，真官方被真打了。
 * 包装器放在 PATH 最前 ⇒ 父会话与孩子都先落到包装器，再 exec 真 pi。
 */
function piWrapperDir() {
  const realPi = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "ocr-smoke-bin-"));
  const wrapper = join(dir, "pi");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nNODE_OPTIONS=${JSON.stringify(`--import ${pathToFileURL(SHIM).href}`)} exec ${JSON.stringify(realPi)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return dir;
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 非 JSON 行不是事件
    }
  }
  return events;
}

/** 工具结果的载体里有没有这句（FG7：只看工具结果，不看模型散文） */
function toolResultHas(events, needle) {
  for (const event of events) {
    const carrier =
      String(event.type ?? "").includes("tool") ||
      String(event.message?.role ?? "").includes("tool");
    if (!carrier) continue;
    if (JSON.stringify(event).includes(needle)) return true;
  }
  return false;
}

/** 假官方命中次数（FG8：证明真的走了 shim 这条路，不是别的路径蒙对了） */
function fakeHits(countFile) {
  if (!existsSync(countFile)) return 0;
  return readFileSync(countFile, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
}

/** 腿 A · pi 真子代理腿 */
function legPi() {
  assert.ok(existsSync(EXT), `缺扩展产物 ${EXT}——先 pnpm run build`);
  const agentDir = mkdtempSync(join(tmpdir(), "ocr-smoke-agent-"));
  // 凭据 + 模型目录都要拷：magpie 这类自定义 provider 的定义在 models.json 里
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    const from = join(homedir(), ".pi", "agent", name);
    if (existsSync(from)) cpSync(from, join(agentDir, name));
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }));
  // OCR 开关只在这个隔离目录里开（用户真实配置一个字都不动）
  writeFileSync(join(agentDir, "ptc.json"), JSON.stringify({ webDsOcr: true }));

  const workspace = mkdtempSync(join(tmpdir(), "ocr-smoke-ws-"));
  const image = join(workspace, "scan.png");
  writeFileSync(image, PNG_1PX);
  const countFile = join(workspace, "fake-official-hits.txt");
  // realpath：macOS 的 /var 是 /private/var 的软链 ⇒ 字面路径会被 OCR 核的 jail 拒（白跑一次）
  const imagePath = realpathSync(image);

  const task = `用 doc_ds_ocr 工具识别图片 ${imagePath}，并把工具返回的原文原样贴出来`;
  const prompt =
    "调用 ptc_run_code，程序体为：const r = await tools.pi_task_ptc({ task: " +
    JSON.stringify(task) +
    ", wait: true }); return r.status; 程序体里不要传 model 参数。";

  const binDir = piWrapperDir();
  const stdout = execFileSync(
    "pi",
    ["-ne", "-e", EXT, "-p", "--mode", "json", "--model", MODEL, prompt],
    {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ...shimEnv(countFile),
      },
    },
  );

  // ⚠ assert.ok 的消息是 eager 求值 ⇒ providerError 为 null 时不能直接 .slice
  const providerError = providerFailureFromText(stdout);
  assert.ok(
    !providerError,
    `provider 不可用，本轮没测到（先解决这个再重跑）：\n  ${providerError?.slice(0, 600) ?? "(未识别)"}`,
  );

  const events = parseEvents(stdout);
  const programs = events
    .filter((event) => event.type === "tool_execution_start" && event.toolName === "ptc_run_code")
    .map((event) => String(event.args?.code ?? ""));
  assert.ok(
    programs.some((code) => code.includes("pi_task_ptc")),
    "父没有派发孩子（程序体里找不到 pi_task_ptc）",
  );

  // 孩子的事件流：<workspace>/.pi/ptc-tasks/tasks/<id>/output.log
  const tasksDir = join(workspace, ".pi", "ptc-tasks", "tasks");
  assert.ok(existsSync(tasksDir), "没有孩子的任务记录（任务目录不存在）");
  const logs = readdirSync(tasksDir)
    .map((id) => join(tasksDir, id, "output.log"))
    .filter((file) => existsSync(file));
  assert.ok(logs.length > 0, "没有读到孩子的 output.log（任务记录/产出目录为空）");

  const hits = fakeHits(countFile);
  // 命中数先查：它是上游事实。命中 0 有三个可能（shim 没生效 / 模型没调工具 / 子代理门禁没开），
  // 只有第一个才是「真官方被打到」——别把另外两个也写成同一个原因。
  assert.ok(
    hits >= 1,
    `假官方一次都没被命中——这条腿没走到 OCR 请求（判据失效）。三种可能：shim 没生效（只有这种才会真打到官方）/ 模型没调 doc_ds_ocr / 子代理的 webDsOcr 门禁没开。孩子的 output.log：${logs.join(", ")}`,
  );
  const hit = logs.filter((file) => toolResultHas(parseEvents(readFileSync(file, "utf8")), NOTICE));
  assert.ok(
    hit.length > 0,
    `孩子的工具结果里没有「${NOTICE}」——官方确实被请求到了（假官方命中 ${hits} 次），但工具结果里没有这句`,
  );
  console.log(`✓ pi 腿：真子代理的工具结果里含「${NOTICE}」，假官方被命中 ${hits} 次`);
}

/** 腿 B · Kimi 真 MCP 腿 */
async function legKimi() {
  assert.ok(existsSync(KIMI_SERVER), `缺装配产物 ${KIMI_SERVER}——先 pnpm run build:kimi`);
  const workdir = mkdtempSync(join(tmpdir(), "ocr-smoke-kimi-"));
  writeFileSync(join(workdir, "scan.png"), PNG_1PX);
  const countFile = join(workdir, "fake-official-hits.txt");
  const home = mkdtempSync(join(tmpdir(), "ocr-smoke-kimi-home-"));

  const child = spawn(process.execPath, [KIMI_SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, KIMI_CODE_HOME: home, ...shimEnv(countFile) },
  });
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
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`timeout ${method}; stderr=${stderr.join("").slice(0, 300)}`)),
        60_000,
      );
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject,
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ocr-smoke", version: "0" },
    });
    assert.equal(init.serverInfo.name, "ptc-tools");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const tools = await request("tools/list");
    assert.ok(
      tools.tools.some((tool) => tool.name === "doc_ds_ocr"),
      "Kimi 面工具表里没有 doc_ds_ocr",
    );

    const call = () =>
      request("tools/call", { name: "doc_ds_ocr", arguments: { path: "scan.png", workdir } });
    const first = await call();
    assert.notEqual(
      first.isError,
      true,
      `Kimi 面 doc_ds_ocr 报错：${JSON.stringify(first).slice(0, 300)}`,
    );
    assert.ok(
      String(first.content?.[0]?.text ?? "").includes(NOTICE),
      `Kimi 面返回里没有「${NOTICE}」：${JSON.stringify(first).slice(0, 300)}`,
    );
    // 第二次必须**重新请求官方**（没识别出正文 ⇒ 不入记忆 ⇒ 不是记忆命中）
    const second = await call();
    assert.ok(
      String(second.content?.[0]?.text ?? "").includes(NOTICE),
      "Kimi 面第二次返回里没有告知语",
    );
    const hits = fakeHits(countFile);
    assert.equal(hits, 2, `Kimi 面第二次不该命中记忆（该再打一次官方）——假官方命中 ${hits} 次`);
    console.log(
      `✓ Kimi 腿：真 MCP 返回里含「${NOTICE}」，第二次仍重新请求官方（假官方命中 ${hits} 次）`,
    );
  } finally {
    child.kill();
  }
}

const piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
console.log(`pi 版本：${piVersion}　模型：${MODEL}　假官方 shim：${SHIM}`);
legPi();
await legKimi();
console.log(
  `\n[ocr-smoke PASS] pi ${piVersion}：pi 真子代理与 Kimi 真 MCP 都拿到「${NOTICE}」，且没识别出正文的结果没进记忆。`,
);
