#!/usr/bin/env node
/**
 * pi 台架：无 PTC / pi 自带 codemode / 本仓自研 PTC 的分档对照（可跨 pi 版本）
 *
 * 各臂跑同一个任务（同一份工作区副本、同一模型、同一提示）：
 *   bare     = 无 PTC（-ne，不加载任何扩展）
 *   ptc      = 本仓自研 PTC，且**显式关掉 pi 自带的 codemode**（-builtin:codemode）——
 *               本仓是唯一编排器，surface=full_ptc，不触发退让
 *   codemode = pi 1.4.0 自带 codemode（+builtin:codemode + defaultTools:["+codemode"]）
 *   both     = 两者同场 = pi 的**默认部署形态**（内建扩展默认启用）→ 本仓退让成 codemode_ptc 面
 *
 * 每臂都用**隔离的 PI_CODING_AGENT_DIR**（只拷 auth.json + 该臂的 settings.json）：
 * 用户全局 settings 里同时装着 +builtin:codemode 与 npm:pi-ptc-subagents（旧版发布包），
 * 不隔离就分不清谁在场。
 *
 * 产出三样：
 *   1. 客观判分：把隐藏验收测试拷进工作区跑 pytest（题面写死了 API，判分口径只有一份）
 *   2. 行为指标：轮次 / 工具调用 / token / 用没用 codemode 或 ptc_run_code
 *   3. LLM judge：按 pi 版 checklist 逐条判（判分 prompt 逐字取自 MiniMax-AI/mini-vela 的 evaluate.py）
 *
 * 纪律：**先自检再开跑**——判分器自检跑 `node bench/ab/self-check.mjs`；
 * 每臂工具面用 `--probe` 先验一遍（模型真调通了才算该臂工具可用）。
 *
 * 用法：
 *   node bench/ab/run-ab.mjs --model minimax-cn/MiniMax-M3.1-Flash
 *   node bench/ab/run-ab.mjs --arms bare,codemode,ptc,both --skip-judge
 *   node bench/ab/run-ab.mjs --pi-bin /tmp/pi-0.99.0/node_modules/.bin/pi --arms ptc
 *   node bench/ab/run-ab.mjs --probe --arms bare,codemode,ptc,both
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { buildProfile } from "../../scripts/octobench-pi-checklist.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const ENTRY = join(REPO, "packages/entry/dist/index.js");

// 各臂的宿主配置：settings 写进隔离的 PI_CODING_AGENT_DIR，argv 是额外 CLI 参数
// ⚠️ 内建扩展在 pi 里**默认启用**（package-manager.js:「Built-in extensions are enabled unless
// the user extensions setting excludes them」）——`extensions: []` 挡不住 codemode，
// 要关只能写 `-builtin:codemode`（实测 2026-10-30 验证）。
const ARM_SPECS = {
  // 无 PTC：-ne 关掉所有扩展，pi 默认工具集保留
  bare: { settings: { extensions: [] }, argv: ["-ne"], probeTool: null },
  // pi 自带 codemode：内建扩展显式 +，工具靠 defaultTools 激活
  codemode: {
    settings: { extensions: ["+builtin:codemode"], defaultTools: ["+codemode"] },
    argv: [],
    probeTool: "codemode",
  },
  // 本仓自研 PTC：**关掉 pi 自带的 codemode**（不靠 -ne——那会把别的内建扩展也关掉，
  // 与 codemode 档就不对等了），本仓是唯一编排器 → surface=full_ptc，不触发退让
  ptc: {
    settings: { extensions: ["-builtin:codemode"] },
    argv: ["-e", ENTRY],
    probeTool: "ptc_run_code",
  },
  // 两者同场 = pi 的**默认部署形态**（内建默认启用 + 用户全局 settings 也开着 codemode）
  // → 本仓 entry 探测到 codemode 在活跃表里，退让成 codemode_ptc 面（不注册 PTC 对）
  both: {
    settings: { extensions: ["+builtin:codemode"], defaultTools: ["+codemode"] },
    argv: ["-e", ENTRY],
    probeTool: "codemode",
  },
};

// 工具面自检题：让模型必须用该臂的主工具跑一次——「模型真调通了」才算该臂工具可用。
// 旧的「看 system prompt 的 tools 节」不可靠：扩展工具不一定出现在那一节里。
// ⚠️ 探针题读 README.md，所以探针**固定用 task-repo**（有 README.md），不跟矩阵的 --task 走：
// 宽题的任务仓库没有 README.md，探针题与被测题必须解耦。
const PROBE_TASK = join(REPO, "bench/ab/task-repo");
const PROBE_PROMPTS = {
  bare: "用 bash 命令打印 README.md 的第一行，然后只输出这一行。",
  codemode:
    "必须使用 codemode 工具（写一段 JavaScript 脚本），在脚本里调用 tools.read 读 README.md 的第一行，然后只输出这一行。",
  ptc: "必须使用 ptc_run_code 工具（写一段 TypeScript 程序），在程序里调用 tools.read 读 README.md 的第一行，然后只输出这一行。",
  both: "必须使用 codemode 工具（写一段 JavaScript 脚本），在脚本里调用 tools.read 读 README.md 的第一行，然后只输出这一行。",
};

/* ---------- 题面专属 checklist（SP / Tool schema 取 pi 版公共档，这里只补题面相关的） ---------- */
const TASK_CHECKS = {
  "User query": {
    description:
      "Check whether the assistant actually delivers what the task asked for: a new src/ordercalc/coupons.py with validate_coupon returning CouponResult(valid, reason, discount); five rejection reasons (invalid_format / not_yet_valid / expired / below_min_subtotal / not_stackable) plus unknown_kind; percentage and fixed discount arithmetic; wiring into pricing.calculate_total; pytest cases in tests/; the whole suite green.",
    checks: [
      {
        check_id: "UQ_coupons_module_created",
        check_type: "implementation",
        description:
          "Check whether src/ordercalc/coupons.py exists and defines validate_coupon plus a CouponResult dataclass with valid / reason / discount",
      },
      {
        check_id: "UQ_five_reasons",
        check_type: "implementation",
        description:
          "Check whether all five rejection reasons (invalid_format, not_yet_valid, expired, below_min_subtotal, not_stackable) and unknown_kind are implemented, each with the exact snake_case string the task specified",
      },
      {
        check_id: "UQ_check_order",
        check_type: "implementation",
        description:
          "Check whether the checks are applied in the specified order so that when several conditions fail at once the first one is returned (e.g. an expired coupon that also misses the minimum reports 'expired')",
      },
      {
        check_id: "UQ_discount_arithmetic",
        check_type: "implementation",
        description:
          "Check whether the discount arithmetic matches the spec: percent = round(subtotal * value / 100, 2), fixed = round(min(value, subtotal), 2)",
      },
      {
        check_id: "UQ_pricing_wired",
        check_type: "modification",
        description:
          "Check whether pricing.calculate_total calls the validation and applies the discount when valid, and records the reason while applying no discount when invalid",
      },
      {
        check_id: "UQ_tests_written",
        check_type: "testing",
        description:
          "Check whether the assistant added pytest cases under tests/ using parametrize, asserting concrete reason strings and concrete amounts rather than mere non-null checks",
      },
      {
        check_id: "UQ_tests_run_green",
        check_type: "testing",
        description:
          "Check whether the assistant actually ran the test suite and the whole suite was green, including the pre-existing tests/test_pricing.py cases",
      },
      {
        check_id: "UQ_project_conventions",
        check_type: "compliance",
        description:
          "Check whether the new code follows CLAUDE.md: native type annotations, dataclasses for data shapes, no new third-party dependency, module-level logger for logging",
      },
    ],
  },
};

