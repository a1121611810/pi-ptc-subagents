// spec 决策 21 八条机械强制点门禁（audit F4）——routes 册子是模型面散文唯一出处，本文件守它不漂
// 基准图：docs/prototypes/full-flow-anatomy.html ③索引注入 + ⑫任务面
// 锚点：docs/prototypes/dispatch-doors-flow.html 决策 21 行
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ROUTES,
  ROUTE_INDEX_TOKEN_CEILING,
  TOOLS,
  renderLongOutputGuidance,
  renderRouteIndex,
  renderTaskNotifications,
} from "../packages/routes/dist/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const detailDir = join(repoRoot, "packages", "routes", "docs", "routes");
const routesText = JSON.stringify(ROUTES);
const toolNames = Object.keys(TOOLS);
const SURFACES = ["full_ptc", "codemode_ptc"];

test("机械点 1 工具→行：每个模型可见的工具至少被一条 route 提到", () => {
  for (const name of toolNames) {
    assert.ok(routesText.includes(name), `工具 ${name} 没被任何 route 提到`);
  }
});

test("机械点 2 行→工具：route 里提到的工具名必须真实存在（白名单除外）", () => {
  // 白名单出处：pi_task_ptc = 程序内建任务 binding（ptc/task-binding.ts TASK_BINDING_NAME，不是注册工具）；
  // ptc_child_report / web_ds_search = 子代理进程侧工具（AGENTS.md 规矩节明文例外，不进宿主路由册）
  const WHITELIST = new Set(["pi_task_ptc", "ptc_child_report", "web_ds_search"]);
  const mentioned = new Set(routesText.match(/(?:pi_task|ptc)_[a-z_]+/g) ?? []);
  for (const name of mentioned) {
    assert.ok(
      toolNames.includes(name) || WHITELIST.has(name),
      `route 提到了不存在的工具/binding：${name}`,
    );
  }
});

test("机械点 3 route 集完整：每条 route 在每个编排入口都有交代（how 两键齐全）", () => {
  for (const route of ROUTES) {
    assert.deepEqual(
      Object.keys(route.how).sort(),
      ["codemode_ptc", "full_ptc"],
      `route ${route.id} 的 how 缺编排入口`,
    );
  }
});

test("机械点 4 索引 token 预算：ceiling + floor，超预算必须明说（> WARNING:）", () => {
  for (const surface of SURFACES) {
    const index = renderRouteIndex(surface, "docs/routes", true);
    const tokens = Math.ceil(index.length / 2); // 与 registry.ts estimateTokens 同式
    assert.ok(
      tokens <= ROUTE_INDEX_TOKEN_CEILING,
      `${surface} 索引超预算：${tokens} > ${ROUTE_INDEX_TOKEN_CEILING}`,
    );
    // floor：索引不许退化成空壳
    const routeLines = index.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(routeLines.length, ROUTES.length, `${surface} 索引缺路由行`);
    assert.ok(index.includes("路由表"), `${surface} 索引缺表头`);
    // WARNING 机制守卫：哪天册子真超了预算而 WARNING 被删，这条立刻红
    if (tokens > ROUTE_INDEX_TOKEN_CEILING) {
      assert.ok(index.includes("> WARNING:"), "超预算渲染必须含 > WARNING:");
    }
  }
});

test("机械点 5 每行事实段非空：fact 与 how 每面都要能回答「是什么/怎么调」", () => {
  for (const route of ROUTES) {
    assert.ok(route.fact.trim().length > 0, `route ${route.id} 的 fact 为空`);
    for (const surface of SURFACES) {
      assert.ok(route.how[surface].trim().length > 0, `route ${route.id} 的 how.${surface} 为空`);
    }
  }
});

test("机械点 6 工具 description 必须是 registry 的调用（行为断言：假 pi 捕获注册，比对 TOOLS 输出）", async () => {
  const { default: entryDefault } = await import("../packages/entry/dist/index.js");
  process.chdir(mkdtempSync(join(tmpdir(), "gates-mech6-"))); // storageDir 落 tmp，别写仓库
  for (const surface of SURFACES) {
    const handlers = {};
    let active = surface === "codemode_ptc" ? ["codemode"] : [];
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
      setActiveTools: (names) => {
        active = [...names];
      },
      getAllTools: () => [],
      sendMessage: () => {},
    };
    entryDefault(fakePi);
    await handlers.session_start[0]({}, { ui: { notify: () => {} } });
    const expected =
      surface === "full_ptc"
        ? ["ptc_run_code", "ptc_workflow", "ptc_task_list", "ptc_task_output", "ptc_task_stop"]
        : ["pi_task_codemode", "ptc_task_list", "ptc_task_output", "ptc_task_stop"];
    for (const name of expected) {
      assert.ok(registered[name], `${surface} 未注册 ${name}`);
      assert.equal(
        registered[name].description,
        TOOLS[name].description(surface),
        `${surface}/${name} 的 description 不是 registry 调用（散文漂移）`,
      );
    }
  }
});

test("机械点 7 索引每路一行 + detail 指针指向的文件真实存在且随包发布", () => {
  for (const surface of SURFACES) {
    const index = renderRouteIndex(surface, "docs/routes", true);
    const routeLines = index.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(routeLines.length, ROUTES.length, `${surface} 路由行数不对`);
  }
  for (const route of ROUTES) {
    const file = join(detailDir, route.detail.split("/").pop());
    assert.ok(existsSync(file), `detail 指针悬空：${route.detail}`);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    (pkg.files ?? []).some((f) => f.startsWith("docs/routes")),
    "package.json files 缺 docs/routes——detail 指针解不到用户机器",
  );
});

test("机械点 8 索引每 turn 字节相同：同输入渲染两次逐字节一致（surface × 总则句开关矩阵）", () => {
  for (const surface of SURFACES) {
    for (const nudge of [true, false]) {
      const a = renderRouteIndex(surface, "docs/routes", nudge);
      const b = renderRouteIndex(surface, "docs/routes", nudge);
      assert.equal(a, b, `${surface}/nudge=${nudge} 渲染不确定——prompt cache 会废`);
    }
  }
  // 同待遇：通知批渲染与超长产出引导语也确定
  const n1 = renderTaskNotifications([{ taskId: "t1", status: "succeeded" }]);
  assert.equal(n1, renderTaskNotifications([{ taskId: "t1", status: "succeeded" }]));
  const g1 = renderLongOutputGuidance({ bytes: 99, reportChannel: "none" });
  assert.equal(g1, renderLongOutputGuidance({ bytes: 99, reportChannel: "none" }));
});
