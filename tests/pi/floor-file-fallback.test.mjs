// floor（0.86/0.87）没有嵌套调用通道时，程序自己造出 pi 的真工具来调
// （pi 的 create*ToolDefinition 是公开导出，execute 独立于 agent 循环）——老版本的程序工具
// 与 ≥0.99 逐字同形：同一批工具、同一套参数形状（edit 是 {path, edits}）
//
// 版本门：自造工具这条路只对 <0.99 开放（现代 pi 上认不出通道是异常 ⇒ 报错，不悄悄绕过
// pi 的工具管线）。入口的 pi 版本来自 `pi --version` ⇒ 用 PATH 上的假 pi 脚本控版本。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entryDefault from "../../packages/entry/dist/index.js";

// floor 实测：活跃表只有扩展自己的工具；内置工具只在 getAllTools 里
function harness({
  active = ["zz_probe"],
  all = ["read", "write", "edit", "grep", "find", "ls", "bash"],
} = {}) {
  const handlers = {};
  const registered = {};
  const fakePi = {
    on: (ev, cb) => {
      (handlers[ev] ??= []).push(cb);
    },
    registerTool: (def) => {
      registered[def.name] = def;
    },
    registerCommand: () => {},
    getActiveTools: () => [...active],
    setActiveTools: () => {},
    getAllTools: () => all.map((name) => ({ name })),
    sendMessage: () => {},
  };
  entryDefault(fakePi);
  return { handlers, registered };
}

// entry 注册了两个 turn_end：先投递通知，后退役池里的 worker——收尾要把池排空，
// 否则那个还活着的 worker 线程会拖住 node --test 的进程退出
const drainPool = (h) => h.handlers.turn_end.forEach((cb) => cb());

// 假 pi 放在 PATH 最前：entry 在 session_start 里跑 `pi --version` 取版本
function fakePiOnPath(version) {
  const bin = mkdtempSync(join(tmpdir(), "ptc-fake-pi-"));
  writeFileSync(join(bin, "pi"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => {
    process.env.PATH = saved;
  };
}

async function withSession(run, options) {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "ptc-floor-fallback-"));
  writeFileSync(join(dir, "probe.txt"), "FLOOR-FALLBACK-OK\n");
  writeFileSync(join(dir, "other.txt"), "second\n");
  process.chdir(dir);
  const restorePi = fakePiOnPath(options?.piVersion ?? "0.86.0");
  const h = harness(options);
  try {
    await h.handlers.session_start[0]({}, { ui: { notify: () => {} } });
    assert.ok(h.registered.ptc_run_code, "ptc_run_code 该注册");
    await run(h);
  } finally {
    drainPool(h);
    restorePi();
    process.chdir(original);
  }
}

const runProgram = (h, code, ...extra) =>
  h.registered.ptc_run_code.execute("call-1", { code, description: "floor 退回探针" }, ...extra);

test("floor（无 executeTool 通道）：文件调用走 pi 自造的工具，读得到文件", async () => {
  await withSession(async (h) => {
    const result = await runProgram(
      h,
      `const t = await tools.read({ path: "probe.txt" }); return t;`,
    );
    assert.equal(result.isError, false, "程序读到了文件，不该是错误");
    assert.match(result.content[0].text, /FLOOR-FALLBACK-OK/);
  });
});

test("floor：ls 可用（pi 自造的工具，与 ≥0.99 同一个）", async () => {
  await withSession(async (h) => {
    const result = await runProgram(
      h,
      `const entries = await tools.ls({ path: "." }); return entries;`,
    );
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /probe\.txt/);
  });
});

test("floor：edit 用 pi 的参数形状 {path, edits:[{oldText,newText}]}（不是我们文件绑定的 old_string/new_string）", async () => {
  await withSession(async (h) => {
    const result = await runProgram(
      h,
      `const r = await tools.edit({ path: "probe.txt", edits: [{ oldText: "FLOOR", newText: "PARITY" }] });
       return r;`,
    );
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /replaced 1 block/);
    assert.equal(readFileSync(join(process.cwd(), "probe.txt"), "utf8"), "PARITY-FALLBACK-OK\n");
  });
});

test("floor：edits 传单个对象也过——prepareArguments 垫片把它包成数组", async () => {
  await withSession(async (h) => {
    const result = await runProgram(
      h,
      `const r = await tools.edit({ path: "probe.txt", edits: { oldText: "FLOOR", newText: "PAD" } });
       return r;`,
    );
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /replaced 1 block/);
    assert.equal(readFileSync(join(process.cwd(), "probe.txt"), "utf8"), "PAD-FALLBACK-OK\n");
  });
});

test("现代 pi 上认不出通道：报错，不悄悄用自造工具绕过 pi 的工具管线", async () => {
  await withSession(
    async (h) => {
      const result = await runProgram(
        h,
        `const t = await tools.read({ path: "probe.txt" }); return t;`,
      );
      assert.equal(result.isError, true, "现代 pi 缺通道必须报错，不能静默降级");
      assert.match(result.content[0].text, /没有程序内调用工具的通道/);
    },
    { piVersion: "1.4.0" },
  );
});

test("有通道的版本：仍走 pi 会话工具，自造工具不接管", async () => {
  const active = ["read", "write", "edit", "grep", "find", "ls", "bash"];
  await withSession(
    async (h) => {
      const calls = [];
      const ctx = {
        executeTool: async (name, args) => {
          calls.push({ name, args });
          return { result: { content: [{ type: "text", text: "FROM-PI" }] } };
        },
      };
      const result = await runProgram(
        h,
        `const t = await tools.read({ path: "probe.txt" }); return t;`,
        ctx,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "read");
      assert.match(result.content[0].text, /FROM-PI/);
      assert.doesNotMatch(result.content[0].text, /FLOOR-FALLBACK-OK/);
    },
    { active, piVersion: "1.4.0" },
  );
});
