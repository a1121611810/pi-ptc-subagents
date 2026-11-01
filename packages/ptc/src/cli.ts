#!/usr/bin/env node
// PTC 命令行：不经模型跑一个程序文件。程序能力面 = 文件四件套绑定，只在 workdir 内活动。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPtcProgram } from "./dispatcher.ts";
import { createFsBindings } from "./fs-bindings.ts";

const USAGE = `用法：ptc <program.ts> [--workdir <dir>] [--timeout <ms>] [--json]

程序在运行格里跑（看不见 process / fetch / 动态 import），能调的只有文件四件套
（read / write / grep / glob / edit），且只在 workdir 内活动。`;

interface Options {
  program: string;
  workdir: string;
  timeoutMs?: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  let program = "";
  let workdir = process.cwd();
  let timeoutMs: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--workdir" || arg === "-w") workdir = argv[++i] ?? workdir;
    else if (arg === "--timeout") timeoutMs = Number(argv[++i]);
    else if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}`);
    else if (program) throw new Error(`只能跑一个程序（多给了 ${arg}）`);
    else program = arg;
  }
  if (!program) throw new Error(USAGE);
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs))
    throw new Error("--timeout 要一个毫秒数");
  return { program, workdir: resolve(workdir), timeoutMs, json };
}

// 程序无返回值时引擎给 { $void: true }——命令行不打印这个内部标记
function isVoid(value: unknown): boolean {
  return typeof value === "object" && value !== null && "$void" in value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const options = parseArgs(argv);
  const outcome = await runPtcProgram({
    code: readFileSync(options.program, "utf8"),
    cwd: options.workdir,
    timeoutMs: options.timeoutMs,
    bindings: createFsBindings(options.workdir),
  });
  for (const line of outcome.logs) console.error(line);
  if (options.json) {
    console.log(JSON.stringify(outcome, null, 2));
  } else if (outcome.status === "fulfilled") {
    console.log(isVoid(outcome.value) ? "(程序无返回值)" : JSON.stringify(outcome.value, null, 2));
  }
  if (outcome.status !== "fulfilled") {
    console.error(outcome.status === "canceled" ? outcome.reason : outcome.error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