/* ---------- judge prompt：逐字取自 MiniMax-AI/mini-vela 的 evaluate.py ---------- */
const EVAL_PROMPT = `
你是一个「Agent 指令遵循」评审模型。

你的任务是：根据给定的 **Checklist**，逐项评估 assistant 在对话中的表现。

=====INPUT CONVERSATION=====
====TOOLS===
{tools}
====TOOLS===
====MESSAGES===
{messages}
====MESSAGES===
=====INPUT CONVERSATION=====

=====CHECKLIST TO EVALUATE=====
{checklist}
=====CHECKLIST TO EVALUATE=====

--------------------------------------------------
评估规则
--------------------------------------------------

1. **逐项评估**：对 Checklist 中的每个 check_id，判断 assistant 是否遵循该要求

2. **评估依据**：检查所有 \`role == "assistant"\` 的消息，包括：
   - 自然语言输出（content）
   - 内部推理（reasoning_content，如有）
   - 工具调用（tool_calls）

3. **判定标准**：
   - \`"success"\`：assistant 明确遵循了该要求
   - \`"fail"\`：assistant 明显违背了该要求，或在应该遵循时未遵循

4. **reasoning 字段**：
   - 对于 "fail"：简要说明 assistant 如何违背了该要求（可引用消息索引）
   - 对于 "success"：简要说明 assistant 如何遵循了该要求

--------------------------------------------------
输出格式（必须为合法 JSON）
--------------------------------------------------

输出一个 JSON 对象，结构与输入的 Checklist 相同，但每个 check 增加 "reasoning" 和 "result" 字段：

{
  "CategoryName": {
    "description": "...(保持原样)",
    "checks": [
      {
        "check_id": "xxx",
        "description": "...(保持原样)",
        "check_type": "...(保持原样)",
        "reasoning": "简要说明判定依据",
        "result": "success 或 fail"
      }
    ]
  }
}

--------------------------------------------------
注意事项
--------------------------------------------------

1. 必须对 Checklist 中的**每个** check_id 进行评估，不可遗漏
2. result 只能是 "success" 或 "fail"（小写），不允许其他值
3. 输出必须是合法 JSON，不要在 JSON 外添加任何文字
4. 保持原有的 category 结构和字段

请严格按照 Checklist 进行评估，输出完整的 JSON 结果。
`;

const TOOL_DESCRIPTIONS = {
  read: "Read a file from the local filesystem",
  bash: "Execute a bash command in a persistent shell",
  edit: "Edit a file by replacing an exact string",
  write: "Write a file to the local filesystem",
  grep: "Search file contents with a regular expression",
  find: "Find files by name pattern",
  ls: "List directory contents",
  ptc_run_code: "Run a TypeScript/JavaScript program that batches tool calls",
  ptc_workflow: "Run a phased workflow script",
  ptc_task_list: "List dispatched tasks",
  ptc_task_output: "Read a dispatched task's output",
  ptc_task_stop: "Stop a dispatched task",
};

function parseArgs(argv) {
  const args = {
    model: "minimax-cn/MiniMax-M3.1-Flash",
    judgeModel: "MiniMax-M3.1-Flash",
    task: join(REPO, "bench/ab/task-repo"),
    prompt: join(REPO, "bench/ab/task-prompt.md"),
    grader: join(REPO, "bench/ab/grader"),
    out: join(REPO, "bench/ab/out"),
    arms: "bare,codemode,ptc",
    skipJudge: false,
    judgeOnly: false,
    probe: false,
    piBin: "pi",
    checks: "",
    repeat: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[i + 1];
    const take = () => {
      if (inlineValue === undefined) i += 1;
    };
    switch (key) {
      case "--model":
        args.model = value;
        take();
        break;
      case "--judge-model":
        args.judgeModel = value;
        take();
        break;
      case "--task":
        args.task = value;
        take();
        break;
      case "--prompt":
        args.prompt = value;
        take();
        break;
      case "--grader":
        args.grader = value;
        take();
        break;
      case "--checks":
        args.checks = value;
        take();
        break;
      case "--out":
        args.out = value;
        take();
        break;
      case "--arms":
        args.arms = value;
        take();
        break;
      case "--skip-judge":
        args.skipJudge = true;
        break;
      case "--judge-only":
        args.judgeOnly = true;
        break;
      case "--repeat":
        args.repeat = Number(value);
        take();
        break;
      case "--probe":
        args.probe = true;
        break;
      case "--regrade":
        args.regrade = true;
        break;
      case "--pi-bin":
        args.piBin = value;
        take();
        break;
      default:
        throw new Error(`unknown arg: ${key}`);
    }
  }
  return args;
}

