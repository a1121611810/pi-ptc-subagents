import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import * as piHost from "@earendil-works/pi-coding-agent";
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
  TASK_STATUSES,
  readOnlyGate,
  sessionEndingGate,
  taskTextGate,
} from "@pi-ptc/dispatch";
import { fileURLToPath } from "node:url";
import { compactedTaskReminder, readTaskOutput, taskListSnapshot } from "@pi-ptc/task";
import { createTaskPanel, createNoSkimpBanner } from "@pi-ptc/tui/pi";
import { createDeepSeekProvider, createSearchMemory, createSearchQuota } from "@pi-ptc/search";
import { createWebDsSearchTool } from "./web-ds-search-tool.ts";
import { showUpgradeNotice } from "./upgrade-notice.ts";
import { WorkerPool, spawnPtcWorker, type BindingTable } from "@pi-ptc/ptc";
import { createPtcRunCodeTool, createPtcWorkflowTool } from "./ptc-tools.ts";
import { KNOWN_BINDING_NAMES, resolveBindingNames } from "./ptc-bindings.ts";
import {
  createTaskBinding,
  createTaskOutputBinding,
  TASK_BINDING_NAME,
  TASK_RECORDS_BINDING_NAME,
  TASK_OUTPUT_BINDING_NAME,
  TASK_DOOR_PARAMETERS,
} from "./task-binding.ts";
import {
  FALLBACK_SURFACE_MODE,
  NO_SKIMP_PTC_NOTE,
  TOOLS,
  renderDeliveryCheck,
  renderRouteIndex,
  renderTaskNotifications,
  type DeliveryFacts,
  type SurfaceMode,
} from "@pi-ptc/routes";
import { assemblePtcSession, buildEngineContext, type PtcSession } from "./session.ts";

export { assemblePtcSession, buildEngineContext } from "./session.ts";
export { createTaskOutputBinding } from "./task-binding.ts";
export {
  findInstalledPackage,
  parseChangelog,
  pickBullets,
  showUpgradeNotice,
  summarize,
  versionNumber,
} from "./upgrade-notice.ts";
export type {
  CreateTaskResult,
  DispatchOutcome,
  Gate,
  PtcSession,
  TaskHandle,
  TaskRejection,
} from "./session.ts";

