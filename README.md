# pi-ptc-subagents

Programmable tool calling (PTC) and subagent fan-out for [pi](https://pi.dev).

当前 `main` 是**干净室重写版**（7 包 pnpm workspace，按 ADR/spec 重写，不抄旧实现源码）。
旧实现归档在 `backup/main-legacy-20261026` 分支。

## 能力

- **PTC**：`ptc_run_code` / `ptc_workflow` 让模型写 TypeScript 程序，程序里用 `tools.<name>(args)`
  批量调会话工具；程序在 worker 线程严格模式跑，回到模型的只有返回值、日志与产出的归约结果。
- **子代理派发**：`pi_task_ptc`（程序内 binding）与 `pi_task_codemode`（codemode 脚本内）建任务，
  由派发引擎起独立 `pi` 子进程执行；排队-槽模型（满员排队不拒绝）、报告两通道
  （`ptc_child_report` 工具优先 / 末尾 JSON 兜底）、可查可停。
- **任务面**：`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`，有任务记录才出现在模型面前。
- **联网搜索**：`web_ds_search`（DeepSeek，search/open/find 三动作）只在子代理进程注册，默认关。

## 本地开发

```bash
pnpm install
pnpm build            # rolldown，产物在各包 dist/
pi -ne -e packages/entry/dist/index.js   # -ne：禁用其它扩展发现，防止同名扩展互踩
```

门禁（改动后四件套全绿才算完）：

```bash
pnpm run check        # tsrs 类型检查
pnpm run build
pnpm run lint         # oxlint
pnpm run fmt:check    # oxfmt
```

## 仓库结构

| 包                  | 职责                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `packages/entry`    | pi 扩展装配：session_start 注册、surface 检测、PTC 模式、通知投递         |
| `packages/ptc`      | 程序运行时：worker 池、dispatcher、严格模式编译、PTC 工具工厂             |
| `packages/dispatch` | 任务引擎：闸门、槽、spawn/pump、registry（落盘+重启恢复）、报告、通知中心 |
| `packages/task`     | 任务面的读/停语义（叶子调用方）                                           |
| `packages/tui`      | 渲染原语叶子：文本卫生、截断契约、渲染预算                                |
| `packages/routes`   | 模型面散文唯一出处：路由册 + 渲染器                                       |
| `packages/search`   | 搜索 provider（DeepSeek）：三动作工具、配额、记忆、预算                   |

## 兼容性

pi `>= 0.86.0`。真机冒烟覆盖 0.86.0 / 0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3 / 1.4
（含程序内派发真子进程），见 [docs/pi-version-matrix.md](./docs/pi-version-matrix.md)。

## 文档

- [AGENTS.md](./AGENTS.md) — 工程约定与硬规矩
- [docs/adr/](./docs/adr/) — 决策记录（0001–0015）
- [docs/prototypes/](./docs/prototypes/) — spec 与两份状态全景页
- [docs/research/](./docs/research/) — 历史证据笔记
- [docs/pi-version-matrix.md](./docs/pi-version-matrix.md) — pi 版本兼容矩阵

## License

Apache-2.0。见 [LICENSE](./LICENSE)。
