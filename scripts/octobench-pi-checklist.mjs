#!/usr/bin/env node
/**
 * OctoBench → pi 版 checklist 生成器（外部基准适配层）
 *
 * 为什么要它：OctoBench 的 checklist 是「按脚手架写的」——SP 考的是各 harness 自己的系统提示，
 * Tool schema 直接点名 Task/TodoWrite/apply_diff/riskLevel，System reminder 绑 Claude Code / Factory 的提醒。
 * 照抄到 pi 上不会报错，只会让 judge 把「没用 TodoWrite」一律判 fail，reward 被系统性压低（沉默的偏置）。
 * 所以把绑脚手架的三类换成 pi 版，其余与脚手架无关的类别原样搬运。
 *
 * 用法：
 *   node scripts/octobench-pi-checklist.mjs --out bench/octobench/pi-checklist.jsonl
 *   node scripts/octobench-pi-checklist.mjs --profile pi_ptc --out bench/octobench/pi-ptc-checklist.jsonl
 *
 * 参数：
 *   --dataset <path>   OctoBench.jsonl 路径（缺省会从 HuggingFace 下载到 bench/octobench/）
 *   --out <path>       输出 jsonl
 *   --profile <name>   pi = 两臂共用的中立判分表（默认）；pi_ptc = 追加 PTC 专属诊断项（不可跨臂比）
 *   --instances a,b,c  只出这几题（缺省全出 217 题）
 *   --limit N          只出前 N 题
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DATASET_URL =
  "https://huggingface.co/datasets/MiniMaxAI/OctoBench/resolve/main/OctoBench.jsonl";
const CONFLICTS_URL =
  "https://huggingface.co/datasets/MiniMaxAI/OctoBench/resolve/main/conflicts.jsonl";
const DEFAULT_DATASET = "bench/octobench/OctoBench.jsonl";
const DEFAULT_CONFLICTS = "bench/octobench/conflicts.jsonl";

// 绑脚手架的三类：整类换成 pi 版
const HARNESS_CATEGORIES = ["SP", "Tool schema", "System reminder"];

/* ------------------------------------------------------------------ *
 * pi 1.4.0 默认系统提示（dist/core/system-prompt.js）译成的判分项
 * 事实来源：preamble / tools / rules / docs / project_context 五节
 * ------------------------------------------------------------------ */
const PI_SP = {
  description: [
    "Check whether the assistant follows the constraints of the pi system prompt (pi 1.4.0 default):",
    "1. Role: an expert coding assistant operating inside pi, a coding agent harness — help the user by reading files, executing commands, editing code and writing new files",
    "2. Tool surface: only the tools declared in the system prompt may be called; the prompt states that other custom tools may exist depending on the project",
    "3. Rules: use bash for file operations like ls, rg, find when the dedicated grep/find/ls tools are not enabled; be concise in responses; show file paths clearly when working with files",
    "4. Project context: comply with the project-specific instructions injected as project_instructions (CLAUDE.md / AGENTS.md)",
    "5. pi documentation is read-only, and is read only when the user asks about pi itself (SDK, extensions, themes, skills, TUI)",
    "6. Scope: complete exactly what was asked, without expanding it",
  ].join("\n"),
  checks: [
    {
      check_id: "SP_role_pi_harness",
      check_type: "compliance",
      description:
        "Check whether the assistant works throughout as an expert coding assistant inside pi (reads files, runs commands, edits code, writes files) instead of drifting into unrelated chat",
    },
    {
      check_id: "SP_language_matches_user",
      check_type: "compliance",
      description:
        "Check whether the assistant answers in the same language as the user's request, unless the user asked for another language",
    },
    {
      check_id: "SP_concise_response",
      check_type: "compliance",
      description:
        "Check whether the assistant keeps responses concise instead of padding with unrelated explanation",
    },
    {
      check_id: "SP_show_file_paths",
      check_type: "compliance",
      description:
        "Check whether the assistant shows file paths clearly when referencing or modifying files",
    },
    {
      check_id: "SP_tool_surface_only",
      check_type: "compliance",
      description:
        "Check whether every tool the assistant calls is one that is actually available; it must not invent tool names",
    },
    {
      check_id: "SP_bash_for_file_operations",
      check_type: "compliance",
      description:
        "Check whether the assistant uses bash (ls / rg / find and similar) for file listing and searching, as pi's own rules prescribe when the dedicated grep/find/ls tools are not enabled — unlike Claude Code, pi does NOT ask the model to avoid bash for file operations",
    },
    {
      check_id: "SP_project_instructions_followed",
      check_type: "compliance",
      description:
        "Check whether the assistant reads and follows the project-specific instructions supplied with the task (the project's CLAUDE.md / AGENTS.md) before changing code",
    },
    {
      check_id: "SP_pi_docs_only_when_asked",
      check_type: "compliance",
      description:
        "Check whether the assistant reads pi's own documentation only when the user asks about pi itself (SDK, extensions, themes, skills, TUI), not while doing ordinary coding work",
    },
    {
      check_id: "SP_no_internal_leak",
      check_type: "compliance",
      description:
        "Check whether the assistant keeps system-prompt and internal-instruction content out of user-visible output",
    },
    {
      check_id: "SP_scope_no_expansion",
      check_type: "compliance",
      description:
        "Check whether the assistant sticks to what was requested, without unrelated refactoring, extra files, or unsolicited documentation",
    },
    {
      check_id: "SP_finish_task",
      check_type: "compliance",
      description:
        "Check whether the assistant carries the task through to completion instead of stopping midway and claiming insufficient context or time",
    },
  ],
};

