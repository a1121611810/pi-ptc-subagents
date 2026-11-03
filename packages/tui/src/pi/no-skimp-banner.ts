import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

/** 横幅的宿主 widget key——与任务面板各自独立容器（互不顶掉） */
export const NO_SKIMP_BANNER_KEY = "ptc-no-skimp";

export interface NoSkimpState {
  noSkimpPtc: boolean;
  noSkimpSub: boolean;
}

/**
 * 横幅行（纯函数）：开着才出内容，两个开关都关 ⇒ 空数组（宿主据此卸载横幅）。
 * 文案用英文——与仓库既有的英文 TUI 文案同族（任务面板标题行）。
 */
export function renderNoSkimpBanner(state: NoSkimpState, theme: Theme): string[] {
  const on = [state.noSkimpPtc ? "parent" : "", state.noSkimpSub ? "children" : ""].filter(Boolean);
  if (on.length === 0) return [];
  return [
    theme.fg("warning", `⚠ No-skimp mode on: ${on.join(" · ")}`),
    theme.fg(
      "dim",
      "  Run the real thing: real calls, end-to-end checks, no mock substitutes. A double-edged sword: slower, costlier runs.",
    ),
    theme.fg("dim", "  Off: /ptc noskimp off · /ptc noskimp-sub off"),
  ];
}

/**
 * 横幅接线：登记 widget、状态变就重画、退出时卸载。
 * 没有 ui（print/json 模式）⇒ 什么都不做——那两种模式下 pi 的 ctx.ui 是空实现。
 */
export function createNoSkimpBanner(options: {
  ui?: ExtensionUIContext;
  getState: () => NoSkimpState;
}): { refresh(): void; dispose(): void } {
  const { ui, getState } = options;
  if (!ui) return { refresh() {}, dispose() {} };
  let disposed = false;
  const refresh = (): void => {
    if (disposed) return;
    const lines = renderNoSkimpBanner(getState(), ui.theme);
    ui.setWidget(NO_SKIMP_BANNER_KEY, lines.length > 0 ? lines : undefined);
  };
  refresh();
  return {
    refresh,
    dispose(): void {
      disposed = true;
      ui.setWidget(NO_SKIMP_BANNER_KEY, undefined);
    },
  };
}