// text 必须是字符串：JSON.stringify(undefined) 是 undefined ⇒ pi 拼下一轮请求时读 .length 直接崩
// （2026-11-02 真机抓到：模型调一次 ptc_task_stop，下一轮整个 turn 挂掉、父面交白卷）
export const textResult = (value: unknown): AgentToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) ?? "null" }],
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
    // 「别省真跑」模式（noSkimpPtc / noSkimpSub）：默认关；语义 = 提示词里加「跑真的、别用 mock、别跳过慢检查」
    // 会话级覆盖优先于配置文件（/ptc noskimp|noskimp-sub on|off|reset）——谓词形态：装配时的值会被冻住
    const noSkimp = readNoSkimpConfig(getAgentDir());
    let noSkimpPtcOverride: boolean | null = null;
    let noSkimpSubOverride: boolean | null = null;
    const noSkimpPtc = (): boolean => noSkimpPtcOverride ?? noSkimp.noSkimpPtc;
    const noSkimpSub = (): boolean => noSkimpSubOverride ?? noSkimp.noSkimpSub;
    // ADR-0015：<ptc> 常驻索引进系统提示词；渲染输入 = 册子 + surface + 详情目录 + 总则句开关——中途 /ptc mode 会废一次提示词缓存（决策 5 例外，见 ADR-0015 修订）
    pi.on("before_agent_start", (event) => {
      applyMode();
      applyTaskFaceVisibility(); // resume 重置后任务面可见性再对齐（幂等）
      // floor 版本事件形状未实测：缺 sections 就跳过注入，别让每个 turn 抛 TypeError
      const sections = event.systemPromptOptions?.sections;
      if (sections) {
        sections["ptc"] = renderRouteIndex(surface, detailDir, modeActive);
        // 「别省真跑」段独立成节：<ptc> 索引有 token 预算硬顶（560），塞进去会顶穿并冒 > WARNING
        if (noSkimpPtc()) sections["no_skimp"] = NO_SKIMP_PTC_NOTE;
      }
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
      context: buildEngineContext(ctx, piVersion),
      engine: {
        notifications,
        resolveAgent: (name, scope) => findAgent(name, agentDirs, scope),
        childExtensionPath: fileURLToPath(import.meta.url),
        // ADR-0003：搜索开关传给引擎（strict 白名单保留 web_ds_search）
        searchEnabled: readWebSearchConfig(getAgentDir()).enabled,
        // 别省真跑：孩子提示词加「跑真的、别用 mock、别跳过慢检查」段（谓词 ⇒ /ptc noskimp-sub 热生效）
        noSkimpSub: noSkimpSub,
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
    // no-skimp 横幅（TUI）：开着时常驻；关掉即卸载。
    // 走 setWidget 而不是 notify——pi 的通知槽全局共享，别的扩展一调就把我们的文案顶掉（真机复现过）
    const noSkimpBanner = createNoSkimpBanner({
      ui: ctx.mode === "tui" ? ctx.ui : undefined,
      getState: () => ({ noSkimpPtc: noSkimpPtc(), noSkimpSub: noSkimpSub() }),
    });
    pi.registerCommand("ptc", {
      description:
        "/ptc off|on：派发开关 · /ptc why on|off：理由开关 · /ptc mode on|off：PTC 模式（程序优先的引导层） · /ptc noskimp on|off|reset：别省真跑（父面） · /ptc noskimp-sub on|off|reset：别省真跑（子代理）",
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
        } else if (sub === "noskimp") {
          noSkimpPtcOverride = rest === "reset" ? null : rest !== "off";
        } else if (sub === "noskimp-sub") {
          noSkimpSubOverride = rest === "reset" ? null : rest !== "off";
        }
        noSkimpBanner.refresh(); // 横幅跟着会话级切换走（配置文件的值在会话开始时已定）
        cmdCtx.ui.notify(
          `/ptc：dispatchEnabled=${dispatchEnabled}，mode=${modeActive ? "on（引导层）" : "off"}，whyEnabled=${whyEnabledOverride ?? whyEnabledPersisted}，noSkimp(PTC)=${noSkimpPtc()}，noSkimp(Sub)=${noSkimpSub()}（在飞任务不受影响）`,
          "info",
        );
      },
    });
    // 常驻子代理状态面板（ADR-0022）：只有 TUI 有屏幕——mode 进程内固定，session_start 判一次
    const taskPanel = createTaskPanel({
      ui: ctx.mode === "tui" ? ctx.ui : undefined,
      source: session.registry,
      sessionId: session.sessionId,
    });
    pi.on("session_shutdown", () => {
      sessionEnding = true;
      taskPanel.dispose(); // 面板不留残影
      noSkimpBanner.dispose(); // 横幅同理
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
    // 压缩后重注入在飞任务清单：压缩事件置标志，下一次 LLM 调用前把清单塞回请求上下文。
    // pi 的 context 事件在每次 LLM 调用前触发，handler 返回的 messages **替换**本次请求的可见消息
    // （不累积、不进会话记录）——所以要连 event.messages 一起返回。
    // floor 0.86 同样有 session_compact 与 context 两个事件（真机实测）→ 无版本门。
    let compactReminderPending = false;
    pi.on("session_compact", () => {
      compactReminderPending = true;
    });
    pi.on("context", (event) => {
      if (!compactReminderPending) return undefined;
      compactReminderPending = false;
      const reminder = compactedTaskReminder(session.registry);
      if (!reminder) return undefined;
      return {
        messages: [
          ...event.messages,
          { role: "user", content: [{ type: "text", text: reminder }], timestamp: Date.now() },
        ],
      };
    });
    // 工具执行上下文：程序内 tools.* 的通道（pi 1.4.0 把 executeTool 放在 ExtensionToolContext 上）
    let toolContext: ExtensionToolContext | undefined;
    // 绑定表按每次程序运行时重建：老版本（0.86/0.87）在 session_start 时活跃表还没成型，
    // 早建会得到空表，程序里 tools.* 全是 undefined
    const cwd = process.cwd();
    const getBindings = () =>
      createBindingTable(pi, session, () => toolContext, { cwd, extCtx: ctx, piVersion });
    registerPtcTools(
      registerTracked,
      {
        getBindings,
        cwd,
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
    // 升级提示：版本变了才显示一次（首装不打扰）——失败绝不阻断启动
    // 必须排在 session_start 的最后：pi 的 TUI 只有一个状态槽（showStatus 复用同一块），
    // 后发的那条通知会把先发的那条顶掉（2026-11-02 真机复现：提醒被上面那条 surface 吞了）
    try {
      showUpgradeNotice(ctx);
    } catch {
      // 提示是 best-effort
    }
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

// 别省真跑开关（noSkimpPtc / noSkimpSub）：fail-closed——只有显式 true 才开
// （同 webDsSearch；whyEnabled 那类「剥夺」开关才 fail-open）
function readNoSkimpConfig(agentDir: string): {
  noSkimpPtc: boolean;
  noSkimpSub: boolean;
} {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "ptc.json"), "utf8")) as {
      noSkimpPtc?: unknown;
      noSkimpSub?: unknown;
    };
    return {
      noSkimpPtc: parsed.noSkimpPtc === true,
      noSkimpSub: parsed.noSkimpSub === true,
    };
  } catch {
    return { noSkimpPtc: false, noSkimpSub: false };
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
// floor（0.86/0.87）没有 ctx.executeTool ⇒ 自己造出 pi 的真工具来调：
// pi 的工具工厂是公开导出（create*ToolDefinition，0.86.0–1.4.0 全有），execute 独立于 agent
// 循环（只用 ctx?.cwd || cwd）——所以老版本的程序工具与 ≥0.99 逐字同形（含 edit 的 {path, edits}
// 形状与 ls/find 的存在）。用命名空间取工厂：某个版本缺了也不炸——那个工具就报「没有通道」。
type PiToolDefinition = {
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }>;
};

const PI_TOOL_NAMES = ["read", "write", "edit", "grep", "ls", "find"] as const;

const PI_TOOL_FACTORIES = Object.fromEntries(
  PI_TOOL_NAMES.map((name) => [
    name,
    (piHost as unknown as Record<string, unknown>)[
      `create${name[0]!.toUpperCase()}${name.slice(1)}ToolDefinition`
    ],
  ]),
);

// pi 的嵌套调用通道（ctx.executeTool）出现在 0.99.0；floor 0.86/0.87 没有（版本矩阵 2026-11-01）
// 判定用版本号（和 argv 的版本门同一份解析）：「没认出 executeTool」有两种可能——真是 floor，
// 或是未来的 pi 挪了它的位置。后者必须报错，不能悄悄用自造工具绕过 pi 的工具管线
// （别的扩展的 tool_call 钩子会拦不到程序发起的调用，用量也不记）。版本认不出 → 当作有通道。
function hasNestedToolCalls(piVersion: string | undefined): boolean {
  if (!piVersion) return true;
  const [major = "0", minor = "0"] = piVersion.trim().replace(/^v/, "").split(".");
  const M = Number.parseInt(major, 10);
  const m = Number.parseInt(minor, 10);
  if (Number.isNaN(M) || Number.isNaN(m)) return true;
  return M > 0 || (M === 0 && m >= 99);
}

function createBindingTable(
  pi: ExtensionAPI,
  session: PtcSession,
  getToolContext: () => ExtensionToolContext | undefined,
  env: { cwd: string; extCtx: ExtensionContext; piVersion: string | undefined },
): BindingTable {
  const { cwd, extCtx, piVersion } = env;
  // emitImage 桥：pi 工具结果里的图片块经此上提到运行结果（旧 ADR-0014）
  const active = pi.getActiveTools();
  // 作用域 = 程序真能调到的内置工具：
  // 有通道的版本（≥0.99）：getActiveTools() 就是「向模型声明的集合」，直接用（--tools 收窄也 respected）
  // 没有通道的老版本（0.86/0.87）：getActiveTools() 只含扩展自己的工具（实测 ["zz_probe"]），
  // 内置工具只在 getAllTools() 里——那两版走下面的 pi 自造工具，作用域得从 getAllTools() 取。
  const known = new Set<string>(KNOWN_BINDING_NAMES);
  const scope =
    !getToolContext() && !active.some((name) => known.has(name))
      ? pi.getAllTools().map((tool) => tool.name)
      : active;
  const names = resolveBindingNames(scope);
  // floor 的 pi 自造工具：惰性建（工厂在 cwd 上构造一次）
  let piTools: Record<string, PiToolDefinition> | undefined;
  const piToolFor = (name: string): PiToolDefinition | undefined => {
    if (!piTools) {
      piTools = {};
      for (const [tool, factory] of Object.entries(PI_TOOL_FACTORIES)) {
        if (typeof factory === "function") {
          piTools[tool] = (factory as (dir: string) => PiToolDefinition)(cwd);
        }
      }
    }
    return piTools[name];
  };
  const table: BindingTable = Object.fromEntries(
    names.map((name) => [
      name,
      async (
        args: unknown,
        callCtx: { emitImage: (image: unknown) => void; signal?: AbortSignal },
      ) => {
        const ctx = getToolContext();
        if (!ctx?.executeTool) {
          // floor（0.86/0.87）：没有嵌套调用通道 ⇒ 自己造出 pi 的真工具来调——与 ≥0.99 同形同语义。
          // 现代 pi 上认不出通道是异常 ⇒ 报错，不悄悄绕过 pi 的工具管线。
          const def = hasNestedToolCalls(piVersion) ? undefined : piToolFor(name);
          if (!def) {
            throw new Error(`此 pi 版本没有程序内调用工具的通道（需 pi ≥ 0.99，binding: ${name}）`);
          }
          // prepareArguments 是管线的兼容垫片（如 edits 传成字符串/单个对象）——直接调 execute 会跳过它
          const prepared = def.prepareArguments ? def.prepareArguments(args) : args;
          const result = await def.execute(
            `ptc-${name}`,
            prepared as never,
            callCtx.signal,
            undefined,
            extCtx,
          );
          for (const block of result.content ?? []) {
            if ((block as { type?: string }).type === "image") callCtx.emitImage(block);
          }
          if (result.isError) {
            const text = (result.content ?? [])
              .map((block) => {
                const obj = block as { type?: string; text?: string };
                return obj.type === "text" ? (obj.text ?? "") : `[${obj.type ?? "block"}]`;
              })
              .join("\n");
            throw new Error(text || `工具 ${name} 执行失败`);
          }
          return normalizeToolValue(result.structuredContent ?? result.content);
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
  // 任务面查询（程序内）：机械扫描在宿主，筛选/归约在程序里——正则跑在 worker（terminate 兜底），宿主没有隔离
  table[TASK_RECORDS_BINDING_NAME] = async (args) => {
    const records = session.registry.list();
    if ((args as { scope?: string } | undefined)?.scope !== "all") return records;
    return [...records, ...(await session.readArchivedRecords())];
  };
  // 任务产出（程序内）：归约层——孩子的散文正文；wait:false 派发后取不回的正文在这里取回
  table[TASK_OUTPUT_BINDING_NAME] = createTaskOutputBinding(session);
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
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("recent"), Type.Literal("all")], {
          description: "recent = 只热存（默认）；all = 含压缩归档（更全但更慢）",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "取多少条（默认 50，上限 200）" })),
      status: Type.Optional(
        Type.Union(
          TASK_STATUSES.map((s) => Type.Literal(s)),
          {
            description: "只看某个状态",
          },
        ),
      ),
      session: Type.Optional(
        Type.String({ description: "按会话筛：current = 本会话，或给一个会话 id" }),
      ),
    }),
    defaultActive: false,
    execute: async (_id, args) => {
      const query = {
        scope: args.scope,
        limit: args.limit,
        status: args.status,
        session: args.session === "current" ? session.sessionId : args.session,
      };
      const archived = query.scope === "all" ? await session.readArchivedRecords() : [];
      return textResult(taskListSnapshot(session.registry, query, archived));
    },
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
      // 归约层：孩子的散文答案（报告是摘要，交付物是这段正文）——从事件流现算，不另存
      return textResult(
        withDeliveryNote({ ...record, ...(await readTaskOutput(session, record)) }),
      );
    },
  });
  registerTool({
    name: "ptc_task_stop",
    label: "停任务",
    description: TOOLS.ptc_task_stop.description(surface),
    parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
    defaultActive: false,
    execute: async (_id, args) => {
      const reason = args.reason ?? "user stop";
      await session.stopTask(args.task_id, reason);
      // 停完要回一句话：stopTask 是 void ⇒ 直接包 undefined ⇒ text 变 undefined ⇒ pi 下一轮崩
      return textResult({
        task_id: args.task_id,
        reason,
        status: session.registry.get(args.task_id)?.status,
      });
    },
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