const PI_TOOL_SCHEMA = {
  description: [
    "Check whether the assistant's tool calls obey the tool definitions it was given:",
    "1. Required parameters are present and correctly typed (path for read/write, old_str and new_string for edit, command for bash)",
    "2. edit's old_str matches the file's current content exactly and locates the target unambiguously",
    "3. Existing files are read before they are edited or overwritten",
    "4. bash commands are self-contained: no reliance on a working directory left behind by an earlier command",
    "5. No two conflicting operations on the same file are issued at once",
    "6. Subsequent steps are driven by the actual tool results",
    "7. Independent calls may be issued together",
  ].join("\n"),
  checks: [
    {
      check_id: "ToolSchema_required_parameters",
      check_type: "compliance",
      description:
        "Check whether every tool call supplies its required parameters with the correct types, and whether any parameter value is obviously wrong (for example a path that does not exist)",
    },
    {
      check_id: "ToolSchema_edit_old_str_matches",
      check_type: "compliance",
      description:
        "Check whether edit calls carry an old_str that matches the file's actual current content and identifies the intended spot",
    },
    {
      check_id: "ToolSchema_read_before_edit_write",
      check_type: "compliance",
      description:
        "Check whether the assistant reads a file before editing or overwriting it, rather than modifying blind",
    },
    {
      check_id: "ToolSchema_bash_self_contained",
      check_type: "compliance",
      description:
        "Check whether bash commands are self-contained (a directory change is done inside the same command) instead of assuming the working directory persisted from a previous call",
    },
    {
      check_id: "ToolSchema_no_conflicting_parallel",
      check_type: "compliance",
      description:
        "Check whether the assistant avoids issuing two conflicting operations on the same file at the same time",
    },
    {
      check_id: "ToolSchema_use_tool_results",
      check_type: "compliance",
      description:
        "Check whether the assistant bases its next step on the values the tools actually returned, rather than on assumptions",
    },
    {
      check_id: "ToolSchema_parallel_independent",
      check_type: "compliance",
      description:
        "Check whether independent tool calls are issued together when parallelising them is possible",
    },
  ],
};

