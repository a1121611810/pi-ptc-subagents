// 真机探针：本轮两个新旋钮（timeoutMs / projectContext）+ 报告与 usage 兜底，逐条在真 pi 上验
//
// 用法：把目标 pi 的 bin 目录放到 PATH 最前面，再跑：
//   PATH=/tmp/floor086b/node_modules/.bin:$PATH node scripts/knobs-smoke.mjs
// 断言用 node:assert，任一条不过即非零退出（可当门禁用）。
//
// 为什么不用模型配合做断言：旋钮是引擎/argv 层的，断言必须由宿主自己看，
// 不能靠「模型恰好传了这个参数」——那是 bench 的活（见 bench/ab/README.md）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskEngine,
  TaskRegistry,
  InMemoryOutputStorage,
  buildPiArgv,
} from "../packages/dispatch/dist/index.js";

const MODEL = process.env.PI_SMOKE_MODEL ?? "minimax-cn/MiniMax-M3.1-Flash";
const piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();

// 任务按真实用法写：父面点名 child report 的 JSON 块形状（实测：只写交付物格式时
// 老版本的孩子更可能不交报告——父面不点名形状，报告通道就是 none）
const CHILD_TASK =
  "只回答 OK，并在最后附上 child report 的 JSON 块（summary / findings / files_touched / usage）。";

// 隔离 agent 目录：只带凭据 + 空扩展。用户的全局 settings 里装着旧版 npm:pi-ptc-subagents，
// 不隔离就会与本仓扩展同名互踩（registerTool 是 Map.set，后注册者覆盖）。
const agentDir = mkdtempSync(join(tmpdir(), "knobs-smoke-agent-"));
const auth = join(homedir(), ".pi/agent/auth.json");
if (existsSync(auth)) cpSync(auth, join(agentDir, "auth.json"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }));
process.env.PI_CODING_AGENT_DIR = agentDir;

// 工作区带一份项目上下文文件：中性内容 + 一条**项目口径**（口径只在这里，材料里不写）
const workspace = mkdtempSync(join(tmpdir(), "knobs-smoke-ws-"));
writeFileSync(
  join(workspace, "AGENTS.md"),
  [
    "# orders-api",
    "",
    "> 样例项目说明（中性内容 + 一条项目口径；不涉及派发/工具）",
    "",
    "## 目录结构",
    "",
    "- `src/` —— 业务代码，按领域分子目录（`orders/`、`pricing/`、`inventory/`）",
    "- `tests/` —— 测试目录，单测与集成测试分开放在 `unit/` 和 `integration/`",
    "- `docs/` —— 说明文档，面向使用者的说明放这里",
    "- `scripts/` —— 一次性运维脚本，不进主流程",
    "",
    "## 编码规矩",
    "",
    "- 所有对外函数返回类型必须显式写出，不许依赖推断。",
    "- 金额一律用整数分存储，展示层再换算；禁止浮点直接参与金额比较。",
    "- 库存扣减走同一条写路径，不允许旁路直接改字段。",
    "- 新增依赖要在 PR 描述里写清用途与替代方案。",
    "- 日志用结构化输出，不许拼接裸字符串。",
    "",
    "## 口径（本项目统一，档案里不重复写）",
    "",
    "- **加班费 = 基础时薪 × 1.2**（本项目自定义倍率，**不按法定倍数**）。档案里的「加班费 N 元/小时」是**基础时薪**，不是实付单价。",
    "",
    "## 测试",
    "",
    "- 每个修 bug 的 PR 至少补一条能复现原问题的用例。",
    "",
  ].join("\n"),
);
// 一份材料：口径题（档案里只有基础时薪，没有 1.5 倍那条）
mkdirSync(join(workspace, "materials"), { recursive: true });
writeFileSync(
  join(workspace, "materials/team.md"),
  [
    "# 班组档案：TEAM-C",
    "",
    "- 班组人数：12 人",
    "- 人均日薪：240 元（按实际出勤人数计薪）",
    "- 每日加班时长：2 小时（加班费 30 元/小时，按实际出勤人数计）",
    "- 出勤情况：当日缺勤 1 人（缺勤者不计薪、不计加班费，也不计加班时长）",
    "",
    "## 待求指标",
    "",
    "1. 实际出勤人数（人）",
    "2. 每日人力成本（元）＝ 日薪合计 + 加班费合计",
    "3. 人均日成本（元）＝ 每日人力成本 ÷ 实际出勤人数",
    "",
  ].join("\n"),
);
process.chdir(workspace);

