// 显示层探针（Slice 5 · 5 条能力 / 7 条 mutant）：
//   pi-render      PTC 工具折叠渲染：状态色 token、运行中标记、已截断提示
//   task-panel     常驻子代理状态面板：计数/字形/label 截断/会话过滤/正文清洗/卸载即消失
//   task-face      任务面折叠渲染（列表 + 产出）
//   progress-face  进展卡片（折叠/展开/省略/空兜底/开关两态）
//   no-skimp-banner 横幅开关两态
//
// 断言来源：搬（旧 node:test 探针，逐条搬）：render-status-color / task-panel / task-face-render /
//           progress-face-render / no-skimp-flags（横幅那部分）。
// 探针打产物（仓规）：packages/tui/dist/pi.js（pi 画面层）+ packages/{entry,routes}/dist/index.js。
// 假主题把颜色 token 写进文本 ⇒ 断言「哪个状态用了哪个颜色」不必依赖真主题。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import entryDefault from "../../packages/entry/dist/index.js";
import { TOOLS } from "../../packages/routes/dist/index.js";
import {
  MAX_PANEL_LABEL_CHARS,
  MAX_PANEL_ROWS,
  NO_SKIMP_BANNER_KEY,
  TASK_PANEL_KEY,
  createTaskPanel,
  excerptForDisplay,
  renderNoSkimpBanner,
  renderProgressFaceResult,
  renderPtcResult,
  renderTaskFaceResult,
  renderTaskPanel,
} from "../../packages/tui/dist/pi.js";
import { agentDir } from "../helpers/pi-harness.ts";

// 假主题：把颜色 token 写进文本，断言「哪个状态用了哪个颜色」而不必依赖真主题
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  style: (text: string, opts: { fg?: string; bold?: boolean }) =>
    `<${opts.fg ?? ""}${opts.bold ? "+bold" : ""}>${text}`,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── pi-render（搬：render-status-color） ────────────────────────────────────

const renderPtc = ({
  status = "fulfilled",
  isPartial = false,
  details = {},
}: {
  status?: string;
  isPartial?: boolean;
  details?: Record<string, unknown>;
} = {}): string => {
  const component = renderPtcResult("run_code")(
    {
      content: [{ type: "text", text: "OK" }],
      details: { status, ...details },
    } as never,
    { expanded: false, isPartial } as never,
    theme as never,
    { args: { description: "跑个程序" } },
  );
  return component.render(80).join("\n");
};

describe("pi-render", () => {
  it("三个终态各走自己的颜色 token", () => {
    expect(renderPtc({ status: "fulfilled" })).toMatch(/<success>fulfilled/);
    expect(renderPtc({ status: "rejected" })).toMatch(/<error>rejected/);
    expect(renderPtc({ status: "canceled" })).toMatch(/<warning>canceled/);
  });

  it("运行中给静态标记（accent ●），终态不给", () => {
    expect(renderPtc({ isPartial: true })).toMatch(/<accent>● /);
    expect(renderPtc({ isPartial: false })).not.toMatch(/<accent>/);
  });

  it("截断与全文路径标记走 muted", () => {
    const text = renderPtc({ details: { truncated: true, fullOutputPath: "/tmp/out.md" } });
    expect(text).toMatch(/<muted>已截断/);
    expect(text).toMatch(/<muted>全文在 \/tmp\/out\.md/);
  });
});

// ── task-panel（搬：task-panel） ───────────────────────────────────────────

const panelRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1",
  status: "running",
  task: "调研子代理方案",
  label: "调研方案",
  startedAt: Date.now(),
  ...overrides,
});

