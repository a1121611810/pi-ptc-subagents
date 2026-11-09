// 进展更新的 pi 折叠渲染（packages/tui/src/pi/progress-face.ts）+ 接线与开关
// 假主题把颜色 token 写进文本（同 task-face-render.test.mjs 口径）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProgressFaceResult } from "../../packages/tui/dist/pi.js";
import { TOOLS } from "../../packages/routes/dist/index.js";

// 隔离 agent 目录与工作区：别读用户全局配置、别往仓库里写 .pi/ptc-tasks
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-progress-face-agent-"));
process.chdir(mkdtempSync(join(tmpdir(), "ptc-progress-face-ws-")));

const theme = {
  fg: (color, text) => `<${color}>${text}`,
  style: (text, opts) => `<${opts.fg ?? ""}${opts.bold ? "+bold" : ""}>${text}`,
};

function render(details, { expanded = false } = {}) {
  const component = renderProgressFaceResult(
    { content: [{ type: "text", text: '"ok"' }], details },
    { expanded, isPartial: false },
    theme,
  );
  return component.render(120).join("\n");
}

test("折叠：头部一行（accent 加粗铬件 + dim 分隔 + 加粗标题），不给正文", () => {
  const text = render({ title: "扫描了 20 个文件", excerpt: "接下来汇总", totalLines: 1 });
  assert.match(text, /<accent\+bold>▸ 进展更新<dim> · <\+bold>扫描了 20 个文件/);
  assert.doesNotMatch(text, /接下来汇总/);
});

test("展开：头部翻成 ▾，正文缩进两格，行数截断有省略说明", () => {
  const excerpt = Array.from({ length: 12 }, (_, i) => `第 ${i} 行`).join("\n");
  const text = render({ title: "t", excerpt, totalLines: 30 }, { expanded: true });
  assert.match(text, /<accent\+bold>▾ 进展更新/);
  assert.match(text, /第 11 行/);
  assert.match(text, /…（共 30 行，省略 18 行）/);
});

test("空标题给占位；空正文展开说无正文", () => {
  assert.match(render({ title: "", excerpt: "x", totalLines: 1 }), /（无标题）/);
  assert.match(
    render({ title: "t", excerpt: "", totalLines: 0 }, { expanded: true }),
    /（无正文）/,
  );
});

test("没有 details：显示原文（别把人看到的字弄丢）", () => {
  assert.match(render(undefined), /"ok"/);
});

// 接线：注册、description 出自册子、结果只回 ack（正文走 details 摘录）
test("接线：双 surface 注册 + renderResult + ack/details 形状", async () => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  for (const [active, surface] of [
    [[], "full_ptc"],
    [["codemode"], "codemode_ptc"],
  ]) {
    const handlers = {};
    const registered = {};
    const pi = {
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
      },
      registerTool: (def) => {
        registered[def.name] = def;
      },
      registerCommand: () => {},
      getActiveTools: () => [...active],
      setActiveTools: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    };
    entryDefault(pi);
    await handlers.session_start[0]({}, { mode: "print", ui: { notify: () => {} } });
    const def = registered.ptc_progress_update;
    assert.ok(def, `${surface} 未注册 ptc_progress_update`);
    assert.equal(def.description, TOOLS.ptc_progress_update.description(surface));
    assert.equal(typeof def.renderResult, "function");
    const result = await def.execute("x", {
      title: "\x1b[31m红\x1b[0m",
      message: Array.from({ length: 30 }, (_, i) => `行 ${i}`).join("\n"),
    });
    assert.equal(JSON.parse(result.content[0].text), "ok", "模型面只回 ack");
    assert.equal(result.details.title, "红", "title 清洗 ANSI");
    assert.equal(result.details.excerpt.split("\n").length, 12, "excerpt 吃行数上限");
    assert.equal(result.details.totalLines, 30);
  }
});

// 开关：PI_PTC_PROGRESS=off/0/false 不注册（从模型面前消失，而非 no-op）；缺省/坏值开
test("开关 PI_PTC_PROGRESS：off 态不注册，缺省开", async () => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  const registeredFor = async () => {
    const handlers = {};
    const registered = {};
    entryDefault({
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
      },
      registerTool: (def) => {
        registered[def.name] = def;
      },
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    });
    await handlers.session_start[0]({}, { mode: "print", ui: { notify: () => {} } });
    return registered;
  };
  const previous = process.env.PI_PTC_PROGRESS;
  try {
    delete process.env.PI_PTC_PROGRESS;
    assert.ok((await registeredFor()).ptc_progress_update, "缺省应注册（fail-open）");
    for (const off of ["off", "0", "false"]) {
      process.env.PI_PTC_PROGRESS = off;
      assert.ok(!(await registeredFor()).ptc_progress_update, `${off} 应不注册`);
    }
    process.env.PI_PTC_PROGRESS = "yes";
    assert.ok((await registeredFor()).ptc_progress_update, "坏值应视为开");
  } finally {
    if (previous === undefined) delete process.env.PI_PTC_PROGRESS;
    else process.env.PI_PTC_PROGRESS = previous;
  }
});
