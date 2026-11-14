// 入口装配面（pi）：session_start 注册 · surface 检测 · /ptc off 截断 · depth 早退 · 模型继承
//                  · DeepSeek 开关（默认关 / 互相独立）· strict 读集派生 · 引擎传参
//                  · floor（pi < 0.99）没有嵌套调用通道时的文件回退路径。
// 探针直接打产物（packages/entry/dist、packages/dispatch/dist）——仓规：验的是发布物形态。
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  InMemoryOutputStorage,
  TaskEngine,
  TaskRegistry,
  buildPiArgv,
} from "../../packages/dispatch/dist/index.js";
import entryDefault, { buildEngineContext } from "../../packages/entry/dist/index.js";
import { agentDir, createFakePi, type FakePi } from "../helpers/pi-harness.ts";

type ToolDef = {
  name: string;
  description?: string;
  exposure?: string;
  execute?: (...a: never[]) => unknown;
};

interface Host {
  fake: FakePi;
  commands: Record<string, (args: string, ctx: unknown) => Promise<void> | void>;
}

/** 假宿主：多抓一条 registerCommand（/ptc 命令的 handler 在那儿） */
const createHost = (options: { active?: string[]; all?: string[] } = {}): Host => {
  const fake = createFakePi(options);
  const commands: Host["commands"] = {};
  (fake as unknown as { registerCommand: (name: string, def: unknown) => void }).registerCommand = (
    name: string,
    def: unknown,
  ) => {
    commands[name] = (def as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  };
  return { fake, commands };
};

const notifyCtx = { ui: { notify: () => {} } };

/** 跑一次 session_start：配置与状态哨兵都落 tmp（别写用户真目录） */
const runSessionStart = async (
  host: Host,
  ctx: unknown = notifyCtx,
  config?: unknown,
): Promise<void> => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousDepth = process.env.PI_PTC_DEPTH;
  process.env.PI_CODING_AGENT_DIR = agentDir(config);
  delete process.env.PI_PTC_DEPTH;
  try {
    entryDefault(host.fake as never);
    const handler = host.fake.handlers.session_start?.[0];
    if (!handler) throw new Error("entry 没注册 session_start");
    await handler({}, ctx);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousDepth === undefined) delete process.env.PI_PTC_DEPTH;
    else process.env.PI_PTC_DEPTH = previousDepth;
  }
};

/** 子代理进程身份（depth>0）下注册到的工具表 */
const childRegisteredTools = async (config: unknown): Promise<Record<string, ToolDef>> => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousDepth = process.env.PI_PTC_DEPTH;
  process.env.PI_CODING_AGENT_DIR = agentDir(config);
  process.env.PI_PTC_DEPTH = "1";
  try {
    const host = createHost();
    entryDefault(host.fake as never);
    const handler = host.fake.handlers.session_start?.[0];
    if (!handler) throw new Error("entry 没注册 session_start");
    await handler({}, notifyCtx);
    return host.fake.registered as unknown as Record<string, ToolDef>;
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousDepth === undefined) delete process.env.PI_PTC_DEPTH;
    else process.env.PI_PTC_DEPTH = previousDepth;
  }
};

// ── 会话装配 ──

it("session_start 才注册工具（工厂阶段 getActiveTools 是 throw 的桩）", async () => {
  const host = createHost();
  entryDefault(host.fake as never);
  expect(Object.keys(host.fake.registered)).toEqual([]);
  expect(host.fake.handlers.session_start?.[0]).toBeDefined();
  await runSessionStart(host);
  expect(Object.keys(host.fake.registered).length).toBeGreaterThan(0);
});

it("surface 检测：活跃表含 codemode ⇒ codemode_ptc 面，否则 full_ptc 面", async () => {
  const codemode = createHost({ active: ["codemode"] });
  await runSessionStart(codemode);
  expect(codemode.fake.registered["pi_task_codemode"], "codemode 面注册建任务工具").toBeDefined();
  expect(
    codemode.fake.registered["ptc_run_code"],
    "codemode 面不注册 PTC 对（决策 28）",
  ).toBeUndefined();

  const full = createHost({ active: [] });
  await runSessionStart(full);
  expect(full.fake.registered["ptc_run_code"], "full_ptc 面注册 PTC 对").toBeDefined();
  expect(full.fake.registered["pi_task_codemode"], "full_ptc 面不注册建任务工具").toBeUndefined();
});

