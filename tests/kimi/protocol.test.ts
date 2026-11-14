// Kimi 面 MCP 协议面：initialize / tools/list / tools/call / 错误形状 / 参数校验 / workdir 锁 + 程序五件套。
// 探针直接打产物（packages/kimi-mcp/dist/server.js 与 dist/index.js）——仓规：验的是发布物形态。
// server 是真 spawn 的子进程：每个用例起一个、用完 kill。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createFsBindings } from "../../packages/kimi-mcp/dist/index.js";
import { startMcpClient, type McpClient } from "../helpers/mcp-client.ts";

const SERVER = fileURLToPath(new URL("../../packages/kimi-mcp/dist/server.js", import.meta.url));

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
}

const textOf = (r: ToolResult) => r.content?.[0]?.text ?? "";

// 起一个隔离配置的 server：KIMI_CODE_HOME 指向空目录（用户真开着 noSkimpPtc 时描述会多一段），
// env 覆盖在 spawn 前落到 process.env——子进程继承。
async function withServer<T>(
  fn: (client: McpClient, init: { serverInfo: { name: string } }) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ptc-kimi-home-"));
  const saved: Record<string, string | undefined> = {
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  };
  process.env.KIMI_CODE_HOME = home;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const client = startMcpClient(SERVER);
  try {
    const init = (await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    })) as { serverInfo: { name: string } };
    client.notify("notifications/initialized");
    return await fn(client, init);
  } finally {
    client.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const call = (client: McpClient, name: string, args: unknown) =>
  client.request("tools/call", { name, arguments: args }) as Promise<ToolResult>;

it("MCP 握手：serverInfo 与三工具表", async () => {
  await withServer(async (client, init) => {
    expect(init.serverInfo.name).toBe("ptc-tools");

    const listed = (await client.request("tools/list")) as {
      tools: { name: string; description: string; inputSchema: { required: string[] } }[];
    };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "ptc_run_code",
      "web_ds_search",
      "doc_ds_ocr",
    ]);
    const runCode = listed.tools.find((tool) => tool.name === "ptc_run_code")!;
    expect(runCode.description).toContain("tools.<name>");
    expect(runCode.inputSchema.required).toEqual(["code", "description", "workdir"]);
    const ocr = listed.tools.find((tool) => tool.name === "doc_ds_ocr")!;
    expect(ocr.inputSchema.required).toEqual(["path", "workdir"]);
  });
});

it("tools/call 真跑程序：有工具调用时拼经济学 footer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-mcp-"));
  writeFileSync(join(dir, "a.txt"), "kimi-mcp-fixture");
  await withServer(async (client) => {
    const ok = await call(client, "ptc_run_code", {
      code: 'const t = await tools.read({ path: "a.txt" }); return "LEN=" + t.length;',
      description: "probe read",
      workdir: dir,
    });
    expect(ok.isError).toBe(false);
    expect(textOf(ok)).toContain(`LEN=${"kimi-mcp-fixture".length}`);
    expect(textOf(ok)).toContain("程序内 1 次工具调用，归约成这 1 次结果");
  });
});

it("tools/call 纯计算不拼 footer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-mcp-"));
  await withServer(async (client) => {
    const pure = await call(client, "ptc_run_code", {
      code: "return 1 + 1;",
      description: "probe pure",
      workdir: dir,
    });
    expect(pure.isError).toBe(false);
    expect(textOf(pure)).not.toContain("次工具调用");
  });
});

it("workdir 越界：程序失败走 isError 形状", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-mcp-"));
  await withServer(async (client) => {
    const jail = await call(client, "ptc_run_code", {
      code: 'await tools.read({ path: "/etc/passwd" }); return "unreachable";',
      description: "probe jail",
      workdir: dir,
    });
    expect(jail.isError).toBe(true);
    expect(textOf(jail)).toContain("escapes workdir");
  });
});

it("未知工具名落 isError", async () => {
  await withServer(async (client) => {
    const unknown = await call(client, "nope", {});
    expect(unknown.isError).toBe(true);
  });
});

