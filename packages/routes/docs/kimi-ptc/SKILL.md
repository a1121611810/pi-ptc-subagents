---
name: ptc
description: 批量调工具时把循环写进程序（ptc_run_code），别看一堆原始工具输出
---

# PTC：程序批量调工具

宿主是 Kimi Code 时，重复性的机械扇出（读几十个文件再汇总、批量改写同类代码）不要逐个调工具——把循环写进一段 TypeScript 程序，一次 `ptc_run_code` 跑完，上下文里只回一份归约结果。

## 什么时候写程序（动手前先勾这条）

**命中任一，就该写程序：**

- 同一形态的读写预计 **≥5 处**（多文件同一刀法的改、同一 pattern 的查）
- 要读 **≥20 个文件**再把结果归约汇总（统计、出清单、对账）
- 批量小改且锚点已知（old_string 能精确写出）

**都不命中，就别写：**

- 探索期的头几个探测调用——先逐个摸清结构，形态确定了再说批量化
- 要 shell 的活（四件套没有 bash，判不动就别硬塞）
- 总共 ≤3 次调用——写程序、想 workdir、担超时的成本不划算
- 单步要判断/审批敏感的（写生产数据、删文件）——逐步来，别把批准权交给循环

## 工具形态

- `ptc_run_code({ code, description, workdir })`：程序体内 `await tools.<name>(args)`，支持顶层 await / Promise.all 并行 / 循环与条件；程序 `return` 的值是唯一回到上下文的结果
- 程序里的 `tools` 是**固定文件四件套**（以下返回形态都实测，照抄即可，不用猜）：

```ts
// read：返回整个文件内容的纯字符串（不是对象；没有行号参数）
const text = await tools.read({ path: "src/a.ts" }); // → string

// glob：返回相对路径字符串数组（相对 workdir）
const files = await tools.glob({ pattern: "src/**/*.ts" }); // → string[]

// grep：返回 "相对路径:行号: 行内容" 字符串数组；无命中是空数组（不报错）
const hits = await tools.grep({ pattern: "TODO", path: "src" }); // → string[]；path 可省略（搜整个 workdir）或给单个文件

// edit：old_string 必须在文件中唯一匹配，原子落盘；返回 { edited: "相对路径" }
await tools.edit({ path: "src/a.ts", old_string: "foo", new_string: "bar" });
```

- 四件套只在 `workdir` 内活动（越界即报错，可用 try/catch 捕获）；没有 bash，也没有子代理派发——要跑 shell 或派子代理，用宿主自己的工具
- `workdir` 传用户工作区的绝对路径——插件按用户安装、对所有项目生效，不主动限定项目是你替用户做的安全决定

## 联网搜索（三动作）

- `web_ds_search({ action, query?, url?, pattern?, count? })`：三动作——`search` 搜索概览（title/url/snippet）· `open` 抓整页 · `find` 页内行匹配。单查一次可直调本工具；需要批量取证时把它写进 `ptc_run_code` 的程序里，证据和其它结果一起归约回来
- 配额按插件进程计（默认 30 次/进程，open/find 命中本会话记忆不重复消耗）——**不是跨会话的全局限额**；需要更多时模型应在程序里合并查询而不是反复调用

## 结果与错误

程序日志随结果一起回来；超渲染上限会砍头留尾并给出全文临时文件路径。工具报错程序内可见（读返回的 `status`），不捕获就会让整个程序以 `[rejected]` 收场——预期内的失败自己 try/catch。
