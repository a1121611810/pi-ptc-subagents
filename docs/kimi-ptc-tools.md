# Kimi Code 插件（ptc-tools）

Kimi 面：`ptc-tools` 插件给 Kimi Code 两件 MCP 工具，宿主自己的工具仍是编排器。

安装：

```text
/plugins install https://github.com/a1121611810/pi-ptc-subagents
```

裸仓库 URL 跟踪最新 GitHub Release（钉 tag 的 URL 没有更新检测）；装完 `/reload` 生效。

## 有新版本时你会知道

插件自带一个 `UserPromptSubmit` hook：它拿自己的版本（manifest 的 `version`）比 GitHub 最新
Release，不一致就把提示挂到你**下一条消息**上，模型会在回复里顺带告诉你「有新版 X（当前 Y）」
和更新命令。**不用配市场目录、不用改任何配置、不用点任何东西。**

更新：`/plugins install https://github.com/a1121611810/pi-ptc-subagents`（裸仓库 URL 装最新
Release）。

## 想要面板里的更新徽标（可选）

Kimi Code 也会对**市场目录能按 id 匹配上**的插件在 `/plugins` 里显示 `update 7.1.0 → 7.5.0`，
本仓也带了这样一份目录（`plugin-marketplace.json`）。但把 Kimi Code 指过去是**整体替换**默认
目录——官方插件会从面板里消失，连它们的更新通知也没了。**当可选项，别当配置步骤。**

## ptc_run_code({ code, description, workdir, timeoutMs? })

写一段 TypeScript 程序批量调工具（支持顶层 await / Promise.all / 循环），跑在与 pi 面
相同的 vm 运行格里。程序内工具是**固定文件四件套**：

- `read` / `grep` / `glob` / `edit`
- 所有路径 realpath 检查后囚禁在 `workdir` 内，越界即拒；`edit` 原子落盘、
  `old_string` 必须唯一匹配
- 没有 `bash`，没有 `pi_task_ptc`——要跑 shell 或派子代理，用 Kimi Code 自己的工具

默认 2 分钟超时，`timeoutMs` 可调。程序返回值是归约结果，中间产物不进上下文。

## web_ds_search（search / open / find）

联网搜索三动作：search 概览（默认 10 条）、open 抓整页、find 页内正则找行。
与 pi 面不同，这个工具**模型直接调用**，不必借道子代理。配额按 MCP server 进程计
（默认 30 次，`0` = 不限）；DeepSeek key 从 env 解析，落空再读 Kimi Code 的
`config.toml`。

## 子代理谁管

Kimi Code 自带 Agent 工具，派活交给宿主——本插件不重复造子代理门，这个面上没有
`pi_task_*` 系列。插件零配置，随附的 `ptc` skill 教模型什么时候写程序、什么时候逐个调。
