import { formatSkillsForPrompt, getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  NotificationCenter,
  agentNameGate,
  agentResolveGate,
  depthGate,
  dispatchEnabledGate,
  findAgent,
  readOnlyGate,
  sessionEndingGate,
} from "@pi-ptc/dispatch";
import { fileURLToPath } from "node:url";
import {
  createDeepSeekProvider,
  createSearchMemory,
  createSearchQuota,
  createWebDsSearchTool,
} from "@pi-ptc/search";
import {
  createPtcRunCodeTool,
  createPtcWorkflowTool,
  createTaskBinding,
  KNOWN_BINDING_NAMES,
  resolveBindingNames,
  TASK_BINDING_NAME,
  TASK_DOOR_PARAMETERS,
  WorkerPool,
  spawnPtcWorker,
  type BindingTable,
} from "@pi-ptc/ptc";
import {
  TOOLS,
  renderLongOutputGuidance,
  renderRouteIndex,
  renderTaskNotifications,
  type SurfaceMode,
} from "@pi-ptc/routes";
import { TRUNCATION_MAX_BYTES, applyAdr0015Truncation } from "@pi-ptc/tui";
import { assemblePtcSession, type PtcSession } from "./session.ts";

export { assemblePtcSession } from "./session.ts";
export type {
  CreateTaskResult,
  DispatchOutcome,
  Gate,
  PtcSession,
  TaskHandle,
  TaskRejection,
} from "./session.ts";

const textResult = (value: unknown): AgentToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  details: undefined,
});

