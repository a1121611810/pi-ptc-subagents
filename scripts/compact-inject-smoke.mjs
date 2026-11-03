#!/usr/bin/env node
// 压缩后重注入的真机探针（scripts/ 族，与 knobs-smoke 同形）：断言不靠模型配合——
// 压缩由 rpc 的 compact 命令在 agent 空闲时触发，注入由第二个扩展读请求上下文验。
//
// 四个踩过的坑（都在这文件里绕开了）：
// 1) rpc 命令走 **stdin**，写 stdout 等于没发（pi 收不到 ⇒ 会话是空的 ⇒
//    压缩报 "Nothing to compact (session too small)"，看起来像 floor 的锅）。
// 2) 压缩要在 **agent 空闲时**触发：在飞轮次里调 compact 会 abort 在飞轮次，
//    0.86 上 prepareCompaction 拿到的 branch 为空 ⇒ 同样报 "Nothing to compact"。
// 3) floor 0.86 读 **models.json** 拿 provider 配置（1.4.0 读 models-store.json 就够）；
//    隔离目录里缺 models.json ⇒ 模型名解析不出来 ⇒ prompt 静默不跑。
// 4) 会话要比 **keepRecentTokens** 大，否则没东西可摘要 ⇒ 同样报 "Nothing to compact"；
//    默认阈值 20000 token，所以本脚本自建隔离配置目录并把阈值压到 1000。
//
// 用法：node scripts/compact-inject-smoke.mjs <pi-bin 所在目录> [entry/dist/index.js] [model]
// 例：  node scripts/compact-inject-smoke.mjs /tmp/pi086/node_modules/.bin
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..");
const binDir = process.argv[2] ?? join(REPO_ROOT, "node_modules", ".bin");
const entry = process.argv[3] ?? join(REPO_ROOT, "packages", "entry", "dist", "index.js");
const model = process.argv[4] ?? "minimax-cn/MiniMax-M3.1-Flash";

// 第二个扩展：读模型的请求上下文，看任务面清单在不在
const PROBE_EXT = `
export default function (pi) {
  pi.on("context", (event) => {
    const texts = (event.messages ?? [])
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\\n")
          : typeof m.content === "string" ? m.content : "",
      )
      .join("\\n");
    const hit = texts.includes("<compacted-tasks>");
    console.error("PROBE context messages=" + (event.messages?.length ?? 0) + " 清单=" + (hit ? "有" : "无"));
    return undefined;
  });
  pi.on("session_compact", (e) => console.error("PROBE session_compact reason=" + e.reason));
  pi.on("session_compact_failed", (e) =>
    console.error("PROBE session_compact_failed reason=" + e.reason + " err=" + (e.errorMessage ?? "无")),
  );
}
`;

const cwd = mkdtempSync(join(tmpdir(), "compact-inject-smoke-"));
const probePath = join(cwd, "probe-ext.mjs");
writeFileSync(probePath, PROBE_EXT);

// 隔离的配置目录（仓库既有惯例：只放凭据 + 该臂 settings）——
// 隔离是为了两件事：① 用户的 settings 里 compaction.keepRecentTokens 默认 20000，
//    会话比它小 ⇒ 压缩没东西可摘要 ⇒ 报 "Nothing to compact (session too small)"；
//    这里把阈值压到 1000，让小会话也能压。② 不加载用户全局的扩展与包（-ne 已关，
//    但配置目录仍隔离更干净）。
// floor 0.86 读 models.json 拿 provider 配置，1.4.0 读 models-store.json —— 两个都拷。
const sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agentDir = join(cwd, "agent");
mkdirSync(agentDir, { recursive: true });
for (const name of ["auth.json", "models.json", "models-store.json"]) {
  const from = join(sourceAgentDir, name);
  if (existsSync(from)) copyFileSync(from, join(agentDir, name));
}
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ compaction: { keepRecentTokens: 1000 } }, null, 2),
);

const DISPATCH =
  '调用 ptc_run_code，程序体为：const r = await tools.pi_task_ptc({ task: "只回答 OK", wait: true }); return r.status;';
// ⚠️ 坑 5（2026-11-03）：长 prompt 的措辞决定模型会不会收尾——英文「Count the words in the
// following text」实测会让模型去翻会话记录找词（不停工具调用 ⇒ 迟迟不 settle ⇒ 压缩压根没触发，
// 1.4.0 与 1.5.0 两版同样跑不出正例，看着像版本回归）。中文 + 明说「不要调用任何工具」⇒ 秒回。
const LONG =
  "下面这段文字是同一句话重复 320 次。只回复重复次数这一个数字，不要调用任何工具，不要读文件：\n\n" +
  "The printing press was invented in the fifteenth century by Johannes Gutenberg. ".repeat(320);

const proc = spawn("pi", ["-ne", "-e", entry, "-e", probePath, "--mode", "rpc", "--model", model], {
  cwd,
  env: {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrText = "";
proc.stderr.on("data", (d) => {
  stderrText += String(d);
});

// 坑 1：命令走 stdin
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");

let settled = 0;
let compacted = false;
let asked = false;
const steps = [];

proc.stdout.on("data", (d) => {
  for (const line of String(d).split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "agent_settled") {
      settled += 1;
      steps.push(`settled#${settled}`);
      if (settled === 1) {
        send({ type: "prompt", message: LONG });
      } else if (settled === 2) {
        // 坑 2：agent 空闲时才压
        send({ type: "compact" });
      }
    }
    if (msg.type === "compaction_end") {
      steps.push(
        `compaction_end(${msg.reason}${msg.errorMessage ? ` err=${msg.errorMessage}` : ""})`,
      );
      if (msg.reason === "manual" && !msg.errorMessage) compacted = true;
      if (!asked) {
        asked = true;
        send({ type: "prompt", message: "reply with the single word OK" });
      }
    }
  }
});

setTimeout(() => send({ type: "prompt", message: DISPATCH }), 1500);

setTimeout(() => {
  proc.kill("SIGKILL");
  const injected = /清单=有/.test(stderrText);
  const compactEvent = /PROBE session_compact /.test(stderrText);
  const failed = /session_compact_failed/.test(stderrText);
  console.log("=== 步骤 ===");
  console.log(steps.join(" → "));
  console.log("=== 探针 stderr（末 12 行）===");
  console.log(stderrText.split("\n").slice(-12).join("\n"));
  console.log("=== 结论 ===");
  console.log(
    `压缩成功=${compacted ? "是" : "否"}  压缩事件=${compactEvent ? "有" : "无"}  清单注入=${injected ? "有" : "无"}`,
  );
  if (!compacted || !compactEvent || !injected) {
    console.log(`失败细节：failed=${failed ? "有" : "无"} settled=${settled} asked=${asked}`);
    process.exit(1);
  }
  process.exit(0);
}, 200000);
