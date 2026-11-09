// 任务面两个工具的 pi 折叠渲染（ADR-0022 的 pi 画面层）：折叠 = 标题 + 状态一行；展开 = 内容
// 状态字形与颜色复用常驻面板的 STATUS_STYLE（同一张表，不造第二张）
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "@pi-ptc/dispatch";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { RENDER_BOUNDS } from "../bounds.ts";
import { sanitizeText, truncateLine } from "../text.ts";
import { STATUS_STYLE } from "./task-panel.ts";

export type TaskFaceDetails =
  | {
      kind: "list";
      scope: "recent" | "all";
      /** 候选总数（列出的条数之外还有多少） */
      total: number;
      /** 实际列出的条数 */
      listed: number;
      /** 在飞的条数 */
      inFlight: number;
      rows: { id: string; status: TaskStatus; label?: string }[];
    }
  | {
      kind: "output";
      id: string;
      status: TaskStatus;
      /** 展开视图要显示的正文摘录 */
      excerpt: string;
      /** 正文总行数（用来明说省略了多少） */
      totalLines: number;
    };

/**
 * 展开视图的正文摘录：行数吃 RENDER_BOUNDS.MAX_LOG_LINES_EXPANDED，单行吃 truncateLine 的冻结上限。
 * details 只带摘录不带全文——details 若在某个 pi 版本里进了模型上下文，全文会被双份计费。
 */
export function excerptForDisplay(text: string): { excerpt: string; totalLines: number } {
  const lines = sanitizeText(text).split("\n");
  return {
    excerpt: lines
      .slice(0, RENDER_BOUNDS.MAX_LOG_LINES_EXPANDED)
      .map((line) => truncateLine(line))
      .join("\n"),
    totalLines: lines.length,
  };
}

/** 没有 details 时的兜底：把结果原文逐行塞进盒子（别把人看到的字弄丢）——task/progress 两个 face 共用 */
export function addRawContentFallback(
  box: Box,
  content: ReadonlyArray<{ type: string; text?: string }>,
): void {
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const lines = block.text.split("\n").slice(0, RENDER_BOUNDS.MAX_LOG_LINES_EXPANDED);
    for (const line of lines) box.addChild(new Text(line));
  }
}

/** 任务面工具的折叠渲染：details 决定形状；没有 details 就显示原文（别把人看到的字弄丢） */
export function renderTaskFaceResult(
  result: AgentToolResult<TaskFaceDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const box = new Box();
  const details = result.details;
  if (!details) {
    addRawContentFallback(box, result.content);
    return box;
  }
  if (details.kind === "list") {
    const { scope, total, listed, inFlight, rows } = details;
    const head = `任务列表${scope === "all" ? "（含归档）" : ""} · ${listed} 条 · ${inFlight} 在飞`;
    box.addChild(new Text(total > listed ? `${head} · 还有 ${total - listed} 条未列` : head));
    if (options.expanded) {
      for (const row of rows) {
        const style = STATUS_STYLE[row.status];
        const label = row.label ? ` · ${truncateLine(sanitizeText(row.label))}` : "";
        box.addChild(
          new Text(
            `${theme.fg("dim", row.id)} · ${theme.fg(style.color, `${style.glyph} ${row.status}`)}${label}`,
          ),
        );
      }
      if (listed > rows.length) {
        box.addChild(new Text(`…（共 ${listed} 条，省略 ${listed - rows.length} 条）`));
      }
    }
    return box;
  }
  const { id, status, excerpt, totalLines } = details;
  const style = STATUS_STYLE[status];
  box.addChild(
    new Text(
      `任务产出 · ${theme.fg("dim", id)} · ${theme.fg(style.color, `${style.glyph} ${status}`)}`,
    ),
  );
  if (options.expanded) {
    const lines = excerpt ? excerpt.split("\n") : [];
    for (const line of lines) box.addChild(new Text(line));
    if (lines.length === 0) box.addChild(new Text(theme.fg("muted", "（无正文）")));
    if (totalLines > lines.length) {
      box.addChild(new Text(`…（共 ${totalLines} 行，省略 ${totalLines - lines.length} 行）`));
    }
  }
  return box;
}