// pi 版本能力矩阵与 <0.99.0 floor 的运行时差异：docs/pi-version-matrix.md
export default function piPtcEntry(pi: ExtensionAPI): void {
  // ADR-0035：注册发生在 session_start——此刻 getActiveTools() 可用且 trust 已应用；factory 阶段它们是 throw 的桩
  pi.on("session_start", (_event, ctx) => {
    // 子代理进程（depth>0）：只注册 child_report 工具（ADR-0032 工具通道），不做任何宿主侧装配
    if (Number(process.env.PI_PTC_DEPTH ?? 0) > 0) {
      registerChildToolsOnly(pi);
      return;
    }
    // ADR-0035/0051：surface 直接问 pi——codemode 进了模型活跃表 = codemode_ptc；否则 full_ptc
    const surface: SurfaceMode = pi.getActiveTools().includes("codemode")
      ? "codemode_ptc"
      : "full_ptc";
    // ADR-0010 PTC 模式：full_ptc + 开关 + 工具可用（--tools 限制会话不在活跃表 → 不进）→ 收窄 loadout
    // 收窄目标 = 内置绑定工具：模型只能程序内 tools.* 调它们，写程序成为最顺的路
    let modeEnabled = readDefaultModeConfig(getAgentDir());
    let modeActive = false;
    let baseLoadout: string[] | null = null;
    const applyMode = () => {
      const active = pi.getActiveTools();
      const shouldEnter = surface === "full_ptc" && modeEnabled && active.includes("ptc_run_code");
      if (shouldEnter && !modeActive) {
        baseLoadout ??= [...active];
        pi.setActiveTools(
          active.filter((name) => !(KNOWN_BINDING_NAMES as readonly string[]).includes(name)),
        );
        modeActive = true;
      } else if (!shouldEnter && modeActive && baseLoadout) {
        pi.setActiveTools(baseLoadout);
        baseLoadout = null;
        modeActive = false;
      }
    };
    applyMode();
    // ADR-0061：<ptc> 常驻索引进系统提示词；渲染输入只有静态册子 + surface，每 turn 字节相同（决策 25）
    // ADR-0011 skills 补偿：收窄会触发 pi 丢 skills 节（只在 read/bash 可见时生成）——模式在且二者不可直调时自己写回（indirect 加载句）
    pi.on("before_agent_start", (event) => {
      applyMode(); // pi 可能在 session_start 后重置活跃表——每 turn 开头重新收敛
      event.systemPromptOptions.sections["ptc"] = renderRouteIndex(surface);
      if (!modeActive) return;
      const active = pi.getActiveTools();
      if (active.includes("read") || active.includes("bash")) return;
      const loaded = loadSkills({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        skillPaths: [],
        includeDefaults: true,
      });
      if (loaded.skills.length === 0) return;
      event.systemPromptOptions.sections["available_skills"] = formatSkillsForPrompt(
        loaded.skills,
        "indirect",
      );
    });
    const pool = new WorkerPool(spawnPtcWorker);
    const notifications = new NotificationCenter();
    // ADR-0022：终态事件进待投递队列（engine 的 wait 路径记 awaited 不通知）；turn 边界批投递
    pi.on("turn_end", () => {
      for (const batch of notifications.drain()) {
        const text = renderTaskNotifications(batch);
        pi.sendMessage(
          { customType: "bg-task-notifications", content: text, display: true },
          { deliverAs: "nextTurn" },
        );
      }
    });
    // ADR-0050/0065：dispatchEnabled 独立于 mode；会话结束位置位（gate 读谓词）
    let dispatchEnabled = true;
    let sessionEnding = false;
    let whyEnabledOverride: boolean | null = null;
    const whyEnabledPersisted = readWhyEnabledConfig(getAgentDir());
    const agentDirs = {
      userDir: join(getAgentDir(), "agents"),
      projectDir: join(process.cwd(), ".pi", "agents"),
    };
    let session: PtcSession;
    // 决策 5：registry 每次变迁同步任务面可见性（构造时挂监听器，闭包延迟取 session）
    session = assemblePtcSession({
      onTransition: () => applyTaskFaceVisibility(pi, session),
      whyEnabled: () => whyEnabledOverride ?? whyEnabledPersisted,
      engine: {
        notifications,
        resolveAgent: (name, scope) => findAgent(name, agentDirs, scope),
        childExtensionPath: fileURLToPath(import.meta.url),
        // ADR-0049：搜索开关传给引擎（strict 白名单保留 web_ds_search）
        searchEnabled: readWebSearchConfig(getAgentDir()).enabled,
        // BG-01：记录落盘（项目级 .pi 目录；pi 的 sessionDir 不在扩展 API 上，此处取项目本地态）
        storageDir: join(process.cwd(), ".pi", "ptc-tasks"),
      },
      gates: [
        readOnlyGate,
        dispatchEnabledGate(() => dispatchEnabled),
        sessionEndingGate(() => sessionEnding),
        depthGate(() => Number(process.env.PI_PTC_DEPTH ?? 0), 3),
        agentNameGate,
        agentResolveGate((name, scope) => findAgent(name, agentDirs, scope) !== null),
      ],
    });
    pi.registerCommand("ptc", {
      description:
        "/ptc off|on：派发开关 · /ptc why on|off：理由开关 · /ptc mode on|off：PTC 模式（收窄/恢复 loadout）",
      handler: async (args, cmdCtx) => {
        const [sub, rest] = args.trim().split(/\s+/);
        if (sub === "off") {
          dispatchEnabled = false; // 纵深防御（ADR-0058）：闸留着，截断是真手段
          withdrawTools(); // 撤编排层/门——声明集下一 turn 重算后生效
          if (modeActive) {
            modeEnabled = false;
            applyMode(); // off ⇒ 收窄同时退出（ADR-0050）
          }
        } else if (sub === "on") {
          dispatchEnabled = true;
          restoreTools();
          modeEnabled = true;
          applyMode();
        } else if (sub === "why") whyEnabledOverride = rest !== "off";
        else if (sub === "mode") {
          modeEnabled = rest !== "off";
          applyMode();
        }
        cmdCtx.ui.notify(
          `/ptc：dispatchEnabled=${dispatchEnabled}，mode=${modeActive ? "on（收窄中）" : "off"}，whyEnabled=${whyEnabledOverride ?? whyEnabledPersisted}（在飞任务不受影响）`,
          "info",
        );
      },
    });
    pi.on("session_shutdown", () => {
      sessionEnding = true;
      void session.shutdown();
    });
    notifications.attach(session.registry);
    // ADR-0058 截断的原件留存：/ptc off = 同名重注册 exposure:hidden（pi 无 unregister，Map.set 覆盖）；on 重放原件
    const toolOriginals = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const withdrawnNames: string[] = [];
    const registerTracked: ExtensionAPI["registerTool"] = ((
      def: Parameters<ExtensionAPI["registerTool"]>[0],
    ) => {
      toolOriginals.set(def.name, def);
      pi.registerTool(def);
    }) as ExtensionAPI["registerTool"];
    const withdrawTools = () => {
      for (const [name, def] of toolOriginals) {
        if (name.startsWith("ptc_task_")) continue; // 任务面不属于 PTC 层（ADR-0050）：off 不动它
        pi.registerTool({ ...def, exposure: "hidden" } as Parameters<
          ExtensionAPI["registerTool"]
        >[0]);
        withdrawnNames.push(name);
      }
    };
    const restoreTools = () => {
      for (const name of withdrawnNames.splice(0)) {
        const def = toolOriginals.get(name);
        if (def) pi.registerTool(def);
      }
    };
    registerTaskFace(registerTracked, session, surface);
    applyTaskFaceVisibility(pi, session);
    const bindings = createBindingTable(pi, ctx, session);
    registerPtcTools(
      registerTracked,
      { getBindings: () => bindings, cwd: process.cwd(), surface, getPool: () => pool },
      surface,
    );
    if (surface === "codemode_ptc") registerTaskDoor(registerTracked, session, surface);
    pi.on("turn_end", () => pool.drain());
    ctx.ui.notify(`pi-ptc-subagents: surface=${surface}，任务面 3 工具 + PTC 工具对已注册`, "info");
  });
}

