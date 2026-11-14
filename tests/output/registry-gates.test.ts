// 册子门禁面（output，spec 决策 21 八条机械强制点 + 索引 token 硬顶 + 开关一致性 + 逐字节可重放）。
// routes 册子是模型面散文唯一出处——本文件守它不漂。
// 基准图：docs/prototypes/full-flow-anatomy.html ③索引注入 + ⑫任务面
// 锚点：docs/prototypes/dispatch-doors-flow.html 决策 21 行
// 探针直接打产物（packages/routes/dist、packages/entry/dist）——仓规：验的是发布物形态。
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  ROUTES,
  ROUTE_INDEX_TOKEN_CEILING,
  TOOLS,
  renderLongOutputGuidance,
  renderRouteIndex,
  renderTaskNotifications,
} from "../../packages/routes/dist/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const detailDir = join(repoRoot, "packages", "routes", "docs", "routes");
const routesText = JSON.stringify(ROUTES);
const toolNames = Object.keys(TOOLS);
const SURFACES = ["full_ptc", "codemode_ptc"];
// 预算按**真实安装路径**算：详情目录的绝对路径会进索引（出现一次），路径越长索引越大。
// 用短相对路径测会假绿——2026-11-01 实测：当时短路径 555 ✓ 而真实安装路径 625–632 都超 560
// ⇒ 模型每 turn 都吃到一行 > WARNING。门禁改用现实里最长的那种安装路径（100 字符，fnm 装法 + 长用户名）。
// shortcut: 超过 100 字符的安装路径（如 yarn-berry 的 zip 缓存 110 字符）会超预算（603 token），
// 那时削索引文案，别调高 ceiling
const REAL_DETAIL_BASE =
  "/Users/someone/.fnm/node-versions/v22.19.0/installation/lib/node_modules/pi-ptc-subagents/docs/routes";

it("机械点 1 工具→行：每个模型可见的工具至少被一条 route 提到", () => {
  for (const name of toolNames) {
    expect(routesText.includes(name), `工具 ${name} 没被任何 route 提到`).toBe(true);
  }
});

it("机械点 2 行→工具：route 里提到的工具名必须真实存在（白名单除外）", () => {
  // 白名单出处：pi_task_ptc = 程序内建任务 binding（ptc/task-binding.ts TASK_BINDING_NAME，不是注册工具）；
  // ptc_child_report / web_ds_search / doc_ds_ocr = 子代理进程侧工具（AGENTS.md 规矩节明文例外，不进宿主路由册）
  const WHITELIST = new Set(["pi_task_ptc", "ptc_child_report", "web_ds_search", "doc_ds_ocr"]);
  const mentioned = new Set(routesText.match(/(?:pi_task|ptc)_[a-z_]+/g) ?? []);
  for (const name of mentioned) {
    expect(
      toolNames.includes(name) || WHITELIST.has(name),
      `route 提到了不存在的工具/binding：${name}`,
    ).toBe(true);
  }
});

it("机械点 3 route 集完整：每条 route 在每个编排入口都有交代（how 两键齐全）", () => {
  for (const route of ROUTES) {
    expect(Object.keys(route.how).sort(), `route ${route.id} 的 how 缺编排入口`).toEqual([
      "codemode_ptc",
      "full_ptc",
    ]);
  }
});

it("机械点 4 索引 token 预算：ceiling 560 + 真实安装路径口径，超预算必须明说（> WARNING:）", () => {
  expect(ROUTE_INDEX_TOKEN_CEILING, "索引 token 上限是冻结值——调高它等于把守卫拆了").toBe(560);
  for (const surface of SURFACES) {
    const index = renderRouteIndex(surface, REAL_DETAIL_BASE, true);
    const tokens = Math.ceil(index.length / 2); // 与 registry.ts estimateTokens 同式
    expect(
      tokens,
      `${surface} 索引超预算：${tokens} > ${ROUTE_INDEX_TOKEN_CEILING}`,
    ).toBeLessThanOrEqual(ROUTE_INDEX_TOKEN_CEILING);
    // floor：索引不许退化成空壳
    const routeLines = index.split("\n").filter((l) => l.startsWith("- "));
    expect(routeLines.length, `${surface} 索引缺路由行`).toBe(ROUTES.length);
    expect(index.includes("路由表"), `${surface} 索引缺表头`).toBe(true);
    // WARNING 机制守卫：哪天册子真超了预算而 WARNING 被删，这条立刻红
    if (tokens > ROUTE_INDEX_TOKEN_CEILING) {
      expect(index.includes("> WARNING:"), "超预算渲染必须含 > WARNING:").toBe(true);
    }
  }
});

it("机械点 5 每行怎么调段非空：how 每面都要能回答「是什么/怎么调」", () => {
  for (const route of ROUTES) {
    for (const surface of SURFACES) {
      expect(
        route.how[surface].trim().length,
        `route ${route.id} 的 how.${surface} 为空`,
      ).toBeGreaterThan(0);
    }
  }
});

