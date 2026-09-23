# General Review Checklist (default)

适用文件:未命中任何 path_rule_map 条目的所有文件。

## 必查

- 命名:导出名 / 公共函数名是否揭示用途?(Fowler Mysterious Name)
- 重复:相同形状的逻辑是否在多处出现?(Duplicated Code)
- 依赖:新引入的依赖是否必要、来源是否可信?
- 错误处理:IO 边界 / 失败路径是否有 warn 或显式错误状态?(不留静默失败)
- 文档同步:改变构建 / 测试 / 使用方式的代码是否同步更新了 README / AGENTS.md?

## 跳过

- linter / formatter / 类型检查已强制的项不重复报。
- 与本次 diff 无关的历史技术债不报(留给 refactor skill)。

## 反事实判据(每个新加的代码块)

> 把这段代码改成"显然错误但所有现有测试都过"的版本 — 还能过吗?
> 不能过 = 测试是 specification(防错误)。
> 还能过 = 测试是 characterization(防回归)或没被测试覆盖。
> 后者必须标出或补测试。

详细测试纪律见 tests/*.test.ts 对应的 test-discipline.md 规则。