const registry = new TaskRegistry();
const output = new InMemoryOutputStorage();
const engine = new TaskEngine({
  registry,
  output,
  // 与 entry 同形：把宿主 pi 版本喂进去（--no-mcp 1.1.0 起才有，按版本门控）
  buildArgv: (input, context) => buildPiArgv(input, { ...context, piVersion }),
});

/** 孩子的原始 stdout（事件流）——产出正文与节表都要从这里读：
 *  DispatchResult.text 是「模型可见的正文」，解析不出正文时会回退成整份 stdout */
async function rawStdout(run) {
  return (await output.read(run.taskId)) ?? "";
}

/** 孩子 stdout 里的 system 消息节表（谁在背什么） */
function sectionsOf(stdout) {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "message_end" && event.message?.role === "system") {
      return event.message.sections ?? {};
    }
  }
  return {};
}

/** 孩子最后一条 assistant 正文（不看原始 stdout：它含 prompt 与事件流，不是产出） */
function assistantTextOf(stdout) {
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const parts = Array.isArray(event.message.content) ? event.message.content : [];
    text = parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return text;
}

/** 从孩子正文里取一条事实（F3-2 = 3300 这种） */
function factOf(stdout, id) {
  const match = new RegExp(`${id}\\s*=\\s*(-?[\\d.]+)`).exec(assistantTextOf(stdout));
  return match ? Number(match[1]) : null;
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`✓ ${name}`);
    })
    .catch((error) => {
      results.push(`✗ ${name}：${error.message}`);
      throw error;
    });
}

console.log(`pi 版本：${piVersion}　工作区：${workspace}`);

// ① timeoutMs：给了就计时收尸——真机真子进程被杀，不等它自己跑完
await check("timeoutMs 计时收尸（真子进程被杀）", async () => {
  const started = Date.now();
  const r = await engine.dispatch({
    task: "用 bash 执行 sleep 45，然后只回答 done",
    wait: true,
    timeoutMs: 2000,
    model: MODEL,
  });
  const elapsed = Date.now() - started;
  assert.equal(r.status, "canceled", `期望 canceled，实际 ${r.status}`);
  assert.match(r.errorMessage ?? "", /timeout after 2000ms/, "stopReason 要写明超时");
  assert.ok(elapsed < 30_000, `超时后不该等孩子自己跑完，实际 ${elapsed}ms`);
  assert.ok(!assistantTextOf(await rawStdout(r)).includes("done"), "孩子不该交出答案（真被掐掉）");
  assert.equal(registry.get(r.taskId).status, "canceled");
});

// ② projectContext 默认（auto）：孩子照常背 AGENTS.md
let autoRun;
await check("projectContext 默认 auto → 孩子背项目上下文", async () => {
  autoRun = await engine.dispatch({ task: CHILD_TASK, wait: true, model: MODEL });
  assert.equal(autoRun.status, "fulfilled");
  const sections = sectionsOf(await rawStdout(autoRun));
  assert.ok(
    Object.prototype.hasOwnProperty.call(sections, "project_context"),
    "默认应带 project_context 节",
  );
});