it("/ptc off 截断：PTC 层工具撤下（exposure hidden），任务面三工具不动", async () => {
  const host = createHost({ active: [] });
  await runSessionStart(host);
  expect(host.fake.registered["ptc_run_code"]).toBeDefined();
  await host.commands["ptc"]?.("off", notifyCtx);
  expect(
    (host.fake.registered["ptc_run_code"] as ToolDef).exposure,
    "/ptc off 后 PTC 层工具应撤下",
  ).toBe("hidden");
  expect(
    (host.fake.registered["ptc_task_list"] as ToolDef).exposure,
    "任务面不属于 PTC 层，/ptc off 不动它",
  ).toBeUndefined();
});

it("depth>0 早退：子代理进程只注册 child_report，宿主侧装配不做", async () => {
  const registered = await childRegisteredTools({});
  expect(Object.keys(registered).sort()).toEqual(["ptc_child_report"]);
});

it("模型继承：sessionModel = 父会话当前模型（活 getter，换模型跟着换）", () => {
  const ctx = { model: { provider: "minimax-cn", id: "MiniMax-M3.1-Flash" } };
  const context = buildEngineContext(ctx as never, "1.4.0");
  expect(context.sessionModel).toBe("minimax-cn/MiniMax-M3.1-Flash");
  expect(context.depth).toBe(0);
  expect(context.piVersion).toBe("1.4.0");
  ctx.model = { provider: "b", id: "m2" };
  expect(context.sessionModel, "getter 应在读取那一刻取当前模型").toBe("b/m2");
  expect(buildEngineContext({} as never, "1.4.0").sessionModel).toBeUndefined();
});

it("模型继承：端到端——entry 装配后派发一次，孩子 argv 带父会话的 --model", async () => {
  // 假 pi 放在 PATH 最前：回显自己的 argv（一个参数一行），--version 报 1.4.0
  const bin = mkdtempSync(join(tmpdir(), "ptc-sm-bin-"));
  const fakePi = join(bin, "pi");
  writeFileSync(
    fakePi,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.0; exit 0; fi\nfor a in "$@"; do echo "$a"; done\n',
  );
  chmodSync(fakePi, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  const savedCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "ptc-sm-cwd-"))); // storageDir 落 tmp，别写仓库
  try {
    const host = createHost({ active: ["codemode"] });
    await runSessionStart(host, {
      ui: { notify: () => {} },
      model: { provider: "minimax-cn", id: "MiniMax-M3.1-Flash" },
    });
    const tool = host.fake.registered["pi_task_codemode"] as ToolDef;
    const result = (await tool.execute?.("t1", {
      task: "echo argv",
      wait: true,
    } as never)) as { content: Array<{ text: string }> };
    const text = result.content.map((c) => c.text).join("");
    expect(text, "孩子 argv 应带 --model：" + text.slice(0, 400)).toContain("--model");
    expect(text, "孩子应继承父会话的模型：" + text.slice(0, 400)).toContain(
      "minimax-cn/MiniMax-M3.1-Flash",
    );
  } finally {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
  }
});

// ── DeepSeek 开关（默认关 / 互相独立）· strict 读集 · 引擎传参 ──

it("开关默认关（fail-closed）：配置里没写就不注册 DeepSeek 工具", async () => {
  const registered = await childRegisteredTools({});
  expect(registered["doc_ds_ocr"], "开关关时不该注册文档识别").toBeUndefined();
  expect(registered["web_ds_search"], "开关关时不该注册搜索").toBeUndefined();
});

it("两个开关互相独立（显式 false 也不串台）", async () => {
  const onlySearch = await childRegisteredTools({ webDsSearch: true, webDsOcr: false });
  expect(onlySearch["web_ds_search"], "搜索开关开 ⇒ 搜索该注册").toBeDefined();
  expect(onlySearch["doc_ds_ocr"], "搜索开关开不该顺带开文档识别").toBeUndefined();

  const onlyOcr = await childRegisteredTools({ webDsOcr: true, webDsSearch: false });
  expect(onlyOcr["doc_ds_ocr"], "文档识别开关开 ⇒ 该注册").toBeDefined();
  expect(onlyOcr["web_ds_search"], "文档识别开关开不该顺带开搜索").toBeUndefined();
});

it("strict 读集随开关派生（不是常量）：开了才有 doc_ds_ocr", () => {
  const base = { task: "x", taskId: "t1", readOnly: "strict" as const };
  const context = { depth: 0, piVersion: "1.5.2" };
  const on = buildPiArgv({ ...base, searchEnabled: true, ocrEnabled: true }, context);
  const onTools = on[on.indexOf("--tools") + 1]!.split(",");
  expect(onTools, "开了 OCR 的 strict 读集该含 doc_ds_ocr").toContain("doc_ds_ocr");
  expect(onTools).toContain("web_ds_search");
  const off = buildPiArgv({ ...base, searchEnabled: true }, context);
  const offTools = off[off.indexOf("--tools") + 1]!.split(",");
  expect(offTools, "没开就不该出现在 strict 读集里").not.toContain("doc_ds_ocr");
});

