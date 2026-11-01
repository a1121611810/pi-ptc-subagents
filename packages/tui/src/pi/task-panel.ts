import type { TaskRecord, TaskStatus } from "@pi-ptc/dispatch";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateLine } from "../text.ts";

/** 面板的宿主 widget key——同 key 覆盖 ⇒ /reload 与重复注册都幂等（pi 的 setExtensionWidget 先删旧再设新） */
export const TASK_PANEL_KEY = "ptc-tasks";

/** 冻结上限（ADR-0022 §8）：派生自宿主 widget 的 10 行上限，给标题与溢出行留余量 */
export const MAX_PANEL_ROWS = 6;

/** 冻结上限（ADR-0022 §8）：沿用旧 ADR-0022 §11 的 MAX_LABEL_CHARS——同一个 label 字段、同一个上限 */
export const MAX_PANEL_LABEL_CHARS = 48;

// 状态 → 字形/颜色（ADR-0022 §8 冻结表）：旧仓只把它写在实现里，从未落纸
const STATUS_STYLE: Record<TaskStatus, { glyph: string; color: ThemeColor }> = {
  queued: { glyph: "○", color: "muted" },
  running: { glyph: "●", color: "accent" },
  stopping: { glyph: "◐", color: "warning" },
  succeeded: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  canceled: { glyph: "⊘", color: "muted" },
  lost: { glyph: "?", color: "dim" },
};

const IN_FLIGHT: readonly TaskStatus[] = ["queued", "running", "stopping"];

function clockOf(startedAt: number): string {
  const d = new Date(startedAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 面板行（纯函数）：本会话进行中的子代理逐条 + 计数标题；没有进行中的任务 ⇒ 空数组（宿主据此卸载面板）。
 * 只出字符串数组——宿主自带 10 行上限，pi-tui 的 Text 保留 ANSI ⇒ 颜色直接由 theme.fg 上。
 *
 * 只看本会话的记录：registry 启动时会把磁盘上的历史会话记录一并恢复（真机实测：标题一度写「succeeded 180」——
 * 那是上一轮会话攒下的）。sessionId 缺失时不筛（老记录没有这个字段）。
 */
export function renderTaskPanel(
  records: readonly TaskRecord[],
  theme: Theme,
  sessionId?: string,
): string[] {
  const mine = sessionId ? records.filter((record) => record.sessionId === sessionId) : records;
  const inFlight = mine.filter((record) => IN_FLIGHT.includes(record.status));
  if (inFlight.length === 0) return [];

  const count = (status: TaskStatus): number =>
    mine.filter((record) => record.status === status).length;
  const lines = [
    theme.fg(
      "accent",
      `Tasks · ${inFlight.length} running · ${count("succeeded")} succeeded · ${count("failed")} failed`,
    ),
  ];

  const shown = inFlight.slice(0, MAX_PANEL_ROWS);
  for (const [index, record] of shown.entries()) {
    const style = STATUS_STYLE[record.status];
    const label = truncateLine(record.label ?? record.task, MAX_PANEL_LABEL_CHARS);
    const last = index === shown.length - 1 && inFlight.length <= MAX_PANEL_ROWS;
    lines.push(
      theme.fg("dim", last ? "└─ " : "├─ ") +
        theme.fg(style.color, `${style.glyph} ${label}`) +
        (record.startedAt ? theme.fg("dim", ` · ${clockOf(record.startedAt)}`) : ""),
    );
  }
  if (inFlight.length > MAX_PANEL_ROWS) {
    lines.push(theme.fg("dim", `└─ …${inFlight.length - MAX_PANEL_ROWS} more`));
  }
  return lines;
}