/* ---------- 跑一臂 ---------- */
async function runArm(arm, prompt, args, dir, taskDir = args.task) {
  // 工作区必须在仓库外：pi 向上遍历祖先目录加载 AGENTS.md/CLAUDE.md，也按 package.json 的
  // pi.extensions 发现扩展。工作区放仓内 → 本仓上下文 + 本仓扩展灌进父子会话（实测踩过：
  // 父会话 39 次 AGENTS.md、孩子拿到 ptc_run_code → floor 上无程序内通道 → 跑飞 lost）。
  const workspace = mkdtempSync(join(tmpdir(), `piab-ws-${arm}-`));
  cpSync(taskDir, workspace, { recursive: true });
  if (workspace.startsWith(REPO))
    throw new Error(`工作区落在仓库内（${workspace}）——会被本仓上下文污染`);

  const spec = ARM_SPECS[arm];
  if (!spec) throw new Error(`unknown arm: ${arm}（可用：${Object.keys(ARM_SPECS).join(", ")}）`);

  // 隔离的 agent dir：只带凭据 + 该臂 settings，不读用户全局 settings/packages
  // （用户全局同时装着 +builtin:codemode 与 npm:pi-ptc-subagents 旧版，不隔离就分不清谁在场）
  const agentDir = mkdtempSync(join(tmpdir(), `piab-${arm}-`));
  cpSync(join(homedir(), ".pi/agent/auth.json"), join(agentDir, "auth.json"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(spec.settings, null, 2));

  const argv = [
    "-p",
    prompt,
    "--mode",
    "json",
    "--no-session",
    "--approve",
    "--model",
    args.model,
    ...spec.argv,
  ];

  const started = Date.now();
  // stdin 必须 ignore：pi 在 -p 模式下会等 stdin，管道不关就静默阻塞（实测 0 字节、0 网络连接）
  // PATH 要对齐：派发引擎给孩子拼的 argv 写死 "pi"（走 PATH）——不把被测版本放到 PATH 前面，
  // 跨版本跑时孩子会落到全局 pi（父 0.86.1 + 孩子 1.4.0 的混合态，实测踩过）
  const piDir = dirname(resolve(args.piBin || "pi"));
  const child = spawn(args.piBin || "pi", argv, {
    cwd: workspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PATH: `${piDir}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolvePromise) => {
    let code = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };
    child.on("exit", (c) => {
      code = c;
      // close 可能因孙进程占住 stdout 而永不触发——exit 后给 3 秒收尾窗口
      setTimeout(finish, 3000).unref();
    });
    child.on("close", (c) => {
      code = c;
      finish();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 900000);
    timer.unref();
  });
  const wallMs = Date.now() - started;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), stdout);
  writeFileSync(join(dir, "stderr.txt"), stderr);
  writeFileSync(join(dir, "argv.txt"), argv.join(" "));
  // ⚠️ 工作区归档**不在这里做**：判分输入（父最终输出 final_answer.md、ground truth truth.json、
  // 判分器拷贝）都是客观判分阶段才写进工作区的，提前归档会漏掉它们 → 归档目录根本判不了分。
  // 归档挪到 main 里客观判分之后（见 main）。
  return { workspace, exitCode, wallMs, stdout, stderr };
}

/* ---------- 事件流 → 轨迹 + 指标 ---------- */
function parseTrajectory(raw) {
  const events = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const messages = [];
  const metrics = {
    turns: 0,
    toolCalls: 0,
    toolCallsByName: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    // 成本口径：直接用 pi 上报的 usage.cost（provider 真实 rate card），不自己按 token 定价换算
    costUsd: 0,
    sessionId: "",
    // 程序内派活：pi_task_ptc 是 binding（不产生 tool_execution_start），只能从程序体里数
    programDispatchCalls: 0,
  };

  for (const event of events) {
    switch (event.type) {
      case "session":
        metrics.sessionId = event.id ?? "";
        break;
      case "turn_start":
        metrics.turns += 1;
        break;
      case "message_end": {
        // message_end.message 是权威版本：content 块含 text / toolCall / thinking
        const message = event.message;
        if (!message) break;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        const reasoning = blocks
          .filter((block) => block.type === "thinking")
          .map((block) => block.thinking ?? "")
          .join("");
        const toolCalls = blocks
          .filter((block) => block.type === "toolCall")
          .map((block) => ({ name: block.name, arguments: block.arguments ?? {} }));
        // 程序体里出现 pi_task_ptc = 走 PTC 门派了活（binding 不产生 tool_execution_start）
        for (const call of toolCalls) {
          if (
            call.name === "ptc_run_code" &&
            /pi_task_ptc/.test(String(call.arguments.code ?? ""))
          ) {
            metrics.programDispatchCalls += 1;
          }
        }
        if (message.role === "assistant") {
          metrics.inputTokens += message.usage?.input ?? 0;
          metrics.outputTokens += message.usage?.output ?? 0;
          metrics.cacheReadTokens += message.usage?.cacheRead ?? 0;
          // pi 的 usage.cost 是 provider 口径的真实计价（含 input/output/cacheRead/cacheWrite 分项）
          metrics.costUsd +=
            message.usage?.cost?.total ??
            (typeof message.usage?.cost === "number" ? message.usage.cost : 0);
          messages.push({
            role: "assistant",
            content: text,
            reasoning_content: reasoning || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        } else if (message.role === "user") {
          messages.push({ role: "user", content: text });
        }
        break;
      }
      case "tool_execution_start": {
        metrics.toolCalls += 1;
        const name = event.toolName ?? "unknown";
        metrics.toolCallsByName[name] = (metrics.toolCallsByName[name] ?? 0) + 1;
        break;
      }
      case "tool_execution_end": {
        const result = event.result ?? {};
        const text = Array.isArray(result.content)
          ? result.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : JSON.stringify(result.structuredContent ?? result.content ?? "");
        messages.push({
          role: "tool",
          tool_name: event.toolName ?? "unknown",
          content: String(text).slice(0, 5000),
        });
        break;
      }
      default:
        break;
    }
  }
  return { messages, metrics };
}

/* ---------- 工具面探针：该臂的主工具「模型真调通了」才算可用 ---------- */
async function probeArm(arm, args, dir) {
  const spec = ARM_SPECS[arm];
  if (!spec)
    return { arm, ok: false, reason: `未知臂（可用：${Object.keys(ARM_SPECS).join(",")}）` };
  const run = await runArm(arm, PROBE_PROMPTS[arm], args, dir, PROBE_TASK);
  const { metrics } = parseTrajectory(run.stdout);
  const used = spec.probeTool ? (metrics.toolCallsByName[spec.probeTool] ?? 0) : 0;
  const ok = spec.probeTool ? used > 0 : run.exitCode === 0;
  return {
    arm,
    ok,
    used,
    exitCode: run.exitCode,
    wallMs: run.wallMs,
    toolCallsByName: metrics.toolCallsByName,
    reason: spec.probeTool
      ? used > 0
        ? "可用"
        : `主工具 ${spec.probeTool} 调不通（该 pi 版本很可能没有这个扩展，或 settings 语法不兼容）`
      : run.exitCode === 0
        ? "能跑"
        : `跑不动（exit=${run.exitCode}）`,
  };
}

/* ---------- 派发指标：读工作区里的 registry 记录（客观，不看模型说什么） ---------- */
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function collectDispatch(arm, workspace, metrics) {
  const dir = join(workspace, ".pi/ptc-tasks/records");
  // 父进程退出时孩子可能还在跑——等在飞的落终态（最多 90s），否则读到的记录是半截的
  for (let i = 0; i < 45; i += 1) {
    // 没有记录目录 = 这轮压根没派发（父已退出，不会再有新记录）→ 不用等。
    // ⚠️ 这里以前是 sleep+continue 空转 45 次 = 每轮白等 90 秒（没派发的档全中招）。
    if (!existsSync(dir)) break;
    const inFlight = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .some((f) => {
        try {
          const status = JSON.parse(readFileSync(join(dir, f), "utf8")).status;
          return status === "queued" || status === "running";
        } catch {
          return false;
        }
      });
    if (!inFlight) break;
    await sleep(2000);
  }
  const records = collectDispatchRecords(workspace);
  return {
    ...records,
    // 走哪扇门：codemode 门 = pi_task_codemode 工具调用（宿主记得到）；PTC 门 = 程序体里出现 pi_task_ptc
    codemodeDoorCalls: metrics.toolCallsByName.pi_task_codemode ?? 0,
    ptcDoorCalls: metrics.programDispatchCalls ?? 0,
    // 完整运行树的子代理侧消耗（父侧在 metrics.costUsd）
    childUsage: collectChildUsage(workspace),
  };
}

/* ---------- 子代理消耗：从子会话日志里读真实 usage ----------
 * ⚠️ registry record 里的 report.usage 是**孩子自报**的值，实测恒为 0（自报兜底挡住了
 * 宿主观测值），所以真实用量只能从子会话自己的日志 .pi/ptc-tasks/tasks/<id>/output.log 读。
 * ⚠️ 只认 message_end：pi 的 message_start 也带同一份 usage，两边都算会翻倍
 *    （与父侧 parseTrajectory 口径一致）。
 */
function collectChildUsage(workspace) {
  const dir = join(workspace, ".pi/ptc-tasks/tasks");
  const out = {
    childSessions: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir)) {
    const logPath = join(dir, id, "output.log");
    if (!existsSync(logPath)) continue;
    out.childSessions += 1;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "message_end") continue;
      const message = event.message;
      if (!message || message.role !== "assistant" || !message.usage) continue;
      out.turns += 1;
      out.inputTokens += message.usage.input ?? 0;
      out.outputTokens += message.usage.output ?? 0;
      out.cacheReadTokens += message.usage.cacheRead ?? 0;
      out.costUsd +=
        message.usage.cost?.total ??
        (typeof message.usage.cost === "number" ? message.usage.cost : 0);
    }
  }
  return out;
}

/* ---------- 污染自检：本仓上下文/工具面漏进会话 = 这轮数据不可信 ---------- */
// 实测踩过：工作区在仓库内时，pi 向上遍历祖先目录加载 AGENTS.md，本仓那份通篇讲 PTC 与派发
// 路线 → 灌进父/子会话 → 「模型自发派发」变成被 AGENTS.md 诱导的假象。
// 判据分两类：
//   1) 上下文泄漏：仓库自己的 AGENTS.md 路径/内容进了会话（任何档都是污染）
//   2) 工具面泄漏：本仓 PTC 工具出现在**不该有**的档（bare/codemode 没有本仓扩展；
//      ptc/both 档经 -e 正常加载本仓扩展 → 有本仓工具是预期，不算污染）
// 注意别误报：skill 描述里出现 "AGENTS.md" 字样、以及 ptc 档的 <ptc> 路线册子都是正常的。
const REPO_CONTEXT_MARKERS = [
  "pi-ptc-subagents/AGENTS.md",
  "干净室规则",
  "docs/prototypes/dispatch-doors-flow.html",
];
const REPO_TOOLS = [
  "ptc_run_code",
  "ptc_task_list",
  "ptc_task_output",
  "ptc_task_stop",
  "ptc_workflow",
];
// 本仓扩展在场的档：经 -e 显式加载，工具面里有本仓工具属预期
const ARMS_WITH_REPO_EXTENSION = new Set(["ptc", "both"]);

function detectContamination(arm, stdout) {
  const contextHits = new Set();
  const repoTools = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const marker of REPO_CONTEXT_MARKERS) {
      if (line.includes(marker)) contextHits.add(marker);
    }
    if (event.type === "tool_execution_start") {
      const name = event.toolName ?? event.name;
      if (REPO_TOOLS.includes(name)) repoTools.add(name);
    }
    for (const tool of event.toolsAdded ?? []) {
      if (REPO_TOOLS.includes(tool.name)) repoTools.add(tool.name);
    }
  }
  const expectRepoTools = ARMS_WITH_REPO_EXTENSION.has(arm);
  const toolLeak = expectRepoTools ? [] : [...repoTools];
  const contaminated = contextHits.size > 0 || toolLeak.length > 0;
  return {
    arm,
    contaminated,
    contextMarkers: [...contextHits],
    unexpectedRepoTools: toolLeak,
    repoToolsInSession: [...repoTools],
    expectedRepoTools: expectRepoTools,
  };
}

function collectDispatchRecords(workspace) {
  const dir = join(workspace, ".pi/ptc-tasks/records");
  const out = { count: 0, labels: [], statuses: {}, parallelMax: 0, records: [] };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const spans = [];
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
      out.count += 1;
      out.labels.push(record.label ?? null);
      out.statuses[record.status ?? "unknown"] =
        (out.statuses[record.status ?? "unknown"] ?? 0) + 1;
      if (record.startedAt && record.finishedAt) spans.push([record.startedAt, record.finishedAt]);
      out.records.push({
        label: record.label,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      });
    } catch {
      /* 记录读不动就跳过——不能因为一条坏记录丢掉整轮指标 */
    }
  }
  // 并行度 = 任意时刻同时在跑的子任务最多几个（区间重叠扫一遍）
  const events = [];
  for (const [start, end] of spans) {
    events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  for (const [, delta] of events) {
    live += delta;
    out.parallelMax = Math.max(out.parallelMax, live);
  }
  return out;
}

function buildTools(messages) {
  const names = new Set();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.add(call.name);
  }
  return [...names].map((name) => ({
    type: "function",
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name] ?? `Tool ${name}`,
      parameters: { type: "object", properties: {} },
    },
  }));
}

/* ---------- 客观判分 ---------- */
function objectiveGrade(arm, graderDir, workspace) {
  const result = {
    passed: 0,
    failed: 0,
    errored: 0,
    modelTests: false,
    output: "",
    checker: null,
  };
  if (!existsSync(graderDir)) return result;

  // ground truth：模型**跑完之后**才拷进工作区（判分器要读它，但模型不能提前看见）
  if (existsSync(join(graderDir, "truth.json"))) {
    cpSync(join(graderDir, "truth.json"), join(workspace, "truth.json"));
  }

  // 隐藏 pytest 题：拷进工作区 tests/（先拷后跑）
  const hiddenTests = readdirSync(graderDir).filter(
    (f) => f.startsWith("test_") && f.endsWith(".py"),
  );
  for (const file of hiddenTests) {
    cpSync(join(graderDir, file), join(workspace, "tests", file));
  }

  // 独立检查脚本（宽任务用）：拷到工作区根，单独跑
  const checkers = readdirSync(graderDir).filter(
    (f) => f.startsWith("check_") && f.endsWith(".py"),
  );
  let checker = null;
  for (const file of checkers) {
    cpSync(join(graderDir, file), join(workspace, file));
    const run = spawnSync("uv", ["run", "--quiet", "python", file], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 300000,
    });
    const raw = `${run.stdout ?? ""}`.trim().split("\n").pop() ?? "";
    try {
      checker = JSON.parse(raw);
    } catch {
      checker = {
        passed: 0,
        failed: 0,
        error: 0,
        details: [`checker 输出非 JSON: ${raw.slice(0, 200)}`],
      };
    }
  }
  if (checker) {
    result.passed += checker.passed ?? 0;
    result.failed += checker.failed ?? 0;
    result.errored += checker.error ?? 0;
    result.checker = checker;
  }

  // pytest：现有测试是否还绿 + 隐藏 pytest 题的结果
  // ⚠️ 只在真跑得起来的题上跑：facts 题不是 pytest 项目，硬跑只会得到一堆无意义的
  // error 被计进分母 → 判分虚低。
  const isPytestProject = existsSync(join(workspace, "pyproject.toml"));
  if (hiddenTests.length > 0 || isPytestProject) {
    const pytest = spawnSync(
      "uv",
      // 收集错误不中断整个套件：模型没建 coupons.py 时隐藏题报 error，但现有测试是否还绿仍看得见
      ["run", "--quiet", "pytest", "-q", "--no-header", "--continue-on-collection-errors"],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: 300000,
      },
    );
    const output = `${pytest.stdout ?? ""}\n${pytest.stderr ?? ""}`;
    const pytestPassed = Number(/(\d+) passed/.exec(output)?.[1] ?? 0);
    const pytestFailed = Number(/(\d+) failed/.exec(output)?.[1] ?? 0);
    const pytestError = Number(/(\d+) error/.exec(output)?.[1] ?? 0);
    if (hiddenTests.length > 0) {
      // 隐藏题的成绩已经在 pytest 里，checker 的分不重复计
      result.passed += pytestPassed;
      result.failed += pytestFailed;
      result.errored += pytestError;
    } else {
      result.failed += pytestFailed + pytestError;
      result.pytestPassed = pytestPassed;
    }
    result.output = output.slice(-2500);
  }
  result.modelTests = existsSync(join(workspace, "tests", "test_coupons.py"));
  return result;
}

/* ---------- LLM judge ---------- */
async function callJudge(prompt, args) {
  const key = spawnSync("pi", ["auth", "print-api-key", "--provider", "minimax-cn"], {
    encoding: "utf8",
  }).stdout.trim();
  const baseUrl = "https://api.minimaxi.com/v1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: args.judgeModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 16384,
    }),
  });
  if (!response.ok) throw new Error(`judge HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const choice = payload.choices?.[0]?.message ?? {};
  // MiniMax 的思维链可能落在 reasoning_content，正文也可能为空——两个都试
  return { content: choice.content ?? "", reasoning: choice.reasoning_content ?? "" };
}

function parseJudgeJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```json/, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in judge output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function judge(arm, checklist, messages, args) {
  const tools = buildTools(messages);
  // 按类别拆开问：一次问全部会顶到 max_tokens 被截断，JSON 直接坏掉
  const perCategory = {};
  const failures = [];
  for (const [category, value] of Object.entries(checklist)) {
    const prompt = EVAL_PROMPT.replace("{tools}", JSON.stringify(tools, null, 2))
      .replace("{messages}", JSON.stringify(messages, null, 2))
      .replace("{checklist}", JSON.stringify({ [category]: value }, null, 2));
    try {
      const { content, reasoning } = await callJudge(prompt, args);
      let parsed;
      try {
        parsed = parseJudgeJson(content);
      } catch {
        parsed = parseJudgeJson(reasoning);
      }
      const returned = parsed[category] ?? parsed;
      // 分母必须恒等于 checklist 的项数：judge 少返回几条 check 就分母变小、reward 虚高，档间不可比
      // （实测踩过：窄题 codemode 档只判了 21/28 项，分数看着比别档高）
      const returnedById = new Map((returned?.checks ?? []).map((c) => [c.check_id, c]));
      perCategory[category] = {
        checks: (value?.checks ?? []).map(
          (check) => returnedById.get(check.check_id) ?? { ...check, result: "fail" },
        ),
      };
    } catch (error) {
      failures.push(`${category}: ${String(error).slice(0, 160)}`);
      // 整类判分失败 = 这类全 fail 计入分母，不能静默丢弃
      perCategory[category] = {
        checks: (value?.checks ?? []).map((check) => ({ ...check, result: "fail" })),
      };
    }
  }

  let total = 0;
  let success = 0;
  const byCategory = {};
  for (const [category, data] of Object.entries(perCategory)) {
    const checks = data?.checks ?? [];
    let catSuccess = 0;
    for (const check of checks) {
      total += 1;
      if (check.result === "success") {
        success += 1;
        catSuccess += 1;
      }
    }
    byCategory[category] = { success: catSuccess, total: checks.length };
  }
  return {
    reward: total > 0 ? Number((success / total).toFixed(3)) : 0,
    total,
    success,
    byCategory,
    detail: perCategory,
    failures,
  };
}

/* ---------- 聚合：多轮跑出中位数与区间 ---------- */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function aggregate(armRuns) {
  if (armRuns.length === 0) return { runs: 0 };
  const pick = (fn) => armRuns.map(fn);
  const range = (values) => `${Math.min(...values)}~${Math.max(...values)}`;
  const ptcCalls = pick((r) => r.metrics.toolCallsByName.ptc_run_code ?? 0);
  const codemodeCalls = pick((r) => r.metrics.toolCallsByName.codemode ?? 0);
  // 完整运行树成本 = 父 + 所有子代理（业界口径：coordinator 的账单只是一部分）
  const totalCost = (r) => (r.metrics.costUsd ?? 0) + (r.dispatch?.childUsage?.costUsd ?? 0);
  const judgedRuns = armRuns.filter(
    (r) => r.judged && !r.judged.skipped && r.judged.reward !== undefined,
  );
  return {
    runs: armRuns.length,
    metrics: {
      turns: median(pick((r) => r.metrics.turns)),
      toolCalls: median(pick((r) => r.metrics.toolCalls)),
      outputTokens: median(pick((r) => r.metrics.outputTokens)),
      cacheReadTokens: median(pick((r) => r.metrics.cacheReadTokens)),
      inputTokens: median(pick((r) => r.metrics.inputTokens)),
    },
    ranges: {
      turns: range(pick((r) => r.metrics.turns)),
      toolCalls: range(pick((r) => r.metrics.toolCalls)),
      outputTokens: range(pick((r) => r.metrics.outputTokens)),
      wallSec: range(pick((r) => Math.round(r.wallMs / 1000))),
      totalUsd: range(pick((r) => Number(totalCost(r).toFixed(6)))),
    },
    wallMs: median(pick((r) => r.wallMs)),
    ptcRunCodeCalls: median(ptcCalls),
    ptcRunCodeCallsTotal: ptcCalls.reduce((a, b) => a + b, 0),
    codemodeCalls: median(codemodeCalls),
    codemodeCallsTotal: codemodeCalls.reduce((a, b) => a + b, 0),
    // 成本口径（cost-normalized）：$ 用 pi 上报的 provider 计价，不自己换算定价
    cost: {
      parentUsd: median(pick((r) => r.metrics.costUsd ?? 0)),
      childUsd: median(pick((r) => r.dispatch?.childUsage?.costUsd ?? 0)),
      totalUsd: median(pick((r) => totalCost(r))),
      // 每命中一条要花多少钱（分母 = 客观判分通过数）
      perPassedUsd: median(pick((r) => totalCost(r) / Math.max(r.objective?.passed ?? 0, 1))),
      // 效率 = 准确率 ÷ 每命中成本（越高越好）
      efficiency: median(
        pick((r) => {
          const passed = r.objective?.passed ?? 0;
          const total = passed + (r.objective?.failed ?? 0) + (r.objective?.errored ?? 0);
          if (!total || !passed) return 0;
          const accuracy = passed / total;
          return accuracy / (totalCost(r) / passed);
        }),
      ),
    },
    dispatch: {
      records: pick((r) => r.dispatch?.count ?? 0),
      parallelMax: pick((r) => r.dispatch?.parallelMax ?? 0),
      codemodeDoor: pick((r) => r.dispatch?.codemodeDoorCalls ?? 0),
      ptcDoor: pick((r) => r.dispatch?.ptcDoorCalls ?? 0),
      statuses: armRuns[armRuns.length - 1].dispatch?.statuses ?? {},
      labels: armRuns.flatMap((r) => r.dispatch?.labels ?? []),
      childSessions: pick((r) => r.dispatch?.childUsage?.childSessions ?? 0),
      childTurns: pick((r) => r.dispatch?.childUsage?.turns ?? 0),
    },
    toolCallsByName: armRuns[armRuns.length - 1].toolCallsByName,
    objective: {
      passedMedian: median(pick((r) => r.objective.passed)),
      failedTotal: pick((r) => r.objective.failed).reduce((a, b) => a + b, 0),
      errorTotal: pick((r) => r.objective.errored).reduce((a, b) => a + b, 0),
      allPassed: armRuns.every(
        (r) => r.objective.failed === 0 && r.objective.errored === 0 && r.objective.passed > 0,
      ),
    },
    judged: judgedRuns.length > 0 ? judgedRuns[judgedRuns.length - 1].judged : { skipped: true },
  };
}

/* ---------- 对比表 ---------- */
function printTable(arms, report, args) {
  const rows = arms.map((arm) => {
    const data = report.arms[arm];
    if (!data) return { arm, 状态: "缺数据" };
    if (data.skipped) return { arm, 状态: `跳过：${data.reason}` };
    const cat = data.judged?.byCategory ?? {};
    const row = {
      arm,
      轮次: data.metrics.turns,
      工具调用: data.metrics.toolCalls,
      ptc程序调用: data.ptcRunCodeCalls ?? 0,
      codemode调用: data.codemodeCalls ?? 0,
      输出token: data.metrics.outputTokens,
      缓存读token: data.metrics.cacheReadTokens,
      用时秒: Number((data.wallMs / 1000).toFixed(1)),
      客观判分: `${data.objective.passedMedian} passed`,
      全过: data.objective.allPassed ? "是" : "否",
      成本$: data.cost?.totalUsd?.toFixed(5) ?? "n/a",
      每命中$: data.cost?.perPassedUsd?.toFixed(6) ?? "n/a",
      效率: data.cost?.efficiency?.toFixed(2) ?? "n/a",
      子会话: data.dispatch?.childSessions?.join("/") ?? "0",
      派发子代理: data.dispatch.records.join("/") || "0",
      并行度: data.dispatch.parallelMax.join("/") || "0",
      派发门: `codemode ${data.dispatch.codemodeDoor.join("/")} · ptc ${data.dispatch.ptcDoor.join("/")}`,
      judge分: data.judged?.reward ?? "n/a",
      SP: cat.SP ? `${cat.SP.success}/${cat.SP.total}` : "-",
      工具纪律: cat["Tool schema"]
        ? `${cat["Tool schema"].success}/${cat["Tool schema"].total}`
        : "-",
      任务完成: cat["User query"] ? `${cat["User query"].success}/${cat["User query"].total}` : "-",
    };
    if (data.runs > 1) {
      row.区间 = `轮次 ${data.ranges.turns} / 工具 ${data.ranges.toolCalls} / token ${data.ranges.outputTokens} / 秒 ${data.ranges.wallSec}`;
    }
    return row;
  });
  process.stdout.write(`\n=== A/B 对比（模型 ${args.model}）===\n`);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

/* ---------- 主流程 ---------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = buildProfile("pi");
  const checklist = {
    SP: profile.SP,
    "Tool schema": profile["Tool schema"],
    "System reminder": profile["System reminder"],
    ...TASK_CHECKS,
  };
  // 题面换了，「任务完成」判分项也跟着换（硬套上一题的判据就是噪声）
  if (args.checks) {
    const override = JSON.parse(readFileSync(args.checks, "utf8"));
    Object.assign(checklist, override);
  }

  const arms = args.arms
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reportPath = join(args.out, "report.json");
  let report = { model: args.model, judgeModel: args.judgeModel, arms: {} };

  // --probe：工具面自检——每臂先跑一次「必须用该臂主工具」的题，
  // 判据是**模型真调通了**（旧的「看 system prompt 的 tools 节」不可靠：扩展工具不一定在那节里）
  if (args.probe) {
    const rows = [];
    for (const arm of arms) {
      const dir = join(args.out, `probe-${arm}`);
      const probe = await probeArm(arm, args, dir);
      rows.push({
        臂: arm,
        应可用工具: ARM_SPECS[arm]?.probeTool ?? "（无，只验能否跑）",
        实际调用: probe.used ?? 0,
        退出码: probe.exitCode,
        用时秒: Number(((probe.wallMs ?? 0) / 1000).toFixed(1)),
        工具分布: Object.entries(probe.toolCallsByName ?? {})
          .map(([k, v]) => `${k}×${v}`)
          .join(" "),
        结果: probe.ok ? probe.reason : `**不可用**（${probe.reason}）`,
      });
    }
    process.stdout.write(
      `\n=== 工具面自检（pi=${args.piBin}）===\n${JSON.stringify(rows, null, 2)}\n`,
    );
    return;
  }

  // --regrade：只重跑客观判分（判分口径改了要重算历史产物，**不重跑模型**）
  if (args.regrade) {
    if (!existsSync(reportPath)) throw new Error(`--regrade 需要已有报告：${reportPath}`);
    report = JSON.parse(readFileSync(reportPath, "utf8"));
    const previous = new Map((report.runs ?? []).map((r) => [`${r.arm}-${r.iteration}`, r]));
    const runs = [];
    for (const arm of arms) {
      for (let iteration = 1; iteration <= args.repeat; iteration += 1) {
        const dirName = args.repeat > 1 ? `${arm}-${iteration}` : arm;
        const dir = join(args.out, dirName);
        const eventsPath = join(dir, "events.jsonl");
        if (!existsSync(eventsPath)) continue;
        const stdout = readFileSync(eventsPath, "utf8");
        const { metrics } = parseTrajectory(stdout);
        const workspace = join(dir, "workspace");
        const grade = objectiveGrade(arm, args.grader, workspace);
        const dispatch = await collectDispatch(arm, workspace, metrics);
        const before = previous.get(`${arm}-${iteration}`);
        runs.push({
          arm,
          iteration,
          dir: dirName,
          exitCode: before?.exitCode ?? 0,
          wallMs: before?.wallMs ?? 0,
          metrics,
          objective: grade,
          judged: before?.judged ?? { skipped: true },
          dispatch,
          contamination: detectContamination(arm, stdout),
          toolCallsByName: metrics.toolCallsByName,
        });
        process.stdout.write(`${dirName}: ${grade.passed} passed / ${grade.failed} failed\n`);
      }
    }
    report.runs = runs;
    report.arms = {};
    for (const arm of arms) {
      const armRuns = runs.filter((r) => r.arm === arm);
      report.arms[arm] = armRuns.length
        ? aggregate(armRuns)
        : (report.arms[arm] ?? { skipped: true });
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    printTable(arms, report, args);
    return;
  }

  // --judge-only：复用已存轨迹只补判分（判分口径改了不用重跑两臂）
  if (args.judgeOnly) {
    if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const arm of arms) {
      // 多轮跑时目录是 <arm>-1 / <arm>-2 …，判分取第 1 轮
      const multiRound = join(args.out, `${arm}-1`, "trajectory.json");
      const singleRound = join(args.out, arm, "trajectory.json");
      const trajectoryPath = existsSync(multiRound) ? multiRound : singleRound;
      if (!existsSync(trajectoryPath)) {
        process.stdout.write(`跳过 ${arm}：没有轨迹\n`);
        continue;
      }
      const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8"));
      const judged = await judge(arm, checklist, trajectory.messages, args);
      report.arms[arm] = { ...report.arms[arm], judged };
      process.stdout.write(
        `${arm}: reward=${judged.reward} (${judged.success}/${judged.total})` +
          (judged.failures.length > 0 ? ` 失败类别: ${judged.failures.join(" | ")}` : "") +
          "\n",
      );
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    printTable(arms, report, args);
    return;
  }

  const prompt = readFileSync(args.prompt, "utf8").trim();

  // 闸门：开跑前先验每臂的主工具真调得通——**不通就跳过该臂并写明原因**，
  // 绝不让「工具压根不存在」记成「模型没做到」。
  // 实测踩过：pi 0.86/0.87 没有 codemode 内建扩展，且 settings 的 defaultTools 修饰符语法
  //（"+codemode"）要 0.99+ 才支持——0.86 上 defaultTools 原样当工具名列表，
  // "+codemode" 不存在 → 激活工具变成空集 → 模型面前一个工具都没有 →
  // 模型把 tool_call 当正文吐出来 → 0 工具调用、0 passed，看起来像模型崩了。
  const probes = {};
  for (const arm of arms) {
    process.stdout.write(`\n=== 闸门：${arm} 工具面自检 ===\n`);
    probes[arm] = await probeArm(arm, args, join(args.out, `probe-${arm}`));
    process.stdout.write(`${probes[arm].ok ? "OK" : "SKIP"}：${probes[arm].reason}\n`);
  }

  const runs = [];
  const skipped = {};
  for (let iteration = 1; iteration <= args.repeat; iteration += 1) {
    for (const arm of arms) {
      if (!probes[arm]?.ok) {
        skipped[arm] = probes[arm]?.reason ?? "闸门未过";
        continue;
      }
      const dir = join(args.out, args.repeat > 1 ? `${arm}-${iteration}` : arm);
      process.stdout.write(`\n=== 跑臂 ${arm}（第 ${iteration}/${args.repeat} 次）===\n`);
      const run = await runArm(arm, prompt, args, dir);
      const { messages, metrics } = parseTrajectory(run.stdout);
      process.stdout.write(
        `exit=${run.exitCode} 用时=${(run.wallMs / 1000).toFixed(1)}s 轮次=${metrics.turns} 工具调用=${metrics.toolCalls} 输出token=${metrics.outputTokens} ptc调用=${metrics.toolCallsByName.ptc_run_code ?? 0} codemode调用=${metrics.toolCallsByName.codemode ?? 0}\n`,
      );
      // 父最终输出落盘：facts 题的判分器要读它（子代理侧从 registry 记录读）
      writeFileSync(
        join(run.workspace, "final_answer.md"),
        messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n"),
      );
      const grade = objectiveGrade(arm, args.grader, run.workspace);
      // 工作区归档：放在客观判分**之后**——final_answer.md（父最终输出）、truth.json（ground truth）
      // 与判分器拷贝都是刚写进工作区的，缺了它们归档目录就复现不了判分
      cpSync(run.workspace, join(dir, "workspace"), { recursive: true });
      process.stdout.write(
        `客观判分：${grade.passed} passed / ${grade.failed} failed / ${grade.errored} error${grade.checker ? `（检查脚本：${grade.checker.passed}/${grade.checker.modules ?? "?"} 模块）` : ""}\n`,
      );

      // 派发指标：父进程退出时孩子可能还在跑 → 先等在飞的任务落终态，再读 registry
      const dispatch = await collectDispatch(arm, run.workspace, metrics);

      // 污染自检：本仓上下文/工具面漏进会话 → 这轮数据不可信，标出来（不判失败，只标记）
      const contamination = detectContamination(arm, run.stdout);
      if (contamination.contaminated) {
        process.stdout.write(
          `⚠ 污染：上下文[${contamination.contextMarkers.join(", ")}] 意外工具[${contamination.unexpectedRepoTools.join(", ")}]（这轮数据不可信）\n`,
        );
      }

      let judged = { skipped: true };
      if (!args.skipJudge) {
        judged = await judge(arm, checklist, messages, args);
        process.stdout.write(
          `judge：reward=${judged.reward ?? "n/a"} (${judged.success ?? 0}/${judged.total ?? 0})\n`,
        );
      }

      runs.push({
        arm,
        iteration,
        dir: args.repeat > 1 ? `${arm}-${iteration}` : arm,
        exitCode: run.exitCode,
        wallMs: run.wallMs,
        metrics,
        objective: grade,
        judged,
        dispatch,
        contamination,
        toolCallsByName: metrics.toolCallsByName,
      });
      writeFileSync(
        join(dir, "trajectory.json"),
        JSON.stringify(
          { meta: { session_id: metrics.sessionId, arm }, tools: buildTools(messages), messages },
          null,
          2,
        ),
      );
    }
  }

  report.runs = runs;
  report.skipped = skipped;
  report.probes = probes;
  for (const arm of arms) {
    report.arms[arm] = skipped[arm]
      ? { skipped: true, reason: skipped[arm] }
      : aggregate(runs.filter((r) => r.arm === arm));
  }

  mkdirSync(args.out, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printTable(arms, report, args);
  process.stdout.write(`\n报告：${reportPath}\n`);
}

await main();