describe("task-panel", () => {
  it("没有进行中的任务 ⇒ 空数组（宿主据此卸载面板）", () => {
    expect(renderTaskPanel([], theme as never)).toEqual([]);
    expect(renderTaskPanel([panelRecord({ status: "succeeded" })], theme as never)).toEqual([]);
    expect(renderTaskPanel([panelRecord({ status: "failed" })], theme as never)).toEqual([]);
  });

  it("标题给出 running/succeeded/failed 三个计数", () => {
    const lines = renderTaskPanel(
      [
        panelRecord(),
        panelRecord({ id: "t2" }),
        panelRecord({ id: "t3", status: "succeeded" }),
        panelRecord({ id: "t4", status: "failed" }),
      ],
      theme as never,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/2 running/);
    expect(lines[0]).toMatch(/1 succeeded/);
    expect(lines[0]).toMatch(/1 failed/);
  });

  it("进行中的任务逐条列出，字形与颜色按状态走", () => {
    const lines = renderTaskPanel(
      [
        panelRecord(),
        panelRecord({ id: "t2", status: "queued", label: "排队中" }),
        panelRecord({ id: "t3", status: "stopping" }),
      ],
      theme as never,
    );
    expect(lines[1]).toMatch(/<accent>● 调研方案/);
    expect(lines[2]).toMatch(/<muted>○ 排队中/);
    expect(lines[3]).toMatch(/<warning>◐ /);
  });

  it("label 缺省退回 task 文本，且按冻结上限截断", () => {
    const long = "x".repeat(200);
    const lines = renderTaskPanel([panelRecord({ label: undefined, task: long })], theme as never);
    expect(lines[1]).toContain(`${"x".repeat(MAX_PANEL_LABEL_CHARS)}…`);
    expect(lines[1]).not.toContain("x".repeat(MAX_PANEL_LABEL_CHARS + 1));
  });

  it("空 label 也退回 task 文本（空串不是 nullish）", () => {
    const lines = renderTaskPanel([panelRecord({ label: "", task: "写测试" })], theme as never);
    expect(lines[1]).toMatch(/写测试/);
  });

  it("任务正文里的 ANSI 与换行不进终端", () => {
    // 正文是模型写的、常照抄用户的话：ANSI 会被终端执行，换行会被 pi-tui 拆成多行
    const lines = renderTaskPanel(
      [panelRecord({ label: undefined, task: "读 \x1b[2J 文件\n第二行" })],
      theme as never,
    );
    expect(lines[1]).not.toContain("\x1b"); // ANSI 不该进面板
    expect(lines[1]).not.toContain("\n"); // 正文里的换行不该把一行拆成两行
    expect(lines[1]).toMatch(/读 文件 第二行/);
  });

  it("超过面板行上限 ⇒ 收尾一行报还剩多少", () => {
    const many = Array.from({ length: MAX_PANEL_ROWS + 3 }, (_, i) => panelRecord({ id: `t${i}` }));
    const lines = renderTaskPanel(many, theme as never);
    expect(lines).toHaveLength(MAX_PANEL_ROWS + 2); // 标题 + 行 + 溢出行
    expect(lines[lines.length - 1]).toMatch(/3 more/);
    expect(lines.length).toBeLessThanOrEqual(8); // 面板自限 8 行（宿主上限 10 行）
  });

  it("widget key 是常量——同 key 覆盖才能保证 /reload 幂等", () => {
    expect(TASK_PANEL_KEY).toBe("ptc-tasks");
  });

  it("只算本会话的记录——历史会话的成功不进计数", () => {
    // 真机实测：registry 启动会恢复磁盘上的历史记录，标题一度写「succeeded 180」
    const lines = renderTaskPanel(
      [
        panelRecord({ status: "succeeded", sessionId: "old-session" }),
        panelRecord({ sessionId: "new-session" }),
      ],
      theme as never,
      "new-session",
    );
    expect(lines[0]).toMatch(/1 running/);
    expect(lines[0]).toMatch(/0 succeeded/);
  });

  it("接线：派一条任务 ⇒ 面板出现；任务落终态 ⇒ 面板消失", async () => {
    const calls: [string, unknown][] = [];
    const records: Record<string, unknown>[] = [];
    const registry = {
      list: () => records,
      subscribe: (listener: (next: unknown, prev: unknown) => void) => {
        registry.listener = listener;
      },
      listener: (_next: unknown, _prev: unknown) => {},
    };
    const panel = createTaskPanel({
      ui: {
        theme: theme as never,
        setWidget: (key: string, value: unknown) => calls.push([key, value]),
      },
      source: registry as never,
      sessionId: "s1",
    });
    const running = { id: "t1", status: "running", task: "写测试", sessionId: "s1" };
    records.push(running);
    registry.listener(running, null);
    expect(calls.at(-1)?.[0]).toBe(TASK_PANEL_KEY);
    const panelLines = calls.at(-1)?.[1] as string[] | undefined;
    expect(panelLines?.[0]).toMatch(/1 running/);
    records[0] = { ...running, status: "succeeded" };
    registry.listener(records[0] as never, running);
    expect(calls.at(-1)?.[1], "没有在飞任务 ⇒ 面板该被卸载").toBeUndefined();
    panel.dispose();
  });

  it("接线：没有 ui（print/json 模式）⇒ 什么都不画", async () => {
    const registry = {
      list: () => [] as Record<string, unknown>[],
      subscribe: () => {},
    };
    const panel = createTaskPanel({ source: registry as never, sessionId: "s1" });
    panel.dispose(); // 不抛就算过
  });

  it("接线：dispose 之后再来变迁 ⇒ 面板不再回来", async () => {
    const calls: [string, unknown][] = [];
    const registry = {
      list: () => [] as Record<string, unknown>[],
      subscribe: (listener: (next: unknown, prev: unknown) => void) => {
        registry.listener = listener;
      },
      listener: (_next: unknown, _prev: unknown) => {},
    };
    const panel = createTaskPanel({
      ui: {
        theme: theme as never,
        setWidget: (key: string, value: unknown) => calls.push([key, value]),
      },
      source: registry as never,
      sessionId: "s1",
    });
    panel.dispose();
    const before = calls.length;
    registry.listener({ id: "t1", status: "running", task: "写测试", sessionId: "s1" }, null);
    expect(calls.length, "卸载后不该再设 widget").toBe(before);
  });
});

