// 共享夹具：假 MCP 客户端——真 spawn server bundle，走 stdio JSON-RPC。
import { spawn } from "node:child_process";

export interface McpClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  stderr(): string;
  stop(): void;
}

export function startMcpClient(serverPath: string): McpClient {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  const errors: string[] = [];
  child.stderr.on("data", (d) => errors.push(String(d)));
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting ${method}; stderr=${errors.join("").slice(0, 400)}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    request,
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    stderr: () => errors.join(""),
    stop: () => {
      child.kill();
    },
  };
}