// 决策 5：有记录 → 加进活跃表；归零 → 撤掉。读当前活跃表合并，不动用户 loadout 的其它部分
const TASK_FACE_NAMES = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"];

// ADR-0010：defaultMode 缺省 true（装包默认进 PTC 模式）；显式 false 才不进
function readDefaultModeConfig(agentDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "ptc.json"), "utf8")) as {
      defaultMode?: unknown;
    };
    return parsed.defaultMode !== false;
  } catch {
    return true;
  }
}

// ADR-0043：whyEnabled 读 ~/.pi/agent/ptc.json——剥夺类开关 fail-open：文件缺失/坏 JSON/坏值一律视为开
function readWhyEnabledConfig(agentDir: string): boolean {
  try {
    const raw = readFileSync(join(agentDir, "ptc.json"), "utf8");
    const parsed = JSON.parse(raw) as { whyEnabled?: unknown };
    return parsed.whyEnabled !== false;
  } catch {
    return true;
  }
}

function applyTaskFaceVisibility(pi: ExtensionAPI, session: PtcSession): void {
  const active = pi.getActiveTools();
  const has = session.faceVisible();
  const present = TASK_FACE_NAMES.filter((name) => active.includes(name));
  if (has && present.length === 0) pi.setActiveTools([...active, ...TASK_FACE_NAMES]);
  if (!has && present.length > 0)
    pi.setActiveTools(active.filter((name) => !TASK_FACE_NAMES.includes(name)));
}

// ADR-0048：webDsSearch 开关 fail-closed（默认关）；凭据按 pi 同款语义三级解析（auth.json → models.json → env）
function readWebSearchConfig(agentDir: string): { enabled: boolean; maxCalls: number } {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "ptc.json"), "utf8")) as {
      webDsSearch?: unknown;
      searchMaxCalls?: unknown;
    };
    // shortcut: 默认 30/进程沿用旧实现值，未实测校准；0 = 不限
    const maxCalls = typeof parsed.searchMaxCalls === "number" ? parsed.searchMaxCalls : 30;
    return { enabled: parsed.webDsSearch === true, maxCalls };
  } catch {
    return { enabled: false, maxCalls: 30 };
  }
}