it("参数校验：web_ds_search 缺 query/url、count 越界都拒", async () => {
  await withServer(async (client) => {
    const missingQuery = await call(client, "web_ds_search", { action: "search" });
    expect(missingQuery.isError).toBe(true);
    expect(textOf(missingQuery)).toContain("search 动作需要 query");

    const missingUrl = await call(client, "web_ds_search", { action: "open" });
    expect(missingUrl.isError).toBe(true);
    expect(textOf(missingUrl)).toContain("open 动作需要 url");

    const badCount = await call(client, "web_ds_search", {
      action: "search",
      query: "x",
      count: 99,
    });
    expect(badCount.isError).toBe(true);
    expect(textOf(badCount)).toContain("count 必须是 1–50");
  });
});

it("参数校验：doc_ds_ocr 缺 path/workdir 拒；越界路径在发请求前被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-ocr-"));
  writeFileSync(join(dir, "a.pdf"), "x");
  await withServer(async (client) => {
    const missingPath = await call(client, "doc_ds_ocr", { workdir: dir });
    expect(missingPath.isError).toBe(true);
    expect(textOf(missingPath)).toContain("path 必须是非空字符串");

    const missingWorkdir = await call(client, "doc_ds_ocr", { path: "a.pdf" });
    expect(missingWorkdir.isError).toBe(true);
    expect(textOf(missingWorkdir)).toContain("workdir 必须是非空字符串");

    const escaped = await call(client, "doc_ds_ocr", { path: "../a.pdf", workdir: dir });
    expect(escaped.isError).toBe(true);
    expect(textOf(escaped)).toContain("越出工作区");
  });
});

it("fail-soft：缺 key 时报可读错误而不是崩 server", async () => {
  await withServer(
    async (client) => {
      const noKey = await call(client, "web_ds_search", { action: "search", query: "kimi" }).catch(
        () => undefined,
      );
      // 离线时传输层就失败（拿不到 isError）；在线时必须是可读错误而不是崩 server
      if (noKey) expect(noKey.isError).toBe(true);
      const alive = (await client.request("tools/list")) as { tools: unknown[] };
      expect(alive.tools.length).toBe(3);
    },
    { DEEPSEEK_API_KEY: "" },
  );
});

it("fail-soft：注释掉的 api_key 视为停用", async () => {
  const home = mkdtempSync(join(tmpdir(), "ptc-commented-home-"));
  writeFileSync(
    join(home, "config.toml"),
    '[providers.DeepSeek]\ntype = "openai"\n# api_key = "sk-stale-disabled"\n',
  );
  const saved = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "";
  try {
    await withServer(async (client) => {
      const commented = await call(client, "web_ds_search", {
        action: "search",
        query: "kimi",
      }).catch(() => undefined);
      if (commented) expect(commented.isError).toBe(true);
      const alive = (await client.request("tools/list")) as { tools: unknown[] };
      expect(alive.tools.length).toBe(3);
    });
  } finally {
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
  }
});

// ---- 程序五件套（Kimi 面的文件面；workdir 是信任边界） ----

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-fs-"));
  writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.txt"), "hello again\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.txt"), "hello from dep\n");
  return dir;
}

const callBinding = (binding: (args: unknown, ctx: never) => Promise<unknown>, args: unknown) =>
  binding(args, { cwd: process.cwd(), emitImage: () => {} } as never);

it("五件套 read：读出文件内容（string）", async () => {
  const dir = fixture();
  const text = await callBinding(createFsBindings(dir).read, { path: "a.txt" });
  expect(text).toBe("hello\nworld\n");
});

it("五件套 read：workdir 越界（/etc/passwd）即拒", async () => {
  const dir = fixture();
  await expect(callBinding(createFsBindings(dir).read, { path: "/etc/passwd" })).rejects.toThrow(
    /escapes workdir/,
  );
});

it("五件套 read：符号链接逃逸即拒（realpath 判定）", async () => {
  const dir = fixture();
  symlinkSync("/etc", join(dir, "etc-link"));
  await expect(
    callBinding(createFsBindings(dir).read, { path: "etc-link/passwd" }),
  ).rejects.toThrow(/escapes workdir/);
});

