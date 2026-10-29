# 批量调工具的一段程序（ptc_run_code）

`ptc_run_code({ code, description, timeoutMs? })`：code 是 TypeScript 程序体，
支持顶层 await 与 return。程序跑在 **vm 运行格**里：唯一的出口是 `tools.*`（与直调
同一条工具管线），没有 `process` / `fetch` / 动态 `import`（v7.0.0 起，ADR-0019，
用过它们的旧代码会断）。程序内 `tools.<name>(args)` 调工具：

- 绑定表 = 内置名单 ∩ 会话活跃工具（`--tools` 收窄的会话不会拿到被滤掉的绑定）
- `bash` 不在程序绑定表里——旧 ADR-0040 的 opt-in 尚未接线，当前没有任何开关能开它
- 程序返回值是归约后的结果；undefined 返回标记为「无完成值」

默认 2 分钟超时（可经 timeoutMs 调整）。输出超 50 KB 按 pi 截断契约切尾，
全文写在临时文件、路径进尾注。
