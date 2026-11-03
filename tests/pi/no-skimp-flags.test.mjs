// 别省真跑开关（noSkimpPtc / noSkimpSub）：配置读取 → 系统提示词新节 → /ptc 子命令 → 孩子 argv → TUI 横幅
// 断言全由宿主自己看：模型不参与（旋钮是宿主层的，模型行为的量法见 bench/ab）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 agent 目录：ptc.json 在这里读（getAgentDir() 每次调用现读环境变量，不缓存）
const agentDir = mkdtempSync(join(tmpdir(), "ptc-no-skimp-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const configPath = join(agentDir, "ptc.json");
const writeConfig = (config) => writeFileSync(configPath, JSON.stringify(config));
const clearConfig = () => rmSync(configPath, { force: true });

// 工作区也隔离：storageDir 落在 cwd/.pi/ptc-tasks，别写仓库
process.chdir(mkdtempSync(join(tmpdir(), "ptc-no-skimp-ws-")));

const { default: entryDefault } = await import("../../packages/entry/dist/index.js");
const { buildPiArgv, NO_SKIMP_SUB_NOTE } = await import("../../packages/dispatch/dist/index.js");
const { renderNoSkimpBanner, NO_SKIMP_BANNER_KEY } = await import("../../packages/tui/dist/pi.js");
const { NO_SKIMP_PTC_NOTE } = await import("../../packages/routes/dist/index.js");

const NOTE_HEAD = "Do not skimp on the real run";

function fakePi({ tui = false } = {}) {
  const handlers = {};
  const commands = {};
  const widgets = [];
  let active = [];
  const pi = {
    on: (event, cb) => {
      (handlers[event] ??= []).push(cb);
    },
    registerTool: () => {},
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
    getAllTools: () => [],
    sendMessage: () => {},
  };
  const ctx = {
    mode: tui ? "tui" : "print",
    ui: {
      notify: () => {},
      theme: { fg: (_color, text) => text },
      setWidget: (key, lines) => widgets.push([key, lines]),
    },
  };
  return { pi, ctx, handlers, commands, widgets };
}

async function startSession(options) {
  const fake = fakePi(options);
  entryDefault(fake.pi);
  await fake.handlers.session_start[0]({}, fake.ctx);
  return fake;
}

/** 跑一次 before_agent_start，返回宿主看到的系统提示词分节 */
function sectionsOf(fake) {
  const sections = {};
  fake.handlers.before_agent_start[0]({ systemPromptOptions: { sections } });
  return sections;
}

const childBlock = (input) => {
  const argv = buildPiArgv({ task: "t", ...input }, { depth: 0 });
  return argv[argv.indexOf("--append-system-prompt") + 1];
};

test("默认关：没有 ptc.json ⇒ 父面无新节、孩子 argv 无该段、横幅不登记", async () => {
  clearConfig();
  const fake = await startSession();
  assert.equal(sectionsOf(fake)["no_skimp"], undefined);
  assert.ok(!childBlock({}).includes(NOTE_HEAD));
  assert.equal(fake.widgets.length, 0, "非 TUI 模式不该登记 widget");
});

test("配置开：父面系统提示词多一段，孩子 argv 带同一段，互不串味", async () => {
  writeConfig({ noSkimpPtc: true, noSkimpSub: true });
  const fake = await startSession();
  assert.equal(sectionsOf(fake)["no_skimp"], NO_SKIMP_PTC_NOTE);
  assert.ok(childBlock({ noSkimpSub: true }).includes(NO_SKIMP_SUB_NOTE));
  // 只开父面 ⇒ 孩子那边没有
  writeConfig({ noSkimpPtc: true });
  const ptcOnly = await startSession();
  assert.equal(sectionsOf(ptcOnly)["no_skimp"], NO_SKIMP_PTC_NOTE);
  assert.ok(!childBlock({}).includes(NOTE_HEAD));
});

test("/ptc noskimp on|off|reset：会话级切换，reset 回到配置文件的值", async () => {
  writeConfig({ noSkimpPtc: true });
  const fake = await startSession();
  const cmd = { ui: { notify: () => {} } };
  assert.equal(sectionsOf(fake)["no_skimp"], NO_SKIMP_PTC_NOTE, "配置文件开着 ⇒ 起始即开");
  await fake.commands.ptc.handler("noskimp off", cmd);
  assert.equal(sectionsOf(fake)["no_skimp"], undefined);
  await fake.commands.ptc.handler("noskimp reset", cmd);
  assert.equal(sectionsOf(fake)["no_skimp"], NO_SKIMP_PTC_NOTE, "reset ⇒ 回到配置文件的值");
});

test("TUI 横幅：开着常驻显示，关掉即卸载", async () => {
  writeConfig({ noSkimpPtc: true });
  const fake = await startSession({ tui: true });
  const calls = () => fake.widgets.filter(([key]) => key === NO_SKIMP_BANNER_KEY);
  assert.ok(calls().length > 0, "横幅 widget 应已登记");
  assert.ok(calls()[0][1].join("\n").includes("double-edged sword"));
  await fake.commands.ptc.handler("noskimp off", { ui: { notify: () => {} } });
  assert.equal(calls().at(-1)[1], undefined, "关掉后横幅应卸载");
});

test("横幅渲染：两个开关都关 ⇒ 空数组（宿主据此卸载）", () => {
  const theme = { fg: (_color, text) => text };
  assert.deepEqual(renderNoSkimpBanner({ noSkimpPtc: false, noSkimpSub: false }, theme), []);
  assert.ok(renderNoSkimpBanner({ noSkimpPtc: true, noSkimpSub: false }, theme).length > 0);
});
