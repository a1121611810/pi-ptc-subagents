import type { ChildHandle } from "./engine.ts";
import { spawn } from "node:child_process";
import { REPORT_CONTRACT_BLOCK } from "./report.ts";

const STDERR_KEEP_CHARS = 64 * 1024; // 只留尾部：stopReason 素材够用，防喷涌撑爆宿主内存

// 子进程以用户身份跑（旧 ADR-0007：信任姿态与所有 pi 扩展一致，无 OS 沙箱）
export function spawnChild(argv: string[], env: NodeJS.ProcessEnv = process.env): ChildHandle {
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_KEEP_CHARS);
  });
  let exitCode: number | null = null;
  let onExit: ((code: number, stderr: string) => void) | undefined;
  const settle = (code: number) => {
    if (exitCode !== null) return;
    exitCode = code;
    onExit?.(code, stderr);
  };
  // spawn 失败（ENOENT/E2BIG）只发 error 不发 exit：不监听会以未捕获异常崩掉宿主
  child.on("error", (error) => {
    stderr = `${stderr}spawn error: ${error.message}\n`.slice(-STDERR_KEEP_CHARS);
    settle(-1);
  });
  // close 等 stdio 流关闭后才触发；exit 可能早于管道尾部数据（报告/usage 会丢尾）
  child.on("close", (code) => settle(code ?? -1));
  return {
    pid: child.pid ?? 0,
    onOutput: (callback) => child.stdout.on("data", (chunk) => callback(String(chunk))),
    onExit: (callback) => {
      onExit = callback;
      if (exitCode !== null) callback(exitCode, stderr); // 订阅晚于退出：补发
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

// 旧 ADR-0042：块内吞用户原文的地方做实体转义——未转义的 <> 会伪造标签、破坏块边界
function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// pi 子进程 argv（旧 ADR-0016/0039/0044）：--no-session 不留磁盘状态；追加块告诉孩子它是什么
export function buildPiArgv(
  input: {
    task: string;
    why?: string;
    model?: string;
    thinkingLevel?: string;
    readOnly?: "strict" | "lenient";
    /** 旧 ADR-0032：agent frontmatter childReport:false → 契约不出现在追加块（reportChannel = opted-out） */
    childReport?: boolean;
    /** 旧 ADR-0039：agent frontmatter tools: 名单——孩子的工具表取它（只收窄不扩权） */
    agentTools?: string[];
    /** ADR-0003 修正：搜索开启时 strict 白名单保留 web_ds_search */
    searchEnabled?: boolean;
    /** 旧 ADR-0044：解析出的 agent 定义钉的模型/档位（调用参数优先于它们） */
    agentModel?: string;
    agentThinkingLevel?: string;
  },
  context: { depth: number; sessionModel?: string },
): string[] {
  const block = [
    "<pi-ptc-context>",
    `你是被派发的子代理：看不到父会话，你的最终消息就是交付物（depth ${context.depth}）。`,
    input.why ? `<pi-ptc-why>${escapeXmlText(input.why)}</pi-ptc-why>` : "",
    input.childReport === false ? "" : REPORT_CONTRACT_BLOCK,
    "</pi-ptc-context>",
  ]
    .filter(Boolean)
    .join("\n");
  // --mode json：工具通道（toolResult 消息）与终态文本/usage 都从这流解析
  const argv = ["pi", "-p", "--no-session", "--mode", "json", "--append-system-prompt", block];
  // 旧 ADR-0044 解析序：调用参数 → agent 定义 → 会话当前模型；思考档位挂 :<thinking> 后缀（pi --model 语法）
  const model = input.model ?? input.agentModel ?? context.sessionModel;
  const thinking = input.thinkingLevel ?? input.agentThinkingLevel;
  if (model) argv.push("--model", thinking ? `${model}:${thinking}` : model);
  // 工具表（旧 ADR-0039/0041/0049）：strict 压过一切 → 读集（搜索开启含 web_ds_search）；否则 agent 名单收窄
  const READ_SET = input.searchEnabled
    ? ["read", "grep", "find", "ls", "web_ds_search"]
    : ["read", "grep", "find", "ls"];
  if (input.readOnly === "strict") {
    argv.push("--tools", READ_SET.join(","));
  } else if (input.agentTools && input.agentTools.length > 0) {
    argv.push("--tools", input.agentTools.join(","));
  }
  argv.push(input.task);
  return argv;
}