// ── task-face（搬：task-face-render） ───────────────────────────────────────

const renderFace = (details: unknown, { expanded = false } = {}): string => {
  const component = renderTaskFaceResult(
    { content: [{ type: "text", text: '{"raw":"json"}' }], details },
    { expanded, isPartial: false } as never,
    theme as never,
  );
  return component.render(120).join("\n");
};

const listDetails = {
  kind: "list",
  scope: "recent",
  total: 14,
  listed: 14,
  inFlight: 2,
  rows: [
    { id: "t1", status: "running", label: "调研方案" },
    { id: "t2", status: "succeeded" },
  ],
};

describe("task-face", () => {
  it("列表折叠：给计数，不给行", () => {
    const text = renderFace(listDetails);
    expect(text).toMatch(/任务列表 · 14 条 · 2 在飞/);
    expect(text).not.toMatch(/调研方案/);
  });

  it("列表折叠：候选比列出的多时说还有多少未列", () => {
    expect(renderFace({ ...listDetails, total: 30 })).toMatch(/还有 16 条未列/);
  });

  it("列表展开：每行一个任务，字形与颜色走常驻面板那张表", () => {
    const text = renderFace(listDetails, { expanded: true });
    expect(text).toMatch(/<dim>t1/);
    expect(text).toMatch(/<accent>● running/);
    expect(text).toMatch(/<success>✓ succeeded/);
    expect(text).toMatch(/调研方案/);
  });

  it("列表展开：列出的条数多于显示的行数时明说省略", () => {
    expect(renderFace({ ...listDetails, listed: 20 }, { expanded: true })).toMatch(
      /…（共 20 条，省略 18 条）/,
    );
  });

  it("产出折叠：id + 状态；展开：正文摘录", () => {
    const details = {
      kind: "output",
      id: "t9",
      status: "succeeded",
      excerpt: "结论：可以发版",
      totalLines: 1,
    };
    expect(renderFace(details)).toMatch(/任务产出 · <dim>t9 · <success>✓ succeeded/);
    expect(renderFace(details, { expanded: true })).toMatch(/结论：可以发版/);
  });

  it("产出展开：正文为空时说无正文", () => {
    const details = { kind: "output", id: "t9", status: "failed", excerpt: "", totalLines: 0 };
    expect(renderFace(details, { expanded: true })).toMatch(/（无正文）/);
  });

  it("没有 details：显示原文（别把人看到的字弄丢）", () => {
    expect(renderFace(undefined)).toMatch(/"raw":"json"/);
  });

  it("excerptForDisplay：行数封顶 + 单行截断 + ANSI 清洗", () => {
    const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join("\n");
    const { excerpt, totalLines } = excerptForDisplay(many);
    expect(totalLines).toBe(30);
    expect(excerpt.split("\n")).toHaveLength(12);
    expect(excerptForDisplay("x".repeat(200)).excerpt).toHaveLength(121);
    expect(excerptForDisplay("\x1b[31m红\x1b[0m").excerpt).toBe("红");
  });

  it("接线：list 与 output 挂了 renderResult，stop 故意不挂", async () => {
    const host = createHost();
    const session = await startSession(host);
    try {
      expect(typeof host.tools.ptc_task_list?.renderResult).toBe("function");
      expect(typeof host.tools.ptc_task_output?.renderResult).toBe("function");
      // stop 的结果是三行 JSON，pi 的默认回退已经够读——故意不挂
      expect(host.tools.ptc_task_stop?.renderResult).toBeUndefined();
    } finally {
      session.cleanup();
    }
  });
});

