// 旧 ADR-0013 §6 的渲染上限冻结表 + 值树契约（ADR-0016 修订）：
// 重写的折叠 renderer 是另一个有意简化的设计（无值提示位/折叠错误行/code 块），
// 旧表随富行 renderer 退役的三个上限由 ADR-0016 正式除名；登记在册的即现行契约，改任何一个都要新 ADR
export const RENDER_BOUNDS = {
  MAX_LOG_LINES_EXPANDED: 12, // 展开视图里日志最多行数
  VALUE_TREE_MAX_DEPTH: 4, // 完成值树深度
  VALUE_TREE_MAX_CHILDREN: 6, // 每层最多子项
  VALUE_TREE_MAX_LINE_CHARS: 120, // 值树单行上限
} as const;
