// ADR-0013 §6：渲染上限的冻结契约值——改任何一个都要新 ADR；渲染器一律引用这里
export const RENDER_BOUNDS = {
  MAX_RESULT_HINT_CHARS: 60, // 折叠行右侧的值提示
  MAX_ERROR_CHARS: 120, // 错误摘要
  MAX_CODE_LINES_EXPANDED: 3, // 展开视图里程序代码最多行数
  MAX_LOG_LINES_EXPANDED: 12, // 展开视图里日志最多行数
  VALUE_TREE_MAX_DEPTH: 4, // 完成值树深度
  VALUE_TREE_MAX_CHILDREN: 6, // 每层最多子项
  VALUE_TREE_MAX_LINE_CHARS: 120, // 值树单行上限
} as const;
