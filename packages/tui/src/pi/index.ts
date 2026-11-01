// pi 画面层（ADR-0022）：编辑器里给人看的东西。根入口不得 re-export 本文件——
// kimi-mcp 的构建 alias 指向 src/index.ts，根入口带出 pi 分面就会把 pi 宿主代码打进 Kimi 产物。
export { renderPtcResult, type PtcToolArgs, type PtcToolDetails } from "./render.ts";
export {
  MAX_PANEL_LABEL_CHARS,
  MAX_PANEL_ROWS,
  renderTaskPanel,
  TASK_PANEL_KEY,
} from "./task-panel.ts";