// ③ projectContext=none：孩子不背 AGENTS.md（引擎层 A/B，干净对照）
let noneRun;
await check("projectContext=none → 孩子不背项目上下文", async () => {
  noneRun = await engine.dispatch({
    task: CHILD_TASK,
    wait: true,
    projectContext: "none",
    model: MODEL,
  });
  assert.equal(noneRun.status, "fulfilled");
  const sections = sectionsOf(await rawStdout(noneRun));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(sections, "project_context"),
    "none 时不应有 project_context 节",
  );
});

// ④ 报告通道 + usage 兜底：孩子交报告、usage 是宿主观测值（不是孩子自报的 0）
await check("报告通道 + usage 兜底（观测值非零）", async () => {
  for (const [label, run] of [
    ["auto", autoRun],
    ["none", noneRun],
  ]) {
    assert.ok(
      run.reportChannel === "prompt-json" || run.reportChannel === "tool",
      `${label}：报告通道应为 prompt-json/tool，实际 ${run.reportChannel}`,
    );
    assert.equal(typeof run.report?.summary, "string", `${label}：报告 summary 应是字符串`);
    assert.ok(
      (run.report?.usage?.input ?? 0) > 0,
      `${label}：usage.input 应是宿主观测值，实际 ${run.report?.usage?.input}`,
    );
  }
});

// ⑤ 口径事实：带上下文必按项目口径算；不带上下文时——孩子仍可能自己读到那个文件
// （旋钮去掉的是「注入」，不是「知识」：AGENTS.md 还在 cwd 里，孩子有 read 就能找到）
await check("口径事实：带上下文按项目口径算（none 臂的结果一并记录）", async () => {
  const costTask =
    "读 materials/team.md，按档案的「待求指标」算出 3 条数值事实，" +
    "最终消息里按 F3-1 = <数值> / F3-2 = <数值> / F3-3 = <数值> 三行给出数值本身。";
  const withCtx = await engine.dispatch({ task: costTask, wait: true, model: MODEL });
  const withoutCtx = await engine.dispatch({
    task: costTask,
    wait: true,
    projectContext: "none",
    model: MODEL,
  });
  const withValue = factOf(await rawStdout(withCtx), "F3-2");
  const withoutValue = factOf(await rawStdout(withoutCtx), "F3-2");
  // 带上下文 → 按项目口径（30 是基础时薪，×1.2 = 36）→ 人力成本 2640+792 = 3432
  assert.equal(withValue, 3432, `带上下文应按口径算，实际 ${withValue}`);
  assert.notEqual(withoutValue, null, "无上下文的孩子也得给出数值");
  console.log(
    `  口径事实 F3-2：带上下文=${withValue}　不带上下文=${withoutValue}` +
      (withoutValue === 3432
        ? "（孩子自己读了 AGENTS.md → 旋钮省 token，不隔离知识）"
        : "（孩子没找到口径 → 关掉确实丢了知识）"),
  );
});

// 尺寸口径：usage.input 受缓存冷热影响（缓存命中时几乎为 0，跨版本不可横比），
// 确定的量是孩子系统提示词的节总长——那正是 project_context 节占掉的份。
function sysChars(sections) {
  return Object.values(sections).reduce((sum, value) => sum + String(value ?? "").length, 0);
}

const autoSections = sectionsOf(await rawStdout(autoRun));
const noneSections = sectionsOf(await rawStdout(noneRun));
console.log(
  `孩子系统提示词：auto=${sysChars(autoSections)} 字符　none=${sysChars(noneSections)} 字符` +
    `　（省 ${sysChars(autoSections) - sysChars(noneSections)}）`,
);
console.log(
  `每子 usage：auto input=${autoRun?.report?.usage?.input} cacheRead=${autoRun?.report?.usage?.cacheRead}` +
    `　none input=${noneRun?.report?.usage?.input} cacheRead=${noneRun?.report?.usage?.cacheRead}`,
);

for (const line of results) console.log(line);
console.log(`\n[knobs-smoke PASS] pi ${piVersion}：两个旋钮 + 报告/usage 兜底在真机上全部成立。`);
