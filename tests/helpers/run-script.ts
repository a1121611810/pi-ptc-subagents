// 跑一个脚本并收它的退出码与输出——真机面的通用形状（spawn 子进程、收 stdout/stderr）。
// 从 tests/kimi/runtime.test.ts 抽出：判据脚本调用拆到独立文件后两处都要用。
import { spawn } from "node:child_process";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function runScript(
  script: string,
  env: Record<string, string>,
  stdin?: string,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin === undefined) child.stdin.end();
    else {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