function readDeepSeekCredential(agentDir: string): string | null {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      { api_key?: string; key?: string }
    >;
    const fromAuth = auth.deepseek?.api_key ?? auth.deepseek?.key;
    if (fromAuth) return fromAuth;
  } catch {
    // 落到下一级
  }
  try {
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    if (models.providers?.deepseek?.apiKey) return models.providers.deepseek.apiKey;
  } catch {
    // 落到 env
  }
  return process.env.DEEPSEEK_API_KEY ?? null;
}

// ADR-0032 工具通道 + ADR-0049 搜索：子代理进程里唯一的注册物集合——echo 式报告工具 + 门控的 web_ds_search
function registerChildToolsOnly(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  // 注意：开关开但缺 key 时仍注册——调用返回可读错误（ADR-0048 方案 B），描述与启动告警省略
  if (readWebSearchConfig(agentDir)) {
    const apiKey = readDeepSeekCredential(agentDir);
    pi.registerTool(
      createWebDsSearchTool({
        provider: createDeepSeekProvider(apiKey ?? "missing-key"),
        memory: createSearchMemory(),
        quota: createSearchQuota(30),
      }),
    );
  }

  pi.registerTool({
    name: "ptc_child_report",
    label: "交报告",
    description: "Deliver the child report（契约见你的 system prompt）。",
    parameters: Type.Object({
      summary: Type.String(),
      findings: Type.Optional(
        Type.Array(Type.Object({ what: Type.String(), evidence: Type.Optional(Type.String()) })),
      ),
      files_touched: Type.Optional(Type.Array(Type.String())),
      usage: Type.Optional(
        Type.Object({
          input: Type.Optional(Type.Number()),
          output: Type.Optional(Type.Number()),
          cost: Type.Optional(Type.Number()),
          turns: Type.Optional(Type.Number()),
        }),
      ),
    }),
    execute: async (_id, args) => ({
      content: [{ type: "text", text: "child report received" }],
      structuredContent: args,
      details: { report: args },
    }),
  });
}

// ADR-0005：binding 经 pi 的工具管线执行（ctx.executeTool）；floor 版本无此通道时绑定给出明确错误
function createBindingTable(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: PtcSession,
): BindingTable {
  // emitImage 桥：pi 工具结果里的图片块经此上提到运行结果（ADR-0014）
  // executeTool 在 ExtensionContextActions 上是 optional，session_start 的 ctx 类型为 ExtensionContext——运行时探测
  const executeTool = (
    ctx as {
      executeTool?: (
        callerId: string,
        name: string,
        args: unknown,
      ) => Promise<{ result: AgentToolResult; isError: boolean }>;
    }
  ).executeTool;
  const names = resolveBindingNames(pi.getActiveTools());
  const table: BindingTable = Object.fromEntries(
    names.map((name) => [
      name,
      async (
        args: unknown,
        callCtx: { emitImage: (image: unknown) => void; signal?: AbortSignal },
      ) => {
        if (!executeTool) {
          throw new Error(`此 pi 版本不支持程序内工具调用（executeTool 不可用，binding: ${name}）`);
        }
        const outcome = await executeTool(`ptc/${name}`, name, args);
        for (const block of outcome.result.content) {
          if (block.type === "image") callCtx.emitImage(block);
        }
        if (outcome.isError) {
          const text = outcome.result.content
            .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
            .join("\n");
          throw new Error(text || `工具 ${name} 执行失败`);
        }
        return outcome.result.structuredContent ?? outcome.result.content;
      },
    ]),
  );
  // C1 / 派发链左栏：程序内建任务的门（ADR-0052）——binding 表注入点接上，tools.pi_task_ptc 在程序内可达
  const taskBinding = createTaskBinding(session);
  table[TASK_BINDING_NAME] = (args) =>
    taskBinding.execute(args as { task: string; label?: string });
  return table;
}

