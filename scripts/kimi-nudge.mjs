// ptc-tools 采用率闸门（Kimi 面）：PreToolUse 拦截——同一形态工具连打 ≥5 次时阻断第 5 次，
// 把「这类活该写成一次 ptc_run_code 程序」写回模型上下文（探针实测：exit 2 + stderr 是 observation-only
// 事件之外唯一可达模型上下文的钩子通道；PostToolUse stdout 到不了）。
// 文案纪律（探针实测）：只陈述已加载 skill 的既有规则 + 给重试出口，不发新指令——注入防御会折扣命令式文本。
// fail-open：自身任何异常都 exit 0 放行；PTC_NUDGE=0 可整体关停。
import { classifyTool, RunDetector, RUN_THRESHOLD, SHAPE_LABELS } from "./lib/tool-shape.mjs";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(tmpdir(), "ptc-tools-nudge");

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (c) => {
      input += c;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", () => resolve(input));
  });
}

// 并行工具调用会并发触发本钩子，状态文件加排他锁串行化（最多等 1s，远小于 hook timeout 5s）
function withLock(path, fn) {
  const lockPath = `${path}.lock`;
  let fd = null;
  for (let i = 0; i < 50; i++) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

const input = await readStdin();
if (process.env["PTC_NUDGE"] === "0") process.exit(0);
try {
  const p = JSON.parse(input);
  const shape = classifyTool(p.tool_name ?? "", p.tool_input ?? {});
  if (shape === null) process.exit(0);

  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, `${p.session_id ?? "unknown"}.json`);
  const fire = withLock(statePath, () => {
    let state = {};
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {}
    const detector = new RunDetector(state);
    const hit = detector.step(shape);
    try {
      writeFileSync(statePath, JSON.stringify(detector.state));
    } catch {}
    return hit;
  });

  if (fire) {
    const label = SHAPE_LABELS[shape] ?? shape;
    console.error(
      `ptc-tools 插件：这是连续第 ${RUN_THRESHOLD} 次${label}。本会话已加载的 ptc skill 路由规则：` +
        `这类批量活优先写成一次 ptc_run_code 程序（程序内 tools 五件套 read/write/edit/grep/glob）。` +
        `若判断当前确需单步，原样重试本调用即可。`,
    );
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // fail-open：钩子异常永不阻断用户
}