it("机械点 6 工具 description 必须是 registry 的调用（行为断言：假 pi 捕获注册，比对 TOOLS 输出）", async () => {
  const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
  const savedCwd = process.cwd();
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.chdir(mkdtempSync(join(tmpdir(), "ptc-registry-mech6-"))); // storageDir 落 tmp，别写仓库
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ptc-registry-agent-"));
  try {
    for (const surface of SURFACES) {
      const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
      let active = surface === "codemode_ptc" ? ["codemode"] : [];
      const registered: Record<string, { name: string; description: string }> = {};
      const fakePi = {
        on: (ev: string, cb: (event: unknown, ctx: unknown) => unknown) => {
          (handlers[ev] ??= []).push(cb);
        },
        registerTool: (def: { name: string; description: string }) => {
          registered[def.name] = def;
        },
        registerCommand: () => {},
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => {
          active = [...names];
        },
        getAllTools: () => [],
        sendMessage: () => {},
      };
      entryDefault(fakePi as never);
      await handlers.session_start?.[0]?.({}, { ui: { notify: () => {} } });
      const expected =
        surface === "full_ptc"
          ? [
              "ptc_run_code",
              "ptc_workflow",
              "ptc_task_list",
              "ptc_task_output",
              "ptc_task_stop",
              "ptc_progress_update",
            ]
          : [
              "pi_task_codemode",
              "ptc_task_list",
              "ptc_task_output",
              "ptc_task_stop",
              "ptc_progress_update",
            ];
      for (const name of expected) {
        expect(registered[name], `${surface} 未注册 ${name}`).toBeDefined();
        expect(
          registered[name]!.description,
          `${surface}/${name} 的 description 不是 registry 调用（散文漂移）`,
        ).toBe(TOOLS[name as keyof typeof TOOLS].description(surface));
      }
      // 反向断言：决策 28（一个面一个编排器）——不该注册的注册了就红
      if (surface === "full_ptc") {
        expect(
          registered["pi_task_codemode"],
          "full_ptc 不该注册 pi_task_codemode",
        ).toBeUndefined();
      } else {
        expect(registered["ptc_run_code"], "codemode_ptc 不该注册 ptc_run_code").toBeUndefined();
        expect(registered["ptc_workflow"], "codemode_ptc 不该注册 ptc_workflow").toBeUndefined();
      }
    }
  } finally {
    process.chdir(savedCwd);
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

it("机械点 7 索引每路一行 + detail 指针指向的文件真实存在且随包发布", () => {
  for (const surface of SURFACES) {
    const index = renderRouteIndex(surface, REAL_DETAIL_BASE, true);
    const routeLines = index.split("\n").filter((l) => l.startsWith("- "));
    expect(routeLines.length, `${surface} 路由行数不对`).toBe(ROUTES.length);
  }
  for (const route of ROUTES) {
    const file = join(detailDir, route.detail.split("/").pop()!);
    expect(existsSync(file), `detail 指针悬空：${route.detail}`).toBe(true);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  expect(
    (pkg.files ?? []).some((f: string) => f.startsWith("docs/routes")),
    "package.json files 缺 docs/routes——detail 指针解不到用户机器",
  ).toBe(true);
});

it("机械点 8 索引每 turn 字节相同：同输入渲染两次逐字节一致（surface × 总则句 × 进展开关矩阵）", () => {
  for (const surface of SURFACES) {
    for (const nudge of [true, false]) {
      for (const progressEnabled of [true, false]) {
        const a = renderRouteIndex(surface, REAL_DETAIL_BASE, nudge, progressEnabled);
        const b = renderRouteIndex(surface, REAL_DETAIL_BASE, nudge, progressEnabled);
        expect(
          a,
          `${surface}/nudge=${nudge}/progress=${progressEnabled} 渲染不确定——prompt cache 会废`,
        ).toBe(b);
      }
    }
  }
  // 同待遇：通知批渲染与超长产出引导语也确定
  const n1 = renderTaskNotifications([{ taskId: "t1", status: "succeeded" }]);
  expect(n1).toBe(renderTaskNotifications([{ taskId: "t1", status: "succeeded" }]));
  const g1 = renderLongOutputGuidance({ bytes: 99, reportChannel: "none" });
  expect(g1).toBe(renderLongOutputGuidance({ bytes: 99, reportChannel: "none" }));
});

it("开关一致性：进展更新 off 时索引不提未注册的工具（地图不说假话）", () => {
  for (const surface of SURFACES) {
    const on = renderRouteIndex(surface, REAL_DETAIL_BASE, true, true);
    const off = renderRouteIndex(surface, REAL_DETAIL_BASE, true, false);
    expect(on.includes("ptc_progress_update"), `${surface} on 态索引应提工具名`).toBe(true);
    expect(off.includes("ptc_progress_update"), `${surface} off 态索引不应提工具名`).toBe(false);
  }
});