// ── 宿主夹具（entry 侧接线：注册 / 开关 / 横幅 / 渲染接线） ───────────────────

type ToolDef = {
  name: string;
  description: string;
  renderResult?: unknown;
  execute?: (...a: unknown[]) => unknown;
};

interface Host {
  handlers: Record<string, ((...a: unknown[]) => unknown)[]>;
  tools: Record<string, ToolDef>;
  commands: Record<string, (args: string, ctx: unknown) => Promise<void> | void>;
  widgets: [string, unknown][];
  pi: unknown;
  ctx: unknown;
}

function createHost(options: { mode?: "tui" | "print"; active?: string[] } = {}): Host {
  const handlers: Host["handlers"] = {};
  const tools: Host["tools"] = {};
  const commands: Host["commands"] = {};
  const widgets: Host["widgets"] = [];
  const pi = {
    on: (event: string, cb: (...a: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(cb);
    },
    registerTool: (def: ToolDef) => {
      tools[def.name] = def;
    },
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> | void },
    ) => {
      commands[name] = def.handler;
    },
    getActiveTools: () => [...(options.active ?? [])],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
  };
  const ctx = {
    mode: options.mode ?? "print",
    ui: {
      notify: () => {},
      theme: { fg: (color: string, text: string) => `<${color}>${text}` },
      setWidget: (key: string, lines: unknown) => {
        widgets.push([key, lines]);
      },
    },
  };
  return { handlers, tools, commands, widgets, pi, ctx };
}