// PTC 门面（ADR-0010/0017）：binding 表 = 名单 ∩ 会话活跃工具（--tools 收窄会话不会拿到被滤掉的绑定）
// ADR-0051 + 决策 28：一个面一个编排器——full_ptc 注册 PTC 对（模型面）；
// codemode_ptc 不注册（编排唯一出口 = pi 的 codemode + 脚本内 pi_task_codemode，修订 ADR-0025 §3 的 codemode-reach 残留）
function registerPtcTools(
  registerTool: ExtensionAPI["registerTool"],
  options: Parameters<typeof createPtcRunCodeTool>[0],
  surface: "full_ptc" | "codemode_ptc",
): void {
  if (surface !== "full_ptc") return;
  registerTool(createPtcRunCodeTool(options));
  registerTool(createPtcWorkflowTool(options));
}

// 任务链（lifecycle face，ADR-0022 + 决策 5）：读/停同一个 registry；可见性 = 有任务记录才在模型面前
// pi 1.4.0 实测不支持 exposure getter → defaultActive:false + setActiveTools 增删（applyTaskFaceVisibility）
function registerTaskFace(
  registerTool: ExtensionAPI["registerTool"],
  session: PtcSession,
  surface: SurfaceMode,
): void {
  registerTool({
    name: "ptc_task_list",
    label: "任务列表",
    description: TOOLS.ptc_task_list.description(surface),
    parameters: Type.Object({}),
    defaultActive: false,
    execute: async () => textResult(session.listTasks()),
  });
  registerTool({
    name: "ptc_task_output",
    label: "任务产出",
    description: TOOLS.ptc_task_output.description(surface),
    parameters: Type.Object({ task_id: Type.String() }),
    defaultActive: false,
    execute: async (_id, args) => {
      const record = session.registry.get(args.task_id);
      if (!record) return textResult({ error: `unknown task id ${args.task_id}` });
      const outputBytes = await session.outputSize(args.task_id);
      if (outputBytes === undefined) return textResult(record);
      // 分层读取：产出超 ADR-0015 阈值时，先引导模型读报告（归约层）；无报告才给截断尾部
      if (outputBytes > TRUNCATION_MAX_BYTES) {
        return textResult({
          ...record,
          guidance: renderLongOutputGuidance({
            bytes: outputBytes,
            report: record.report,
            reportChannel: record.reportChannel,
          }),
        });
      }
      const output = (await session.readOutputTail(args.task_id, TRUNCATION_MAX_BYTES)) ?? "";
      const { text } = applyAdr0015Truncation(output);
      return textResult({ ...record, output: text });
    },
  });
  registerTool({
    name: "ptc_task_stop",
    label: "停任务",
    description: TOOLS.ptc_task_stop.description(surface),
    parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
    defaultActive: false,
    execute: async (_id, args) =>
      textResult(await session.stopTask(args.task_id, args.reason ?? "user stop")),
  });
}

// 派发链的门（ADR-0052/0054）：codemode 门 ≥0.99.0 对模型不可见；floor 上 exposure 被忽略（见矩阵文档）
function registerTaskDoor(
  registerTool: ExtensionAPI["registerTool"],
  session: PtcSession,
  surface: SurfaceMode,
): void {
  registerTool({
    name: "pi_task_codemode",
    label: "建任务",
    description: TOOLS.pi_task_codemode.description(surface),
    parameters: TASK_DOOR_PARAMETERS,
    exposure: "codemode",
    execute: async (_id, args) => {
      const result = await session.createTask(args.task, {
        label: args.label,
        wait: args.wait,
        why: args.why,
      });
      // 决策 7/12：拒绝走 status，不抛；两个入口同形
      return {
        ...textResult(result),
        structuredContent: result,
        isError: result.status === "rejected",
      };
    },
  });
}