it("引擎把 ocrEnabled 传给 argv 构建器（开关不许在中间层丢掉）", async () => {
  let captured: { ocrEnabled?: boolean; searchEnabled?: boolean } | undefined;
  const engine = new TaskEngine({
    registry: new TaskRegistry(),
    output: new InMemoryOutputStorage(),
    buildArgv: (input) => {
      captured = input;
      return ["node", "-e", "process.stdout.write('ok')"];
    },
    searchEnabled: true,
    ocrEnabled: true,
  });
  await engine.dispatch({ task: "x", wait: true });
  expect(captured?.ocrEnabled, "引擎该把 ocrEnabled 传下去").toBe(true);
  expect(captured?.searchEnabled).toBe(true);
});

// ── floor（pi < 0.99）：没有嵌套调用通道 ⇒ 自己造出 pi 的真工具 ──

/** floor 实测：活跃表只有扩展自己的工具；内置工具只在 getAllTools 里 */
const floorHost = (): Host =>
  createHost({
    active: ["zz_probe"],
    all: ["read", "write", "edit", "grep", "find", "ls", "bash"],
  });

/** 假 pi 放在 PATH 最前：entry 在 session_start 里跑 `pi --version` 取版本 */
const fakePiOnPath = (version: string): (() => void) => {
  const bin = mkdtempSync(join(tmpdir(), "ptc-fake-pi-"));
  writeFileSync(join(bin, "pi"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => {
    process.env.PATH = saved;
  };
};

const withFloorSession = async (
  run: (host: Host) => Promise<void>,
  options: { piVersion?: string } = {},
): Promise<void> => {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "ptc-floor-fallback-"));
  writeFileSync(join(dir, "probe.txt"), "FLOOR-FALLBACK-OK\n");
  process.chdir(dir);
  const restorePi = fakePiOnPath(options.piVersion ?? "0.86.0");
  const host = floorHost();
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir({});
  try {
    entryDefault(host.fake as never);
    const handler = host.fake.handlers.session_start?.[0];
    if (!handler) throw new Error("entry 没注册 session_start");
    await handler({}, notifyCtx);
    expect(host.fake.registered["ptc_run_code"], "ptc_run_code 该注册").toBeDefined();
    await run(host);
  } finally {
    // entry 注册了两个 turn_end：先投递通知，后退役池里的 worker——收尾要把池排空，
    // 否则那个还活着的 worker 线程会拖住进程退出
    host.fake.handlers.turn_end?.forEach((cb) => cb());
    restorePi();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    process.chdir(original);
  }
};

const runProgram = async (
  host: Host,
  code: string,
  ...extra: unknown[]
): Promise<{ isError?: boolean; content: Array<{ text: string }> }> => {
  const tool = host.fake.registered["ptc_run_code"] as ToolDef;
  return (await tool.execute?.("call-1", { code, description: "floor 退回探针" }, ...extra)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
};

it("floor（无 executeTool 通道）：文件调用走 pi 自造的工具，读得到文件", async () => {
  await withFloorSession(async (host) => {
    const result = await runProgram(
      host,
      `const t = await tools.read({ path: "probe.txt" }); return t;`,
    );
    expect(result.isError, result.content[0]?.text).toBe(false);
    expect(result.content[0]!.text).toMatch(/FLOOR-FALLBACK-OK/);
  });
});

it("floor：edit 用 pi 的参数形状 {path, edits:[{oldText,newText}]}（不是我们文件绑定的 old_string/new_string）", async () => {
  await withFloorSession(async (host) => {
    const result = await runProgram(
      host,
      `const r = await tools.edit({ path: "probe.txt", edits: [{ oldText: "FLOOR", newText: "PARITY" }] });
       return r;`,
    );
    expect(result.isError, result.content[0]?.text).toBe(false);
    expect(result.content[0]!.text).toMatch(/replaced 1 block/);
    expect(readFileSync(join(process.cwd(), "probe.txt"), "utf8")).toBe("PARITY-FALLBACK-OK\n");
  });
});

it("现代 pi 上认不出通道：报错，不悄悄用自造工具绕过 pi 的工具管线", async () => {
  await withFloorSession(
    async (host) => {
      const result = await runProgram(
        host,
        `const t = await tools.read({ path: "probe.txt" }); return t;`,
      );
      expect(result.isError, "现代 pi 缺通道必须报错，不能静默降级").toBe(true);
      expect(result.content[0]!.text).toMatch(/没有程序内调用工具的通道/);
    },
    { piVersion: "1.4.0" },
  );
});