/** 跑一次 session_start：agent 目录与工作区都落 tmp（别读用户真配置、别往仓库写 .pi/） */
async function startSession(host: Host, config?: unknown): Promise<{ cleanup: () => void }> {
  const cwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir(config);
  process.chdir(mkdtempSync(join(tmpdir(), "ptc-render-ws-")));
  entryDefault(host.pi as never);
  await host.handlers.session_start?.[0]?.({}, host.ctx);
  return {
    cleanup: () => {
      host.handlers.turn_end?.forEach((cb) => cb());
      process.chdir(cwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}

// ── progress-face（搬：progress-face-render） ───────────────────────────────

const renderProgress = (details: unknown, { expanded = false } = {}): string => {
  const component = renderProgressFaceResult(
    { content: [{ type: "text", text: '"ok"' }], details },
    { expanded, isPartial: false } as never,
    theme as never,
  );
  return component.render(120).join("\n");
};

describe("progress-face", () => {
  it("折叠：头部一行（accent 加粗铬件 + dim 分隔 + 加粗标题），不给正文", () => {
    const text = renderProgress({
      title: "扫描了 20 个文件",
      excerpt: "接下来汇总",
      totalLines: 1,
    });
    expect(text).toMatch(/<accent\+bold>▸ 进展更新<dim> · <\+bold>扫描了 20 个文件/);
    expect(text).not.toMatch(/接下来汇总/);
  });

  it("展开：头部翻成 ▾，正文缩进两格，行数截断有省略说明", () => {
    const excerpt = Array.from({ length: 12 }, (_, i) => `第 ${i} 行`).join("\n");
    const text = renderProgress({ title: "t", excerpt, totalLines: 30 }, { expanded: true });
    expect(text).toMatch(/<accent\+bold>▾ 进展更新/);
    expect(text).toMatch(/第 11 行/);
    expect(text).toMatch(/…（共 30 行，省略 18 行）/);
  });

  it("空标题给占位；空正文展开说无正文", () => {
    expect(renderProgress({ title: "", excerpt: "x", totalLines: 1 })).toMatch(/（无标题）/);
    expect(renderProgress({ title: "t", excerpt: "", totalLines: 0 }, { expanded: true })).toMatch(
      /（无正文）/,
    );
  });

  it("没有 details：显示原文（别把人看到的字弄丢）", () => {
    expect(renderProgress(undefined)).toMatch(/"ok"/);
  });

  it("接线：双 surface 注册 + renderResult + ack/details 形状", async () => {
    for (const [active, surface] of [
      [[], "full_ptc"],
      [["codemode"], "codemode_ptc"],
    ] as [[string[]], string][]) {
      const host = createHost({ active });
      const session = await startSession(host);
      try {
        const def = host.tools.ptc_progress_update;
        expect(def, `${surface} 未注册 ptc_progress_update`).toBeDefined();
        expect(def?.description).toBe(TOOLS.ptc_progress_update.description(surface as never));
        expect(typeof def?.renderResult).toBe("function");
        const result = (await def?.execute?.("x", {
          title: "\x1b[31m红\x1b[0m",
          message: Array.from({ length: 30 }, (_, i) => `行 ${i}`).join("\n"),
        })) as { content: Array<{ text: string }>; details: Record<string, unknown> };
        expect(JSON.parse(result.content[0]?.text ?? "")).toBe("ok"); // 模型面只回 ack
        expect(result.details.title).toBe("红"); // title 清洗 ANSI
        expect((result.details.excerpt as string).split("\n")).toHaveLength(12);
        expect(result.details.totalLines).toBe(30);
      } finally {
        session.cleanup();
      }
    }
  });

  it("开关 PI_PTC_PROGRESS：off 态不注册，缺省开", async () => {
    const registeredFor = async (): Promise<Record<string, ToolDef>> => {
      const host = createHost();
      const session = await startSession(host);
      try {
        return host.tools;
      } finally {
        session.cleanup();
      }
    };
    vi.stubEnv("PI_PTC_PROGRESS", "");
    delete process.env.PI_PTC_PROGRESS;
    expect((await registeredFor()).ptc_progress_update, "缺省应注册（fail-open）").toBeDefined();
    for (const off of ["off", "0", "false"]) {
      vi.stubEnv("PI_PTC_PROGRESS", off);
      expect((await registeredFor()).ptc_progress_update, `${off} 应不注册`).toBeUndefined();
    }
    vi.stubEnv("PI_PTC_PROGRESS", "yes");
    expect((await registeredFor()).ptc_progress_update, "坏值应视为开").toBeDefined();
  });
});

// ── no-skimp-banner（搬：no-skimp-flags 的横幅部分） ─────────────────────────

describe("no-skimp-banner", () => {
  it("横幅渲染：两个开关都关 ⇒ 空数组（宿主据此卸载）", () => {
    expect(renderNoSkimpBanner({ noSkimpPtc: false, noSkimpSub: false }, theme as never)).toEqual(
      [],
    );
    expect(
      renderNoSkimpBanner({ noSkimpPtc: true, noSkimpSub: false }, theme as never).length,
    ).toBeGreaterThan(0);
  });

  it("TUI 横幅：开着常驻显示，关掉即卸载", async () => {
    const host = createHost({ mode: "tui" });
    const session = await startSession(host, { noSkimpPtc: true });
    try {
      const calls = (): [string, unknown][] =>
        host.widgets.filter(([key]) => key === NO_SKIMP_BANNER_KEY);
      expect(calls().length, "横幅 widget 应已登记").toBeGreaterThan(0);
      const bannerLines = calls()[0]?.[1] as string[] | undefined;
      expect(bannerLines?.join("\n")).toContain("double-edged sword");
      await host.commands.ptc?.("noskimp off", { ui: { notify: () => {} } });
      expect(calls().at(-1)?.[1], "关掉后横幅应卸载").toBeUndefined();
    } finally {
      session.cleanup();
    }
  });
});