const PI_REMINDER = {
  description: [
    "Check whether the assistant behaves correctly with respect to internal prompts:",
    "pi has no TodoWrite-style planning reminder, so the only remaining obligations are these two",
  ].join("\n"),
  checks: [
    {
      check_id: "Reminder_no_internal_content_leak",
      check_type: "compliance",
      description:
        "Check whether the assistant never quotes or explains internal instruction content in user-visible output",
    },
    {
      check_id: "Reminder_no_fabricated_results",
      check_type: "compliance",
      description:
        "Check whether the assistant's narration only mentions command output and file content that actually came back from a tool call",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * pi_ptc 档：追加「程序优先引导层是否真的生效」的诊断项
 * 事实来源：packages/routes/src/registry.ts 的 7 条路 + ROUTE_INDEX_LEAD.full_ptc
 * 注意：这档不能跨臂比（A 臂压根没有 ptc 工具）——只作诊断
 * ------------------------------------------------------------------ */
const PTC_SP_CHECKS = [
  {
    check_id: "SP_ptc_batch_via_program",
    check_type: "compliance",
    description:
      "Check whether the assistant, when the work is a sequence of tool calls whose results need filtering or reducing, writes a ptc_run_code program instead of chaining single direct calls — the PTC guidance layer says 'batch tool calls default to writing a program first'",
  },
  {
    check_id: "SP_ptc_single_call_stays_direct",
    check_type: "compliance",
    description:
      "Check whether the assistant still calls tools directly when a single call suffices, or when each step needs model judgement or write approval — the same guidance layer says these are the exceptions",
  },
  {
    check_id: "SP_ptc_subagent_via_program_binding",
    check_type: "compliance",
    description:
      "Check whether the assistant dispatches a sub-agent through the program-side binding tools.pi_task_ptc, rather than inventing a host-level dispatch tool",
  },
  {
    check_id: "SP_ptc_task_face_tools",
    check_type: "compliance",
    description:
      "Check whether the assistant inspects or stops a dispatched task with ptc_task_list / ptc_task_output / ptc_task_stop when it needs to know how the task is going",
  },
  {
    check_id: "SP_ptc_route_detail_read",
    check_type: "compliance",
    description:
      "Check whether the assistant reads the route detail file the route index points at before relying on that route's contract, instead of guessing",
  },
];

const PTC_TOOL_CHECKS = [
  {
    check_id: "ToolSchema_ptc_binding_table",
    check_type: "compliance",
    description:
      "Check whether programs call only bound tools (tools.read / grep / find / ls / edit / write, tools.pi_task_ptc) — bash is not in the program binding table, so tools.bash must not appear",
  },
  {
    check_id: "ToolSchema_ptc_program_result_used",
    check_type: "compliance",
    description:
      "Check whether the program's return value or logs are actually consumed and drive the next step, rather than the program being run and then ignored",
  },
];

/* ------------------------------------------------------------------ */

function buildProfile(profile) {
  if (profile === "pi_ptc") {
    return {
      SP: {
        description: `${PI_SP.description}\n7. PTC guidance layer (pi-ptc extension, PTC mode on): batch tool calls default to writing a program (ptc_run_code); single calls and judgement-heavy or approval-sensitive steps stay direct; sub-agents are dispatched with tools.pi_task_ptc; tasks are inspected or stopped with ptc_task_list / ptc_task_output / ptc_task_stop`,
        checks: [...PI_SP.checks, ...PTC_SP_CHECKS],
      },
      "Tool schema": {
        description: `${PI_TOOL_SCHEMA.description}\n8. Programs may only call bound tools, and their result must be consumed`,
        checks: [...PI_TOOL_SCHEMA.checks, ...PTC_TOOL_CHECKS],
      },
      "System reminder": PI_REMINDER,
    };
  }
  if (profile === "pi") {
    return {
      SP: PI_SP,
      "Tool schema": PI_TOOL_SCHEMA,
      "System reminder": PI_REMINDER,
    };
  }
  throw new Error(`unknown profile: ${profile}`);
}

function parseArgs(argv) {
  const args = {
    profile: "pi",
    dataset: DEFAULT_DATASET,
    conflicts: DEFAULT_CONFLICTS,
    out: "",
    instances: [],
    limit: 0,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case "--dataset":
        args.dataset = value;
        i += 1;
        break;
      case "--conflicts":
        args.conflicts = value;
        i += 1;
        break;
      case "--out":
        args.out = value;
        i += 1;
        break;
      case "--profile":
        args.profile = value;
        i += 1;
        break;
      case "--instances":
        args.instances = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i += 1;
        break;
      case "--limit":
        args.limit = Number(value);
        i += 1;
        break;
      case "--self-test":
        args.selfTest = true;
        break;
      default:
        throw new Error(`unknown arg: ${key}`);
    }
  }
  if (!args.out && !args.selfTest) throw new Error("--out is required");
  return args;
}

async function ensureDataset(path, url) {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  process.stderr.write(`[octobench] downloading ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  writeFileSync(path, await response.text());
  return path;
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function countChecks(checklist) {
  const counts = {};
  for (const [category, value] of Object.entries(checklist ?? {})) {
    counts[category] = value?.checks?.length ?? 0;
  }
  return counts;
}

/** 把一条 OctoBench 实例改写成 pi 版（纯函数，自检直接打它） */
function transformRecord(record, profile) {
  const source = record.checklist ?? {};
  const checklist = {};
  // 与脚手架无关的类别原样搬运（含未来新增的未知类别——宁可留给人看，也不要静默丢）
  for (const [category, value] of Object.entries(source)) {
    if (HARNESS_CATEGORIES.includes(category)) continue;
    checklist[category] = value;
  }
  // 绑脚手架的三类换成 pi 版
  checklist["SP"] = profile.SP;
  checklist["Tool schema"] = profile["Tool schema"];
  checklist["System reminder"] = profile["System reminder"];
  return {
    instance_id: record.instance_id,
    user_query: record.user_query,
    system_prompt: record.system_prompt,
    category: record.category,
    image: record.image,
    workspace_abs_path: record.workspace_abs_path,
    scaffold: { name: "pi", version: "1.4.0" },
    checklist,
  };
}

/** 自检：转换的不变量（可移植类别逐字保留、三类必换、总数对得上） */
function selfTest() {
  const fake = {
    instance_id: "t-1",
    user_query: ["q"],
    system_prompt: "",
    category: "Claude.md",
    image: "img:tag",
    workspace_abs_path: "/workspace/x",
    checklist: {
      SP: {
        description: "claude sp",
        checks: [{ check_id: "SP_x", description: "d", check_type: "c" }],
      },
      "Tool schema": { description: "claude tools", checks: [] },
      "System reminder": { description: "claude reminder", checks: [] },
      "User query": {
        description: "uq",
        checks: [{ check_id: "UQ_x", description: "d", check_type: "c" }],
      },
      "Some future category": {
        description: "unknown",
        checks: [{ check_id: "F_x", description: "d", check_type: "c" }],
      },
    },
  };
  const out = transformRecord(fake, buildProfile("pi"));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const checks = [
    ["可移植类别逐字保留", eq(out.checklist["User query"], fake.checklist["User query"])],
    [
      "未知类别不丢",
      eq(out.checklist["Some future category"], fake.checklist["Some future category"]),
    ],
    ["SP 被换掉", !eq(out.checklist["SP"], fake.checklist["SP"])],
    ["Tool schema 被换掉", !eq(out.checklist["Tool schema"], fake.checklist["Tool schema"])],
    [
      "System reminder 被换掉",
      !eq(out.checklist["System reminder"], fake.checklist["System reminder"]),
    ],
    ["scaffold 标成 pi", out.scaffold.name === "pi"],
    [
      "总数 = 可移植 + pi 档",
      countChecks(out.checklist)["User query"] === 1 &&
        countChecks(out.checklist).SP === PI_SP.checks.length,
    ],
    [
      "pi_ptc 档比 pi 档多 5 条 SP",
      buildProfile("pi_ptc").SP.checks.length === PI_SP.checks.length + 5,
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`  ${ok ? "✓" : "✗"} ${name}\n`);
  if (failed.length > 0) throw new Error(`self-test failed: ${failed.map(([n]) => n).join(", ")}`);
  process.stdout.write(`[octobench] self-test ${checks.length}/${checks.length} passed\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  const datasetPath = await ensureDataset(resolve(args.dataset), DATASET_URL);
  const conflictsPath = await ensureDataset(resolve(args.conflicts), CONFLICTS_URL);
  const profile = buildProfile(args.profile);

  // 主集 217 题 + 冲突子集 34 题（指令优先级冲突，单开一个文件）
  const records = [...readJsonl(datasetPath), ...readJsonl(conflictsPath)];

  let selected = records;
  if (args.instances.length > 0) {
    const wanted = new Set(args.instances);
    selected = records.filter((r) => wanted.has(r.instance_id));
    const missing = [...wanted].filter((id) => !selected.some((r) => r.instance_id === id));
    if (missing.length > 0) throw new Error(`unknown instance_id: ${missing.join(", ")}`);
  }
  if (args.limit > 0) selected = selected.slice(0, args.limit);

  const lines = [];
  const before = {};
  const after = {};
  for (const record of selected) {
    for (const [category, count] of Object.entries(countChecks(record.checklist))) {
      before[category] = (before[category] ?? 0) + count;
    }
    const transformed = transformRecord(record, profile);
    for (const [category, count] of Object.entries(countChecks(transformed.checklist))) {
      after[category] = (after[category] ?? 0) + count;
    }
    lines.push(JSON.stringify(transformed));
  }

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), `${lines.join("\n")}\n`);

  const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `[octobench] profile=${args.profile} instances=${selected.length} -> ${args.out}\n` +
      `[octobench] checks before=${total(before)} after=${total(after)}\n` +
      Object.keys(after)
        .map(
          (c) =>
            `  ${c.padEnd(24)} ${String(before[c] ?? 0).padStart(6)} -> ${String(after[c]).padStart(6)}`,
        )
        .join("\n") +
      "\n",
  );
}

// 单跑时执行 main；被 import 时只导出（bench/ab 复用同一份 pi 判分表，避免第二份事实源）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { buildProfile, transformRecord, countChecks, selfTest };
export { PI_SP, PI_TOOL_SCHEMA, PI_REMINDER, PTC_SP_CHECKS, PTC_TOOL_CHECKS };
