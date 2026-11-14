// pi 面能力分片（Slice 2 · 派发链）：16 条能力 / 28 条 mutant。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
// 打法约定：每条 mutant 只打**一个**实现决策；kills 指向**唯一**一条用例标题——
// 别的用例跟着红不判红（归属核对只要求 kills 那条红），但越少越好。
export default {
  capabilities: [
    {
      id: "gates",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "gates.task-leading-dash",
          file: "packages/dispatch/src/gates.ts",
          from: '    : input.task.trimStart().startsWith("-")',
          to: "    : false",
          why: "task 以 - 开头不再被拒 ⇒ pi 把它当命令行选项（--help 会以 0 退出成假成功）",
          kills: "闸门·task 以 - 开头被拒",
        },
        {
          id: "gates.agent-unknown-passes",
          file: "packages/dispatch/src/gates.ts",
          from: "    input.agent === undefined || resolver(input.agent)",
          to: "    input.agent === undefined || true",
          why: "agent 解析不出来也放行 ⇒ 孩子起不来还占着槽",
          kills: "闸门·未知 agent 被拒",
        },
        {
          id: "gates.program-mutex-lost",
          file: "packages/dispatch/src/gates.ts",
          from: "  if (input.agent !== undefined || input.model !== undefined || input.thinkingLevel !== undefined) {",
          to: "  if (input.agent !== undefined && input.model !== undefined && input.thinkingLevel !== undefined) {",
          why: "program 互斥检查写成「三者同时给才拒」⇒ program 与 agent 并用被放行",
          kills: "闸门·program 与 agent/model/thinkingLevel 不并用被拒",
        },
      ],
    },
    {
      id: "argv",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "argv.flag-order",
          file: "packages/dispatch/src/child-process.ts",
          from: '  const argv = ["pi", "-p", "--no-session", "--mode", "json", "--append-system-prompt", block];',
          to: '  const argv = ["pi", "-p", "--mode", "json", "--no-session", "--append-system-prompt", block];',
          why: "旗标序被换（--no-session 与 --mode json 对调）⇒ 孩子的 argv 形状漂了",
          kills: "argv·旗标序",
        },
        {
          id: "argv.model-resolution-order",
          file: "packages/dispatch/src/child-process.ts",
          from: "  const model = input.model ?? input.agentModel ?? context.sessionModel;",
          to: "  const model = input.agentModel ?? input.model ?? context.sessionModel;",
          why: "模型继承序写反（agent 定义压过调用参数）⇒ 钉了模型的调用方被忽略",
          kills: "argv·模型继承序",
        },
        {
          id: "argv.strict-read-set",
          file: "packages/dispatch/src/child-process.ts",
          from: '    ...(input.searchEnabled ? ["web_ds_search"] : []),',
          to: "    ...(input.searchEnabled ? [] : []),",
          why: "strict 读集里的搜索工具被摘掉 ⇒ 搜索开着却被 strict 悄悄滤掉（ADR-0003 坑）",
          kills: "argv·strict 读集随能力开关派生",
        },
      ],
    },
    {
      id: "timeout",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "timeout.reason-text",
          file: "packages/dispatch/src/engine.ts",
          from:
            "          void this.stop(taskId, `timeout after ${timeoutMs}ms`);\n" +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          to:
            '          void this.stop(taskId, "timeout");\n' +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          why: "超时 stopReason 不写毫秒数 ⇒ 模型分不出「被掐掉」还是别的失败",
          kills: "timeout·pi 孩子：stopReason 写明超时毫秒数",
        },
        {
          id: "timeout.zero-treated-as-budget",
          file: "packages/dispatch/src/engine.ts",
          from:
            "    // stopReason 写明超时——模型据此知道这孩子是被掐掉的，不是自己跑完的\n" +
            "    const timeoutMs =\n" +
            '      typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : undefined;\n' +
            "    const timer = timeoutMs\n" +
            "      ? setTimeout(() => {\n" +
            "          void this.stop(taskId, `timeout after ${timeoutMs}ms`);\n" +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          to:
            "    // stopReason 写明超时——模型据此知道这孩子是被掐掉的，不是自己跑完的\n" +
            "    const timeoutMs =\n" +
            '      typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;\n' +
            "    const timer = timeoutMs !== undefined\n" +
            "      ? setTimeout(() => {\n" +
            "          void this.stop(taskId, `timeout after ${timeoutMs}ms`);\n" +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          why: "零值被当成预算 ⇒ timeoutMs=0 的任务一落地就被掐掉（零值必须是不限时）",
          kills: "timeout·timeoutMs=0 ⇒ 不计时",
        },
        {
          id: "timeout.bypasses-stop-path",
          file: "packages/dispatch/src/engine.ts",
          from:
            "    const timer = timeoutMs\n" +
            "      ? setTimeout(() => {\n" +
            "          void this.stop(taskId, `timeout after ${timeoutMs}ms`);\n" +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          to:
            "    const timer = timeoutMs\n" +
            "      ? setTimeout(() => {\n" +
            '          void this.#children.get(taskId)?.kill("SIGTERM");\n' +
            "        }, timeoutMs)\n" +
            "      : undefined;\n" +
            "    timer?.unref();\n" +
            "    // 停滞护栏",
          why: "超时直接杀孩子不走 stop 路径 ⇒ 记录不留 stopReason、终态从 canceled 变成 failed",
          kills: "timeout·pi 孩子：超时收尸，终态 canceled",
        },
      ],
    },
    {
      id: "stall",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "stall.threshold-boundary",
          file: "packages/dispatch/src/activity.ts",
          from: "    return now - this.#lastActivityAt >= thresholdMs;",
          to: "    return now - this.#lastActivityAt > thresholdMs;",
          why: "停滞阈值差一毫秒（到点不算停滞）⇒ 收尸永远晚一轮",
          kills: "stall·阈值：恰好到阈值即算停滞",
        },
        {
          id: "stall.inflight-tool-exempt",
          file: "packages/dispatch/src/activity.ts",
          from: "    if (this.#toolOpen > 0) return false;",
          to: "    if (this.#toolOpen < 0) return false;",
          why: "在飞工具不再豁免 ⇒ 工具循环里的孩子被误杀",
          kills: "stall·口径二：在飞的工具 ⇒ 不停滞",
        },
        {
          id: "stall.signal-ladder",
          file: "packages/dispatch/src/engine.ts",
          from:
            '    await this.#registry.submit({ kind: "stop", id: taskId, reason });\n' +
            "    const child = this.#children.get(taskId);\n" +
            "    if (!child) return;\n" +
            '    child.kill("SIGTERM");',
          to:
            '    await this.#registry.submit({ kind: "stop", id: taskId, reason });\n' +
            "    const child = this.#children.get(taskId);\n" +
            "    if (!child) return;\n" +
            '    child.kill("SIGKILL");',
          why: "收尸阶梯的头一档换成 SIGKILL ⇒ 孩子没机会自己收尾",
          kills: "stall·信号阶梯",
        },
      ],
    },
    {
      id: "report",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "report.prompt-channel-mislabelled",
          file: "packages/dispatch/src/report.ts",
          from: '      return { report: normalizeReport(parsed), channel: "prompt-json" };',
          to: '      return { report: normalizeReport(parsed), channel: "none" };',
          why: "prompt 通道的报告被标成 none ⇒ 父看到「没有报告」而报告其实在",
          kills: "report·prompt 通道",
        },
      ],
    },
    {
      id: "usage",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "usage.self-report-wins",
          file: "packages/dispatch/src/engine.ts",
          from:
            "    if (report && selfUsageEmpty && parsed.observedUsage)\n" +
            "      report = { ...report, usage: parsed.observedUsage };",
          to:
            "    if (report && selfUsageEmpty && parsed.observedUsage)\n" +
            "      report = { ...report, usage: selfUsage };",
          why: "自报的全 0 不再让位给宿主观测值 ⇒ 父在任务面看到的用量恒为 0",
          kills: "usage·孩子自报全 0 ⇒ 让位给宿主观测值",
        },
      ],
    },
    {
      id: "registry-persist",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "registry.owner-alive-evicted",
          file: "packages/dispatch/src/engine.ts",
          from: "      if (record.ownerPid !== undefined && isPidAlive(record.ownerPid)) continue;",
          to: "      if (record.ownerPid !== undefined && !isPidAlive(record.ownerPid)) continue;",
          why: "会话血缘判定写反 ⇒ 别的会话还在飞的任务被当成本会话的孤儿标 lost",
          kills: "registry·会话血缘过滤",
        },
      ],
    },
    {
      id: "archive",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "archive.ttl-window",
          file: "packages/dispatch/src/engine.ts",
          from: "        if (now - statSync(join(archiveDir, file)).mtimeMs > ttlMs) {",
          to: "        if (now - statSync(join(archiveDir, file)).mtimeMs > ttlMs * 365) {",
          why: "归档 TTL 从 30 天被拉成一年 ⇒ 过期归档永远留在盘上",
          kills: "archive·TTL",
        },
      ],
    },
    {
      id: "delivery",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "delivery.suffix-match-lost",
          file: "packages/routes/src/registry.ts",
          from: "  return paths.some((p) => p === norm || p.endsWith(`/${norm}`));",
          to: "  return paths.some((p) => p === norm);",
          why: "声称文件改回精确匹配 ⇒ 相对路径 vs 绝对路径必误报零命中（bench 实测误伤 67%）",
          kills: "delivery·后缀匹配",
        },
      ],
    },
    {
      id: "notifications",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "notifications.awaited-key-mismatch",
          file: "packages/dispatch/src/notifications.ts",
          from: "      if (this.#awaited.has(next.id)) {",
          to: '      if (this.#awaited.has(next.label ?? "")) {',
          why: "awaited 集合按 label 查 ⇒ 前台等待的任务照样收到通知（ADR-0007 语义丢）",
          kills: "notifications·槽位语义",
        },
      ],
    },
    {
      id: "program-carrier",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "program.cli-path-extra-dist",
          file: "packages/entry/src/index.ts",
          from: '  const candidate = join(dir, "ptc", "cli.js");',
          to: '  const candidate = join(dir, "dist", "ptc", "cli.js");',
          why: "载体路径多拼一节 dist（381a70d 的老坑）⇒ 真实产物找不到，program 派发全被闸前拒",
          kills: "program·载体路径解析",
        },
        {
          id: "program.carrier-missing-gate-lost",
          file: "packages/dispatch/src/engine.ts",
          from: "    if (rawInput.program !== undefined && !this.#programCliPath) {",
          to: "    if (rawInput.program !== undefined && this.#programCliPath) {",
          why: "载体可用性闸的条件写反 ⇒ 载体缺失时不拒，铸了 id 才失败",
          kills: "program·载体缺失 ⇒ 闸前拒",
        },
        {
          id: "program.envelope-canceled-lost",
          file: "packages/dispatch/src/program-carrier.ts",
          from: '    (env.status !== "fulfilled" && env.status !== "rejected" && env.status !== "canceled") ||',
          to: '    (env.status !== "fulfilled" && env.status !== "rejected") ||',
          why: "信封三态少认 canceled ⇒ 被取消的程序孩子被当成「不是 ptc CLI 的输出」",
          kills: "program·信封三态",
        },
      ],
    },
    {
      id: "agent-discovery",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "agent.scope-order",
          file: "packages/dispatch/src/agent-discovery.ts",
          from: "  return [dirs.projectDir, dirs.userDir];",
          to: "  return [dirs.userDir, dirs.projectDir];",
          why: "层级覆盖顺序写反 ⇒ user 定义压过 project 定义（层级覆盖语义丢）",
          kills: "agent·scope 查找",
        },
      ],
    },
    {
      id: "slots",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "slots.capacity-off-by-one",
          file: "packages/dispatch/src/slots.ts",
          from: "    if (this.#holders.size < this.#capacity) {",
          to: "    if (this.#holders.size <= this.#capacity) {",
          why: "槽位容量差一格 ⇒ 并发上限被突破一格",
          kills: "slots·容量上限",
        },
      ],
    },
    {
      id: "task-record",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "task.id-shape",
          file: "packages/dispatch/src/task-id.ts",
          from: "  return randomUUID();",
          to: "  return randomUUID().slice(0, 8);",
          why: "task id 不是 uuid 形状 ⇒ 记录键与外部引用对不上",
          kills: "task·id 生成",
        },
      ],
    },
    {
      id: "child-runtime",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "child.env-depth-off-by-one",
          file: "packages/dispatch/src/engine.ts",
          from:
            "    // R1 血缘：孩子知道自己 depth 与父任务 id（子代理进程内扩展行为的开关）\n" +
            "    const env = {\n" +
            "      ...process.env,\n" +
            "      PI_PTC_DEPTH: String(this.#context.depth + 1),",
          to:
            "    // R1 血缘：孩子知道自己 depth 与父任务 id（子代理进程内扩展行为的开关）\n" +
            "    const env = {\n" +
            "      ...process.env,\n" +
            "      PI_PTC_DEPTH: String(this.#context.depth),",
          why: "孩子的 depth 不递增 ⇒ 子代理按 depth=0 做完整装配（子代理面工具全开）",
          kills: "child-runtime·真子进程：env 透传",
        },
        {
          id: "child.exit-code",
          file: "packages/dispatch/src/child-process.ts",
          from: '  child.on("close", (code) => settle(code ?? -1));',
          to: '  child.on("close", () => settle(-1));',
          why: "退出码恒为 -1 ⇒ 孩子的真实退出状态（成功/失败/信号）全丢",
          kills: "child-runtime·真子进程：退出码与报告管道",
        },
        {
          id: "child.stdio-pipe",
          file: "packages/dispatch/src/child-process.ts",
          from: '  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });',
          to: '  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "inherit", "pipe"] });',
          why: "stdout 不再是管道 ⇒ 引擎抓不到孩子的输出（报告/usage 全丢）",
          kills: "child-runtime·真子进程：stdout 是管道",
        },
      ],
    },
    {
      id: "context-shrink",
      face: "pi",
      probe: "tests/pi/dispatch.test.ts",
      mutants: [
        {
          id: "context.project-context-flip",
          file: "packages/dispatch/src/child-process.ts",
          from: '  if (input.projectContext === "none") argv.push("--no-context-files");',
          to: '  if (input.projectContext !== "none") argv.push("--no-context-files");',
          why: "项目上下文开关写反 ⇒ 默认（auto）的孩子反而丢了 AGENTS.md 口径",
          kills: "context·projectContext=none",
        },
      ],
    },
  ],
};