it("五件套 grep：命中给 file:line: content，跳过 node_modules", async () => {
  const dir = fixture();
  const hits = (await callBinding(createFsBindings(dir).grep, { pattern: "hello" })) as string[];
  const joined = hits.join("\n");
  expect(joined).toMatch(/a\.txt:1: hello/);
  expect(joined).toMatch(/sub\/c\.txt:1: hello again/);
  expect(joined).not.toContain("node_modules");
});

it("五件套 grep：非法正则即报错", async () => {
  const dir = fixture();
  await expect(callBinding(createFsBindings(dir).grep, { pattern: "(" })).rejects.toThrow(
    /invalid pattern/,
  );
});

it("五件套 glob：按模式列出（绝对路径 jail 内）", async () => {
  const dir = fixture();
  const found = (await callBinding(createFsBindings(dir).glob, {
    pattern: "**/*.txt",
  })) as string[];
  expect(found).toContain("a.txt");
  expect(found).toContain(join("sub", "c.txt"));
});

it("五件套 grep：path 给单个文件时只搜它（不 ENOTDIR）", async () => {
  const dir = fixture();
  const hits = (await callBinding(createFsBindings(dir).grep, {
    pattern: "world",
    path: "a.txt",
  })) as string[];
  expect(hits).toEqual(["a.txt:2: world"]);
});

it("五件套 grep：单个文件读不动（权限 000）跳过、其它命中照给", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "locked.txt"), "hello locked\n", { mode: 0o000 });
  chmodSync(join(dir, "locked.txt"), 0o000);
  const hits = (await callBinding(createFsBindings(dir).grep, { pattern: "hello" })) as string[];
  const joined = hits.join("\n");
  expect(joined).toMatch(/a\.txt:1: hello/);
  expect(joined).toMatch(/sub\/c\.txt:1: hello again/);
});

it("五件套 createFsBindings：workdir 不存在报人话（不是裸 errno）", () => {
  expect(() => createFsBindings("/nonexistent-ptc-workdir-xyz")).toThrow(/workdir 不存在或不可达/);
});

it("五件套 edit：唯一匹配替换成功，原文件真的变了", async () => {
  const dir = fixture();
  const result = (await callBinding(createFsBindings(dir).edit, {
    path: "a.txt",
    old_string: "world",
    new_string: "kimi",
  })) as { edited: string };
  expect(result.edited).toBe("a.txt");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello\nkimi\n");
});

it("五件套 edit：零匹配与多匹配都拒（不猜、不动文件）", async () => {
  const dir = fixture();
  const edit = createFsBindings(dir).edit;
  await expect(
    callBinding(edit, { path: "a.txt", old_string: "nope", new_string: "x" }),
  ).rejects.toThrow(/old_string not found/);
  writeFileSync(join(dir, "multi.txt"), "dup dup");
  await expect(
    callBinding(edit, { path: "multi.txt", old_string: "dup", new_string: "x" }),
  ).rejects.toThrow(/must be unique/);
  expect(readFileSync(join(dir, "multi.txt"), "utf8")).toBe("dup dup");
});

it("五件套 write：新文件写入 + 覆写已存在", async () => {
  const dir = fixture();
  const first = (await callBinding(createFsBindings(dir).write, {
    path: "sub/new.txt",
    content: "fresh\n",
  })) as { written: string };
  expect(first.written).toBe("sub/new.txt");
  expect(readFileSync(join(dir, "sub", "new.txt"), "utf8")).toBe("fresh\n");
  const second = (await callBinding(createFsBindings(dir).write, {
    path: "a.txt",
    content: "replaced\n",
  })) as { written: string };
  expect(second.written).toBe("a.txt");
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("replaced\n");
});

it("五件套 write：父目录不存在即拒（不隐式 mkdir），越界即拒", async () => {
  const dir = fixture();
  await expect(
    callBinding(createFsBindings(dir).write, { path: "deep/nested/x.txt", content: "x" }),
  ).rejects.toThrow(/parent dir does not exist/);
  await expect(
    callBinding(createFsBindings(dir).write, { path: "/etc/ptc-kimi-jail-probe", content: "x" }),
  ).rejects.toThrow(/escapes workdir/);
  expect(existsSync("/etc/ptc-kimi-jail-probe")).toBe(false);
});
