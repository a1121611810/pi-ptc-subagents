// 进展更新的 pi 折叠渲染（Kimi NotifyUser 的 pi 移植）：折叠 = 头部一行；展开 = 头部 + 缩进正文
// 层级三级：accent 加粗「▸ 进展更新」铬件 → 加粗标题（内容主体）→ 正文普通字重；省略说明 muted
// 与 task-face 同契约：details 只带展示用的小字段（摘录不带全文），截断吃 RENDER_BOUNDS 冻结表
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { truncateLine } from "../text.ts";
import { addRawContentFallback } from "./task-face.ts";

export interface ProgressFaceDetails {
  title: string;
  excerpt: string;
  totalLines: number;
}

/** 进展更新的折叠渲染：details 决定形状；没有 details 就显示原文（别把人看到的字弄丢） */
export function renderProgressFaceResult(
  result: AgentToolResult<ProgressFaceDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const box = new Box();
  const details = result.details;
  if (!details) {
    addRawContentFallback(box, result.content);
    return box;
  }
  const { title, excerpt, totalLines } = details;
  // 折叠 ▸ / 展开 ▾：把「可展开」画在脸上（终端没有悬停态可依赖）
  const marker = options.expanded ? "▾" : "▸";
  // shortcut: theme.bold/italic 走 chalk，pi 宿主内 chalk level=0 是 no-op；加粗必须走 theme.style({bold})
  box.addChild(
    new Text(
      `${theme.style(`${marker} 进展更新`, { fg: "accent", bold: true })}${theme.fg(
        "dim",
        " · ",
      )}${theme.style(truncateLine(title || "（无标题）"), { bold: true })}`,
    ),
  );
  if (options.expanded) {
    const lines = excerpt ? excerpt.split("\n") : [];
    for (const line of lines) box.addChild(new Text(`  ${line}`));
    if (lines.length === 0) box.addChild(new Text(`  ${theme.fg("muted", "（无正文）")}`));
    if (totalLines > lines.length) {
      box.addChild(
        new Text(
          `  ${theme.fg("muted", `…（共 ${totalLines} 行，省略 ${totalLines - lines.length} 行）`)}`,
        ),
      );
    }
  }
  return box;
}
