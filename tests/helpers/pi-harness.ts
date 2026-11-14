// 共享夹具：假 pi 宿主 + 隔离的 agent 目录。
// 假 pi 是**进程级**替身（PATH 上的假 pi 脚本 / ctx.executeTool），vi.mock 帮不上；
// 本仓已用 DI（EngineOptions.spawnChild）⇒ 模块级注入留给引擎自己的夹具。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Handler = (...args: unknown[]) => unknown;

export interface FakePi {
  handlers: Record<string, Handler[]>;
  registered: Record<
    string,
    { name: string; description: string; execute?: (...a: unknown[]) => unknown }
  >;
  active: string[];
  all: string[];
}

export function createFakePi(options: { active?: string[]; all?: string[] } = {}): FakePi {
  const handlers: Record<string, Handler[]> = {};
  const registered: FakePi["registered"] = {};
  const all = options.all ?? [];
  const fake: FakePi = {
    handlers,
    registered,
    active: options.active ? [...options.active] : [],
    all,
    on: (event: string, cb: Handler) => {
      (handlers[event] ??= []).push(cb);
    },
    registerTool: (def: {
      name: string;
      description: string;
      execute?: (...a: unknown[]) => unknown;
    }) => {
      registered[def.name] = def;
    },
    registerCommand: () => {},
    getActiveTools: () => [...fake.active],
    setActiveTools: (names: string[]) => {
      fake.active = [...names];
    },
    getAllTools: () => all.map((name) => ({ name })),
    sendMessage: () => {},
  };
  return fake;
}

/** 隔离的 agent 目录：配置与状态哨兵都落这里，别碰用户真目录 */
export function agentDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ptc-agent-"));
  mkdirSync(join(dir, "pi-ptc-subagents"), { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, "ptc.json"), JSON.stringify(config));
  return dir;
}

/** 触发 session_start：entry 只在这里注册工具（工厂阶段 getActiveTools 是 throw 的桩） */
export async function startSession(
  fake: FakePi,
  ctx: unknown = { ui: { notify: () => {} } },
): Promise<void> {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  entryDefault(fake as never);
  const handler = fake.handlers.session_start?.[0];
  if (!handler) throw new Error("entry 没注册 session_start");
  await handler({}, ctx);
}

/** PATH 最前放一个假 pi：entry 在 session_start 里跑 `pi --version` 取版本 */
export function fakePiOnPath(version: string, body = "exit 0"): () => void {
  const bin = mkdtempSync(join(tmpdir(), "ptc-fake-pi-"));
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\n${body}\n`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => {
    process.env.PATH = saved;
  };
}

/** 临时工作区（文件四件套的根、jail 边界） */
export function workDir(prefix = "ptc-work-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
