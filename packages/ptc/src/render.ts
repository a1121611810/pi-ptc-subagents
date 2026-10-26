import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

// pi 的 index 不 re-export ToolRenderContext；渲染器只用 args，取最小结构（参数逆变性保证可赋值）
interface ToolRenderContextLike {
  args: unknown;
}
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { RENDER_BOUNDS } from "@pi-ptc/tui";

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

// ADR-0013：折叠 = 标题 + 状态一行；展开 = 代码/日志/结果，上限吃 RENDER_BOUNDS 冻结表
// shortcut: shimmer 动画（ADR-0020）与五态颜色未做——等真实使用中对「运行中辨识度」有诉求再加
export function renderPtcResult(surface: "run_code" | "workflow") {
  return (
    result: AgentToolResult<PtcToolDetails>,
    options: ToolRenderResultOptions,
    _theme: Theme,
    context: ToolRenderContextLike,
  ): Component => {
    const args = context.args as PtcToolArgs;
    const box = new Box();
    const title =
      surface === "workflow" ? `workflow · ${args.meta?.name ?? ""}` : (args.description ?? "程序");
    box.addChild(new Text(options.isPartial ? `${title} …` : title));

    const details = result.details as PtcToolDetails | undefined;
    if (!options.isPartial && details) {
      const flags = [
        details.status,
        details.truncated ? "已截断" : "",
        details.fullOutputPath ? `全文在 ${details.fullOutputPath}` : "",
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
