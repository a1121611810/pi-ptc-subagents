import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TaskRecord } from "@pi-ptc/dispatch";
import { renderTaskPanel, TASK_PANEL_KEY } from "./task-panel.ts";

/** 面板要的两样东西：记录列表 + 变迁通知（registry 的真实接口长这样，测试也能塞个假的） */
export interface TaskPanelSource {
  list(): readonly TaskRecord[];
  subscribe(listener: (next: TaskRecord, prev: TaskRecord | null) => void): void;
}

/**
 * 常驻面板的接线（ADR-0022）：登记 widget、记录一变就重画、退出时卸载。
 * 没有 ui（print/json 模式）⇒ 什么都不做——那两种模式下 pi 的 ctx.ui 是空实现。
 */
export function createTaskPanel(options: {
  ui?: ExtensionUIContext;
  source: TaskPanelSource;
  sessionId?: string;
}): { dispose(): void } {
  const { ui, source, sessionId } = options;
  if (!ui) return { dispose() {} };
  let disposed = false;
  const refresh = (): void => {
    if (disposed) return;
    const lines = renderTaskPanel(source.list(), ui.theme, sessionId);
    ui.setWidget(TASK_PANEL_KEY, lines.length > 0 ? lines : undefined);
  };
  source.subscribe(refresh);
  refresh();
  return {
    dispose(): void {
      disposed = true;
      ui.setWidget(TASK_PANEL_KEY, undefined);
    },
  };
}
