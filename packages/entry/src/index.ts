import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Type } from "typebox";
import {
  FileOutputStorage,
  NotificationCenter,
  agentNameGate,
  agentResolveGate,
  depthGate,
  dispatchEnabledGate,
  findAgent,
  readOnlyGate,
  sessionEndingGate,
  taskTextGate,
} from "@pi-ptc/dispatch";
import { fileURLToPath } from "node:url";
import { createDeepSeekProvider, createSearchMemory, createSearchQuota } from "@pi-ptc/search";
import { createWebDsSearchTool } from "./web-ds-search-tool.ts";
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
  FALLBACK_SURFACE_MODE,
  TOOLS,
  renderDeliveryCheck,
  renderLongOutputGuidance,
  renderRouteIndex,
  renderTaskNotifications,
  type DeliveryFacts,
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

// 交付核对：孩子**实际**干了什么（引擎从事件流抽）+ 它声称交了几条（报告）——父据此判断该不该信
// 散文在 routes（ADR-0013）；这里只拼形状。DispatchResult 与 TaskRecord 同形，两扇门与任务面共用
export function withDeliveryNote<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const record = value as {
    reportChannel?: string;
    report?: { findings?: unknown[] };
    delivery?: DeliveryFacts;
  };
  if (!("reportChannel" in record)) return value;
  const note = renderDeliveryCheck({
    delivery: record.delivery,
    findings: Array.isArray(record.report?.findings) ? record.report.findings.length : 0,
    channel: record.reportChannel,
  });
  return (note ? { ...record, deliveryNote: note } : record) as unknown as T;
}

// 详情文件目录：发布包里是 <pkg>/docs/routes，开发态是 packages/routes/docs/routes
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const publishedDetailDir = join(packageRoot, "docs", "routes");
const detailDir = existsSync(publishedDetailDir)
  ? publishedDetailDir
  : join(packageRoot, "..", "routes", "docs", "routes");

