// 真机探针：孩子的模型默认继承父会话的当前模型（entry 的 buildEngineContext → 孩子 argv 的 --model provider/id）
//
// 用法：node scripts/session-model-smoke.mjs   （可选 SMOKE_MODEL=<provider/id> 换显式父模型）
// 断言不靠模型配合：父的模型与孩子的模型都从**事件流**里读（父的 message_end、孩子的 output.log），
// 模型只需要「派一个孩子」这一件事——它把结果怎么打印、打印几遍都不进断言。
//
// 为什么跑两轮（父模型不同的两轮）：继承坏了有两种坏法——
//   ① 孩子恒用 pi 的默认模型（继承压根没接）→ 第一轮就红
//   ② 孩子恒用某个写死的模型 → 第二轮红（父换模型，孩子不跟）
// 两轮都绿 ⇒ 孩子的模型确实跟着父走。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(REPO, "packages/entry/dist/index.js");

// 父只需要「派一个孩子」。明确禁止传 model —— 传了就等于自己指定，谈不上继承。
const PROMPT =
  '调用 ptc_run_code，程序体为：const r = await tools.pi_task_ptc({ task: "只回答 OK", wait: true }); return r.status; ' +
  "程序体里不要传 model 参数。";

const EXPLICIT_MODEL = process.env.SMOKE_MODEL ?? "minimax-cn/MiniMax-M3.1-Flash";

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

/** 父会话用的模型（最后一条 assistant message_end） */
function parentModel(events) {
  let found = null;
  for (const event of events) {
    const message = event.message;
    if (event.type !== "message_end" || message?.role !== "assistant" || !message?.model) continue;
    found = { provider: message.provider, model: message.model };
  }
  return found;
}

/** 孩子实际跑在哪个模型上——从孩子自己的事件流读（output.log = 孩子的原始 stdout） */
function childModels(workspace) {
  const dir = join(workspace, ".pi", "ptc-tasks", "tasks");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir)) {
    const log = join(dir, id, "output.log");
    if (!existsSync(log)) continue;
    let found = null;
    for (const event of parseEvents(readFileSync(log, "utf8"))) {
      const message = event.message;
      if (event.type !== "message_end" || message?.role !== "assistant" || !message?.model)
        continue;
      found = { provider: message.provider, model: message.model };
    }
    if (found) out.push({ id, ...found });
  }
  return out;
}

/** 父写下的程序体（要确认里面没有 model 参数——否则测的不是继承） */
function dispatchedPrograms(events) {
  return events
    .filter((event) => event.type === "tool_execution_start" && event.toolName === "ptc_run_code")
    .map((event) => String(event.args?.code ?? ""));
}

function runRound({ label, model }) {
  const workspace = mkdtempSync(join(tmpdir(), "sm-ws-"));
  const args = ["-ne", "-e", EXT, "-p", "--mode", "json"];
  if (model) args.push("--model", model);
  args.push(PROMPT);
  // cwd = 临时工作区：任务记录与产出落在 workspace/.pi/ptc-tasks，不写仓库
  const stdout = execFileSync("pi", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const events = parseEvents(stdout);
  const parent = parentModel(events);
  const children = childModels(workspace);
  const programs = dispatchedPrograms(events);

  assert.ok(parent, `${label}：父的事件流里没读到模型`);
  assert.ok(
    programs.some((code) => code.includes("pi_task_ptc")),
    `${label}：父没有派发孩子（程序体里找不到 pi_task_ptc）`,
  );
  for (const code of programs) {
    assert.ok(
      !/\bmodel\s*:/.test(code),
      `${label}：程序体里传了 model 参数——那测的是显式指定，不是继承：${code.slice(0, 200)}`,
    );
  }
  assert.ok(children.length > 0, `${label}：没有读到孩子的产出（任务记录/产出目录为空）`);
  for (const child of children) {
    assert.equal(
      child.provider,
      parent.provider,
      `${label}：孩子的 provider 应继承父的（父 ${parent.provider}，孩子 ${child.provider}）`,
    );
    assert.equal(
      child.model,
      parent.model,
      `${label}：孩子的 model 应继承父的（父 ${parent.model}，孩子 ${child.model}）`,
    );
  }
  console.log(
    `✓ ${label}：父=${parent.provider}/${parent.model}　孩子 ${children.length} 个，全部继承（${children
      .map((c) => `${c.provider}/${c.model}`)
      .join("、")}）`,
  );
  return { parent, children };
}

const piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
console.log(`pi 版本：${piVersion}　扩展：${EXT}`);

const explicit = runRound({ label: "显式父模型", model: EXPLICIT_MODEL });
const fallback = runRound({ label: "默认父模型", model: null });

// 差分有效性：两轮的父模型必须不同，否则「孩子跟着父走」这件事没被真正测到
assert.notEqual(
  `${explicit.parent.provider}/${explicit.parent.model}`,
  `${fallback.parent.provider}/${fallback.parent.model}`,
  `两轮的父模型相同（${explicit.parent.provider}/${explicit.parent.model}）→ 差分失效，换 SMOKE_MODEL`,
);

console.log(
  `\n[session-model-smoke PASS] pi ${piVersion}：孩子的模型跟着父会话走，两轮都成立。` +
    `父模型在两轮里分别是 ${explicit.parent.provider}/${explicit.parent.model} 与 ${fallback.parent.provider}/${fallback.parent.model}。`,
);
