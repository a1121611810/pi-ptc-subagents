import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

// pi 的 index 不 re-export ToolRenderContext；渲染器只用 args，取最小结构（参数逆变性保证可赋值）
interface ToolRenderContextLike {
  args: unknown;
}
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { RENDER_BOUNDS } from "../bounds.ts";

export interface PtcToolDetails {
  status: "fulfilled" | "rejected" | "canceled";
  truncated?: boolean;
  fullOutputPath?: string;
  meta?: { name: string; description: string };
}

export interface PtcToolArgs {
  description?: string;
  meta?: { name: string; description: string };
}

// 状态色沿用常驻面板的 token 口径（task-panel.ts 的 STATUS_STYLE）：成功 success / 失败 error / 取消 warning
const STATUS_COLOR: Record<PtcToolDetails["status"], ThemeColor> = {
  fulfilled: "success",
  rejected: "error",
  canceled: "warning",
};

// 旧 ADR-0013：折叠 = 标题 + 状态一行；展开 = 代码/日志/结果，上限吃 RENDER_BOUNDS 冻结表
// shortcut: 不做 shimmer 动画——pi 的 Loader 组件要 TUI 实例（渲染上下文不给 ui），宿主每次更新都重建渲染组件（Component 无 dispose 钩子），自建计时器会泄漏；运行中辨识度靠宿主的 toolPendingBg 底色 + 标题的 ●
// upgrade: 真有人抱怨「看不出在跑」时先加静态字形/文字；真动画须先按 ADR-0016 §3 增补 RENDER_BOUNDS
export function renderPtcResult(surface: "run_code" | "workflow") {
  return (
    result: AgentToolResult<PtcToolDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContextLike,
  ): Component => {
    const args = context.args as PtcToolArgs;
    const box = new Box();
    const title =
      surface === "workflow" ? `workflow · ${args.meta?.name ?? ""}` : (args.description ?? "程序");
    box.addChild(new Text(options.isPartial ? theme.fg("accent", "● ") + `${title} …` : title));

    const details = result.details as PtcToolDetails | undefined;
    if (!options.isPartial && details) {
      const flags = [
        theme.fg(STATUS_COLOR[details.status], details.status),
        details.truncated ? theme.fg("muted", "已截断") : "",
        details.fullOutputPath ? theme.fg("muted", `全文在 ${details.fullOutputPath}`) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      box.addChild(new Text(flags));
    }

    if (options.expanded && !options.isPartial) {
      for (const block of result.content) {
        if (block.type !== "text") continue;
        const lines = block.text.split("\n");
        const kept = lines.slice(0, RENDER_BOUNDS.MAX_LOG_LINES_EXPANDED);
        for (const line of kept) box.addChild(new Text(line));
        if (lines.length > kept.length) {
          box.addChild(
            new Text(`…（共 ${lines.length} 行，省略 ${lines.length - kept.length} 行）`),
          );
        }
      }
    }
    return box;
  };
}