// 减量 argv 的版本门素材：孩子与宿主同 binary，启动时解析一次（~几十 ms；取不到返回 undefined，按 floor 处理）
function resolvePiVersion(): string | undefined {
  try {
    const out = execSync("pi --version", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// pi 版本能力矩阵与 <0.99.0 floor 的运行时差异：docs/pi-version-matrix.md
export default function piPtcEntry(pi: ExtensionAPI): void {
  // 旧 ADR-0035：注册发生在 session_start——此刻 getActiveTools() 可用且 trust 已应用；factory 阶段它们是 throw 的桩
  pi.on("session_start", (_event, ctx) => {
    // 子代理进程（depth>0）：只注册 child_report 工具（旧 ADR-0032 工具通道），不做任何宿主侧装配
    if (Number(process.env.PI_PTC_DEPTH ?? 0) > 0) {
      registerChildToolsOnly(pi);
      return;
    }
    // 旧 ADR-0035/0051：surface 直接问 pi——codemode 进了模型活跃表 = codemode_ptc；否则 full_ptc
    const surface: SurfaceMode = pi.getActiveTools().includes("codemode")
      ? "codemode_ptc"
      : FALLBACK_SURFACE_MODE;
    // 旧 ADR-0010 PTC 模式：pi 1.4.0 上「收窄活跃表」与「程序内 tools.*」不可兼得——
    // 可调用集 = active 的 direct 工具（pi 的 _getCallableTools），收窄即退出可调用集，
    // 程序就再也调不到 read/bash（真机实测 "Tool read not found"）；内置工具的 exposure
    // 不是扩展能设的（没有「active 但不向模型声明」的通道给内置工具）。
    // 所以模式退化为**引导层**：程序优先的总则句进路由索引，工具仍可直调。
    let modeEnabled = readDefaultModeConfig(getAgentDir());
    let modeActive = false;
    const applyMode = () => {
      modeActive = surface === "full_ptc" && modeEnabled;
    };
    applyMode();
    // ADR-0015：<ptc> 常驻索引进系统提示词；渲染输入 = 册子 + surface + 详情目录 + 总则句开关——中途 /ptc mode 会废一次提示词缓存（决策 5 例外，见 ADR-0015 修订）
    pi.on("before_agent_start", (event) => {
      applyMode();
      applyTaskFaceVisibility(); // resume 重置后任务面可见性再对齐（幂等）
      // floor 版本事件形状未实测：缺 sections 就跳过注入，别让每个 turn 抛 TypeError
      const sections = event.systemPromptOptions?.sections;
      if (sections) sections["ptc"] = renderRouteIndex(surface, detailDir, modeActive);
    });
    const pool = new WorkerPool(spawnPtcWorker);
    const notifications = new NotificationCenter();
    // 旧 ADR-0022：终态事件进待投递队列（engine 的 wait 路径记 awaited 不通知）；turn 边界批投递
    // 单批发送失败不拖累其余批（分批已按 100KB 切；丢一批只是提醒缺失，记录仍在任务面）
    pi.on("turn_end", () => {
      for (const batch of notifications.drain()) {
        try {
          const text = renderTaskNotifications(batch);
          pi.sendMessage(
            { customType: "bg-task-notifications", content: text, display: true },
            { deliverAs: "nextTurn" },
          );
        } catch {
          // 通知是 best-effort：失败不阻塞 turn
        }
      }
    });
    // ADR-0004/0065：dispatchEnabled 独立于 mode；会话结束位置位（gate 读谓词）
    let dispatchEnabled = true;
    let sessionEnding = false;
    let whyEnabledOverride: boolean | null = null;
    const whyEnabledPersisted = readWhyEnabledConfig(getAgentDir());
    const traceRetention = readTraceRetentionConfig(getAgentDir());
    const agentDirs = {
      userDir: join(getAgentDir(), "agents"),
      projectDir: join(process.cwd(), ".pi", "agents"),
    };
    // 减量 argv 的版本门：孩子与宿主同 binary，解析一次宿主 pi 版本（失败按 floor 处理——supportsNoMcp 缺省 false）
    const piVersion = resolvePiVersion();
    let session: PtcSession;
    // 决策 5 的可见性对齐。审计 F9：只撤「本会话自己加的」——用户 loadout 自己固定的任务面工具不动
    const faceAddedByUs = new Set<string>();
    const applyTaskFaceVisibility = (): void => {
      const active = pi.getActiveTools();
      const has = session.faceVisible();
      const present = TASK_FACE_NAMES.filter((name) => active.includes(name));
      if (has && present.length === 0) {
        pi.setActiveTools([...active, ...TASK_FACE_NAMES]);
        for (const name of TASK_FACE_NAMES) faceAddedByUs.add(name);
        return;
      }
      if (!has && present.length > 0) {
        const ours = present.filter((name) => faceAddedByUs.has(name));
        if (ours.length === 0) return;
        pi.setActiveTools(active.filter((name) => !ours.includes(name)));
        for (const name of ours) faceAddedByUs.delete(name);
      }
    };
    // 决策 5：registry 每次变迁同步任务面可见性（构造时挂监听器，闭包延迟取 session）
    session = assemblePtcSession({
      onTransition: () => applyTaskFaceVisibility(),
      whyEnabled: () => whyEnabledOverride ?? whyEnabledPersisted,
      context: { depth: 0, piVersion },
      engine: {
        notifications,
        resolveAgent: (name, scope) => findAgent(name, agentDirs, scope),
        childExtensionPath: fileURLToPath(import.meta.url),
        // ADR-0003：搜索开关传给引擎（strict 白名单保留 web_ds_search）
        searchEnabled: readWebSearchConfig(getAgentDir()).enabled,
        // BG-01：记录与产出一同落盘（项目级 .pi 目录；pi 的 sessionDir 不在扩展 API 上，此处取项目本地态）
        storageDir: join(process.cwd(), ".pi", "ptc-tasks"),
        output: new FileOutputStorage(join(process.cwd(), ".pi", "ptc-tasks")),
        // 决策 29：痕迹保留配置（~/.pi/agent/ptc.json，clamp 校验）
        terminalRecordKeep: traceRetention.keep,
        archiveEnabled: traceRetention.archiveEnabled,
        archiveTtlDays: traceRetention.ttlDays,
      },
      gates: [
        readOnlyGate,
        taskTextGate,
        dispatchEnabledGate(() => dispatchEnabled),
        sessionEndingGate(() => sessionEnding),
        depthGate(() => Number(process.env.PI_PTC_DEPTH ?? 0), 3),
        agentNameGate,
        agentResolveGate((name, scope) => findAgent(name, agentDirs, scope) !== null),
      ],
    });
    pi.registerCommand("ptc", {
      description:
        "/ptc off|on：派发开关 · /ptc why on|off：理由开关 · /ptc mode on|off：PTC 模式（程序优先的引导层）",
      handler: async (args, cmdCtx) => {
        const [sub, rest] = args.trim().split(/\s+/);
        if (sub === "off") {
          dispatchEnabled = false; // 纵深防御（ADR-0012）：闸留着，截断是真手段
          withdrawTools(); // 撤编排层/门——声明集下一 turn 重算后生效
          if (modeActive) {
            modeEnabled = false;
            applyMode(); // off ⇒ 收窄同时退出（ADR-0004）
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
          `/ptc：dispatchEnabled=${dispatchEnabled}，mode=${modeActive ? "on（引导层）" : "off"}，whyEnabled=${whyEnabledOverride ?? whyEnabledPersisted}（在飞任务不受影响）`,
          "info",
        );
      },
    });
    pi.on("session_shutdown", () => {
      sessionEnding = true;
      pool.drain(); // 退役空闲 worker：特定关闭时序下别让 ref 着的线程拖住退出
      void session.shutdown();
    });
    notifications.attach(session.registry);
    // ADR-0012 截断的原件留存：/ptc off = 同名重注册 exposure:hidden（pi 无 unregister，Map.set 覆盖）；on 重放原件
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
        if (name.startsWith("ptc_task_")) continue; // 任务面不属于 PTC 层（ADR-0004）：off 不动它
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
    applyTaskFaceVisibility();
    // 工具执行上下文：程序内 tools.* 的通道（pi 1.4.0 把 executeTool 放在 ExtensionToolContext 上）
    let toolContext: ExtensionToolContext | undefined;
    // 绑定表按每次程序运行时重建：老版本（0.86/0.87）在 session_start 时活跃表还没成型，
    // 早建会得到空表，程序里 tools.* 全是 undefined
    const getBindings = () => createBindingTable(pi, session, () => toolContext);
    registerPtcTools(
      registerTracked,
      {
        getBindings,
        cwd: process.cwd(),
        surface,
        getPool: () => pool,
        onToolContext: (ctx) => {
          toolContext = ctx;
        },
      },
      surface,
    );
    if (surface === "codemode_ptc") registerTaskDoor(registerTracked, session, surface);
    pi.on("turn_end", () => pool.drain());
    ctx.ui.notify(`pi-ptc-subagents: surface=${surface}，任务面 3 工具 + PTC 工具对已注册`, "info");
  });
}

// 决策 5：有记录 → 加进活跃表；归零 → 撤掉。读当前活跃表合并，不动用户 loadout 的其它部分
const TASK_FACE_NAMES = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"];

// 旧 ADR-0010：defaultMode 缺省 true（装包默认进 PTC 模式）；显式 false 才不进
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

// 旧 ADR-0043：whyEnabled 读 ~/.pi/agent/ptc.json——剥夺类开关 fail-open：文件缺失/坏 JSON/坏值一律视为开
function readWhyEnabledConfig(agentDir: string): boolean {
  try {
    const raw = readFileSync(join(agentDir, "ptc.json"), "utf8");
    const parsed = JSON.parse(raw) as { whyEnabled?: unknown };
    return parsed.whyEnabled !== false;
  } catch {
    return true;
  }
}

// ADR-0002：webDsSearch 开关 fail-closed（默认关）；凭据按 pi 同款语义三级解析（auth.json → models.json → env）
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

// 决策 29：任务痕迹保留配置——clamp 不 reject（越界夹取、坏值落默认）；archiveEnabled 仅显式 boolean 生效（默认 ON = 取证优先）
function readTraceRetentionConfig(agentDir: string): {
  keep: number;
  archiveEnabled: boolean;
  ttlDays: number;
} {
  const defaults = { keep: 500, archiveEnabled: true, ttlDays: 30 };
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "ptc.json"), "utf8")) as {
      taskTraceKeep?: unknown;
      archiveEnabled?: unknown;
      archiveTtlDays?: unknown;
    };
    const clampNum = (v: unknown, lo: number, hi: number, d: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
    return {
      keep: clampNum(parsed.taskTraceKeep, 10, 10000, defaults.keep),
      archiveEnabled:
        typeof parsed.archiveEnabled === "boolean"
          ? parsed.archiveEnabled
          : defaults.archiveEnabled,
      ttlDays: clampNum(parsed.archiveTtlDays, 1, 365, defaults.ttlDays),
    };
  } catch {
    return defaults;
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

// 旧 ADR-0032 工具通道 + ADR-0003 搜索：子代理进程里唯一的注册物集合——echo 式报告工具 + 门控的 web_ds_search
function registerChildToolsOnly(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const searchConfig = readWebSearchConfig(agentDir);
  // 注意：开关开但缺 key 时仍注册——调用返回可读错误（ADR-0002 方案 B），描述与启动告警省略
  if (searchConfig.enabled) {
    const apiKey = readDeepSeekCredential(agentDir);
    pi.registerTool(
      createWebDsSearchTool({
        provider: createDeepSeekProvider(apiKey ?? "missing-key"),
        memory: createSearchMemory(),
        quota: createSearchQuota(searchConfig.maxCalls),
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

// 工具结果在不同 pi 版本有三种形状：字符串、内容块数组、structuredContent 对象——统一成文本给程序
function normalizeToolValue(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        const obj = block as { type?: unknown; text?: unknown };
        // 图片块走 emitImage 上提，不把 base64 灌进文本
        if (obj.type === "image") return "[image]";
        return obj.text ?? JSON.stringify(block);
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as { content?: unknown; text?: unknown; type?: unknown; note?: unknown };
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    // pi 的 read 对图片回 {type:"image", data:<base64>, note}——图片已经上提给模型，这里只回文字
    if (obj.type === "image") return typeof obj.note === "string" ? obj.note : "[image]";
  }
  return value;
}

// 旧 ADR-0005：binding 经 pi 的工具管线执行（ctx.executeTool）
// 通道在**工具执行上下文**上：pi 1.4.0 的 ToolDefinition.execute 第 5 个参数是
// ExtensionToolContext，它的 executeTool(name, args, options?) 才是程序内调用工具的入口
// （session_start 的 ExtensionContext 上没有它——早期实现取错上下文，程序内 tools.* 全程是死的）
function createBindingTable(
  pi: ExtensionAPI,
  session: PtcSession,
  getToolContext: () => ExtensionToolContext | undefined,
): BindingTable {
  // emitImage 桥：pi 工具结果里的图片块经此上提到运行结果（旧 ADR-0014）
  const active = pi.getActiveTools();
  // 作用域 = 程序真能调到的内置工具：
  // 有通道的版本（≥0.99）：getActiveTools() 就是「向模型声明的集合」，直接用（--tools 收窄也 respected）
  // 没有通道的老版本（0.86/0.87）：getActiveTools() 只含扩展自己的工具（实测 ["zz_probe"]），
  // 内置工具只在 getAllTools() 里——那两版没有嵌套调用通道，程序里的 tools.* 无论如何都会拿到明确错误，
  // 但至少不再是无声的 undefined。
  const known = new Set<string>(KNOWN_BINDING_NAMES);
  const scope =
    !getToolContext() && !active.some((name) => known.has(name))
      ? pi.getAllTools().map((tool) => tool.name)
      : active;
  const names = resolveBindingNames(scope);
  const table: BindingTable = Object.fromEntries(
    names.map((name) => [
      name,
      async (
        args: unknown,
        callCtx: { emitImage: (image: unknown) => void; signal?: AbortSignal },
      ) => {
        const ctx = getToolContext();
        if (!ctx?.executeTool) {
          throw new Error(`此 pi 版本没有程序内调用工具的通道（需 pi ≥ 0.99，binding: ${name}）`);
        }
        const outcome = await ctx.executeTool(name, args, { signal: callCtx.signal });
        for (const block of outcome.result.content) {
          if (block.type === "image") callCtx.emitImage(block);
        }
        if (outcome.isError) {
          const text = outcome.result.content
            .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
            .join("\n");
          throw new Error(text || `工具 ${name} 执行失败`);
        }
        return normalizeToolValue(outcome.result.structuredContent ?? outcome.result.content);
      },
    ]),
  );
  // C1 / 派发链左栏：程序内建任务的门（ADR-0006）——binding 表注入点接上，tools.pi_task_ptc 在程序内可达
  const taskBinding = createTaskBinding(session);
  table[TASK_BINDING_NAME] = async (args) =>
    withDeliveryNote(await taskBinding.execute(args as { task: string; label?: string }));
  return table;
}

// PTC 门面（旧 ADR-0010/0017）：binding 表 = 名单 ∩ 会话作用域（≥0.99 的作用域 = 活跃工具，--tools 收窄会话不会拿到被滤掉的绑定）
// ADR-0005 + 决策 28：一个面一个编排器——full_ptc 注册 PTC 对（模型面）；
// codemode_ptc 不注册（编排唯一出口 = pi 的 codemode + 脚本内 pi_task_codemode，修订 旧 ADR-0025 §3 的 codemode-reach 残留）
function registerPtcTools(
  registerTool: ExtensionAPI["registerTool"],
  options: Parameters<typeof createPtcRunCodeTool>[0],
  surface: "full_ptc" | "codemode_ptc",
): void {
  if (surface !== "full_ptc") return;
  registerTool(createPtcRunCodeTool(options));
  registerTool(createPtcWorkflowTool(options));
}

// 任务链（lifecycle face，旧 ADR-0022 + 决策 5）：读/停同一个 registry；可见性 = 有任务记录才在模型面前
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
      // 决策 29：registry miss 回落压缩归档——记住的 id 在 TTL 窗口内仍可解（标 archived: true）
      const record =
        session.registry.get(args.task_id) ?? (await session.readArchivedRecord(args.task_id));
      if (!record) return textResult({ error: `unknown task id ${args.task_id}` });
      const outputBytes = await session.outputSize(args.task_id);
      if (outputBytes === undefined) return textResult(withDeliveryNote(record));
      // 分层读取：报告是归约层，响应里的 output 是尾部原始层（完整原文在 outputPath）
      if (outputBytes > TRUNCATION_MAX_BYTES) {
        const tail = (await session.readOutputTail(args.task_id, TRUNCATION_MAX_BYTES)) ?? "";
        const { text } = applyAdr0015Truncation(tail);
        return textResult(
          withDeliveryNote({
            ...record,
            output: text,
            guidance: renderLongOutputGuidance({
              bytes: outputBytes,
              report: record.report,
              reportChannel: record.reportChannel ?? "none",
            }),
          }),
        );
      }
      const output = (await session.readOutputTail(args.task_id, TRUNCATION_MAX_BYTES)) ?? "";
      const { text } = applyAdr0015Truncation(output);
      return textResult(withDeliveryNote({ ...record, output: text }));
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

// 派发链的门（ADR-0006/0054）：codemode 门 ≥0.99.0 对模型不可见；floor 上 exposure 被忽略（见矩阵文档）
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
        agent: args.agent,
        agentScope: args.agentScope,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
        readOnly: args.readOnly,
        timeoutMs: args.timeoutMs,
        projectContext: args.projectContext,
      });
      // 决策 7/12：拒绝走 status，不抛；两个入口同形
      const shaped = withDeliveryNote(result);
      return {
        ...textResult(shaped),
        structuredContent: shaped,
        isError: result.status === "rejected",
      };
    },
  });
}
