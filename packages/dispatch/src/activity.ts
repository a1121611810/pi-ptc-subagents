// 孩子的活动跟踪：判「孩子什么都没在做」（停滞）——宿主自愈护栏的依据。
//
// 口径要窄，两条同时成立才算停滞：
//   ① 距上次有动静（stdout 有新字节）超过阈值
//   ② 没有在飞的工具调用（tool_execution_start 已来、tool_execution_end 未到）
//
// 为什么只有两条：模型回合在飞**不能**当豁免——pi 的 assistant message_start 是在
// provider 的 start 事件**之后**才发的，等首 token 那段静默本来就不在豁免里；
// 而真把「回合在飞」算豁免，会给「生成到一半卡死」留一个永远收不掉的洞。
// 上下文压缩同理（agent-loop 只 emit 6 种事件，没有 compaction）——压缩期间是静默的。
// ⇒ 误杀面只剩「provider 等首 token」与「一次压缩」这两段空档，
//   所以阈值必须大于它们的耗时（默认 5 分钟）。
//
// 抓不到的：工具循环（同一个命令反复调）——孩子一直在出声，不是停滞。
// 那要模型判进展，不是计时器能做的。
//
// 事件形状（floor 0.86 与 1.4.0 实测同构）：
//   tool_execution_start {toolCallId, toolName, args}
//   tool_execution_end   {toolCallId, toolName, result, isError}

/** 停滞阈值默认 5 分钟 */
export const DEFAULT_STALL_MS = 5 * 60_000;

/** 护栏的检查间隔（秒级问一次就够——阈值本身是分钟量级） */
export const STALL_CHECK_INTERVAL_MS = 1_000;

export class ChildActivityTracker {
  #buffer = "";
  #lastActivityAt: number;
  /** 在飞的工具调用计数（嵌套调用靠计数，不靠集合——start/end 成对进出） */
  #toolOpen = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#lastActivityAt = now();
  }

  /** 喂一段 stdout 增量（chunk 边界不按行切 ⇒ 自己攒半行） */
  push(chunk: string): void {
    this.#lastActivityAt = this.#now();
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      this.#consume(this.#buffer.slice(0, index));
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
    }
  }

  /** 两条都成立 ⇒ 孩子什么都没在做 */
  isStalled(now: number, thresholdMs: number): boolean {
    if (this.#toolOpen > 0) return false;
    return now - this.#lastActivityAt >= thresholdMs;
  }

  #consume(line: string): void {
    const trimmed = line.trim();
    // 只认工具的两类事件；其余（message_update 等）不必解析——stdout 有新字节已经算动静
    if (!trimmed.includes('"tool_execution_start"') && !trimmed.includes('"tool_execution_end"')) {
      return;
    }
    let event: { type?: string };
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === "tool_execution_start") {
      this.#toolOpen++;
    } else if (event.type === "tool_execution_end") {
      this.#toolOpen = Math.max(0, this.#toolOpen - 1);
    }
  }
}
