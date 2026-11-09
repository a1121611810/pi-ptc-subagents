// 同形态工具调用的分类器与连续运行检测器——adoption-mining（事后度量）与 kimi-nudge（当场闸门）共用的单一事实源。
// 改动启发式时两边同时生效；语义：classifyTool 返回 null 的形态对「连续」透明（不计数、不打断 run）。
export const RUN_THRESHOLD = 5;
export const NUDGE_BUDGET = 4; // 每会话最多提醒 4 次，防连环 nag

const PTC_RUN_CODE = /mcp__plugin-ptc-tools.*__ptc_run_code/;
const PTC_WEBDS = /mcp__plugin-ptc-tools.*__web_ds_search/;
// Bash 纯读：mining 原启发式——命令以只读工具开头，或管道后接只读工具
const BASH_SHELL_READ =
  /^\s*(grep|rg|find|cat|head|tail|ls|wc|sed -n)\b|\|\s*(grep|head|tail|wc)\b/;

export function classifyTool(name, toolInput) {
  if (PTC_RUN_CODE.test(name)) return null; // ptc 自身不参与
  if (PTC_WEBDS.test(name)) return null; // 联网三动作暂不进闸门（v1 只收文件扇出）
  if (name === "Bash") return BASH_SHELL_READ.test(toolInput?.command ?? "") ? "BashRead" : null;
  if (name === "Read") return "Read";
  if (name === "Grep") return "Grep";
  if (name === "Glob") return "Glob";
  if (name === "Edit") return "Edit";
  if (name === "Write") return "Write";
  return null;
}

// 给阻断理由用的人话标签
export const SHAPE_LABELS = {
  Read: "逐个 Read 读文件",
  Grep: "Grep 扇出",
  Glob: "Glob 找文件",
  Edit: "Edit 同刀法改",
  Write: "Write 连续写",
  BashRead: "Bash 纯读（grep/cat/head 等）",
};

// 连续同形态检测。step() 每来一次同形态调用返回是否到达阈值（恰第 N 次触发一次，触发后 run 归零——
// 被拦的调用原样重试时从 1 重新计，不会连环拦）。null 形态透明。state 是普通对象，由调用方持久化。
export class RunDetector {
  constructor(state = {}) {
    this.state = { lastShape: null, runLen: 0, fired: 0, ...state };
  }

  // 返回 true = 本次调用到达阈值，该发提醒
  step(shape) {
    if (shape === null || shape === undefined) return false;
    const s = this.state;
    if (shape === s.lastShape) {
      s.runLen += 1;
    } else {
      s.lastShape = shape;
      s.runLen = 1;
    }
    if (s.runLen === RUN_THRESHOLD && s.fired < NUDGE_BUDGET) {
      s.runLen = 0; // 归零：重试放行，再来 5 连才第二次提醒
      s.fired += 1;
      return true;
    }
    return false;
  }
}
