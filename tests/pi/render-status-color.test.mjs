// pi 折叠渲染的状态色与运行中标记（packages/tui/src/pi/render.ts）
// 假主题把颜色 token 写进文本（同 task-panel.test.mjs 口径）⇒ 断言「哪个状态用了哪个颜色」不必依赖真主题
import test from "node:test";
import assert from "node:assert/strict";
import { renderPtcResult } from "../../packages/tui/dist/pi.js";

const theme = { fg: (color, text) => `<${color}>${text}` };

function render({ status = "fulfilled", isPartial = false, details = {} } = {}) {
  const component = renderPtcResult("run_code")(
    { content: [{ type: "text", text: "OK" }], details: { status, ...details } },
    { expanded: false, isPartial },
    theme,
    { args: { description: "跑个程序" } },
  );
  return component.render(80).join("\n");
}

test("三个终态各走自己的颜色 token", () => {
  assert.match(render({ status: "fulfilled" }), /<success>fulfilled/);
  assert.match(render({ status: "rejected" }), /<error>rejected/);
  assert.match(render({ status: "canceled" }), /<warning>canceled/);
});

test("运行中给静态标记（accent ●），终态不给", () => {
  assert.match(render({ isPartial: true }), /<accent>● /);
  assert.doesNotMatch(render({ isPartial: false }), /<accent>/);
});

test("截断与全文路径标记走 muted", () => {
  const text = render({ details: { truncated: true, fullOutputPath: "/tmp/out.md" } });
  assert.match(text, /<muted>已截断/);
  assert.match(text, /<muted>全文在 \/tmp\/out\.md/);
});
