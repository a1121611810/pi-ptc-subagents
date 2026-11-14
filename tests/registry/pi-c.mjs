// pi 面能力分片（Slice 4 + Slice 5）：任务面（列表/产出/停/痕迹容量）+ 显示层（pi 画面）。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
export default {
  capabilities: [
    {
      id: "task-list",
      face: "pi",
      probe: "tests/pi/task.test.ts",
      mutants: [
        {
          id: "task-list.limit-clamp-dropped",
          file: "packages/task/src/lifecycle.ts",
          from: "  const limit = Math.min(Math.max(query.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);",
          to: "  const limit = Math.max(query.limit ?? LIST_DEFAULT_LIMIT, 1);",
          why: "limit 上限夹取被丢掉 ⇒ 模型给的 limit=9999 就能要多少条（列表封顶失守）",
          kills: "limit 夹取",
        },
      ],
    },
    {
      id: "task-output",
      face: "pi",
      probe: "tests/pi/task.test.ts",
      mutants: [
        {
          id: "task-output.truncation-contract-dropped",
          file: "packages/task/src/output.ts",
          from:
            "    // 正文进上下文；超 50KB 时截断尾注自带全文路径（pi 的截断契约）\n" +
            "    return { text: applyAdr0015Truncation(answer).text };",
          to:
            "    // 正文进上下文；超 50KB 时截断尾注自带全文路径（pi 的截断契约）\n" +
            "    return { text: answer };",
          why: "正文不再走截断契约 ⇒ 超长答案整段进上下文，尾注与全文路径都没了",
          kills: "截断契约：答案超长被尾部切半时读全文再解析一次",
        },
      ],
    },
    {
      id: "task-stop",
      face: "pi",
      probe: "tests/pi/task.test.ts",
      mutants: [
        {
          id: "task-stop.text-not-a-string",
          file: "packages/entry/src/index.ts",
          from: '  content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) ?? "null" }],',
          to: '  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],',
          why: "text 兜底被摘掉 ⇒ JSON.stringify(undefined) 得 undefined ⇒ pi 下一轮读 .length 直接崩（真坏过）",
          kills: "形状不变量：textResult 的 text 永远是字符串",
        },
      ],
    },
    {
      id: "trace-capacity",
      face: "pi",
      probe: "tests/pi/task.test.ts",
      mutants: [
        {
          id: "trace-capacity.keep-off-by-one",
          file: "packages/dispatch/src/engine.ts",
          from: "const DEFAULT_TERMINAL_RECORD_KEEP = 500;",
          to: "const DEFAULT_TERMINAL_RECORD_KEEP = 501;",
          why: "终态痕迹上限被挪 ⇒ 决策 29 的「留最近 500 条」失守",
          kills: "600 任务（真实 storageDir）",
        },
      ],
    },
    {
      id: "pi-render",
      face: "pi",
      probe: "tests/pi/render.test.ts",
      mutants: [
        {
          id: "pi-render.rejected-color-wrong",
          file: "packages/tui/src/pi/render.ts",
          from: '  rejected: "error",',
          to: '  rejected: "warning",',
          why: "失败态的颜色 token 写错 ⇒ 折叠行里 rejected 与 canceled 长得一样",
          kills: "三个终态各走自己的颜色 token",
        },
      ],
    },
    {
      id: "task-panel",
      face: "pi",
      probe: "tests/pi/render.test.ts",
      mutants: [
        {
          id: "task-panel.session-filter-dropped",
          file: "packages/tui/src/pi/task-panel.ts",
          from: "  const mine = sessionId ? records.filter((record) => record.sessionId === sessionId) : records;",
          to: "  const mine = records;",
          why: "会话过滤被丢掉 ⇒ 历史会话的恢复记录被算进本会话计数（真坏过：标题写「succeeded 180」）",
          kills: "只算本会话的记录",
        },
        {
          id: "task-panel.count-wrong-status",
          file: "packages/tui/src/pi/task-panel.ts",
          from: 'count("succeeded")',
          to: 'count("canceled")',
          why: "标题的成功计数取错状态 ⇒ 计数与真实记录不符",
          kills: "标题给出 running/succeeded/failed 三个计数",
        },
        {
          id: "task-panel.body-not-sanitized",
          file: "packages/tui/src/pi/task-panel.ts",
          from: "    const text = sanitizeText(record.label || record.task)",
          to: "    const text = record.label || record.task",
          why: "正文不再清洗 ⇒ 模型写的 ANSI 进终端（会被执行）、转义序列被截成半截",
          kills: "任务正文里的 ANSI 与换行不进终端",
        },
      ],
    },
    {
      id: "task-face",
      face: "pi",
      probe: "tests/pi/render.test.ts",
      mutants: [
        {
          id: "task-face.inflight-count-wrong-source",
          file: "packages/tui/src/pi/task-face.ts",
          from: 'const head = `任务列表${scope === "all" ? "（含归档）" : ""} · ${listed} 条 · ${inFlight} 在飞`;',
          to: 'const head = `任务列表${scope === "all" ? "（含归档）" : ""} · ${listed} 条 · ${listed} 在飞`;',
          why: "折叠头的「在飞」数取错来源（写成列出数）⇒ 标题报的数与真实在飞不符",
          kills: "列表折叠：给计数，不给行",
        },
      ],
    },
    {
      id: "progress-face",
      face: "pi",
      probe: "tests/pi/render.test.ts",
      mutants: [
        {
          id: "progress-face.switch-always-on",
          file: "packages/entry/src/index.ts",
          from: '  return v !== "off" && v !== "0" && v !== "false";',
          to: "  return true;",
          why: "进展更新开关恒开 ⇒ PI_PTC_PROGRESS=off 关不掉（剥夺类开关失守）",
          kills: "开关 PI_PTC_PROGRESS",
        },
      ],
    },
    {
      id: "no-skimp-banner",
      face: "pi",
      probe: "tests/pi/render.test.ts",
      mutants: [
        {
          id: "no-skimp-banner.off-not-unmounted",
          file: "packages/tui/src/pi/no-skimp-banner.ts",
          from: "    ui.setWidget(NO_SKIMP_BANNER_KEY, lines.length > 0 ? lines : undefined);",
          to: "    ui.setWidget(NO_SKIMP_BANNER_KEY, lines.length >= 0 ? lines : undefined);",
          why: "关掉时传空数组而不是 undefined ⇒ 宿主不卸载横幅，开关失守",
          kills: "TUI 横幅：开着常驻显示，关掉即卸载",
        },
      ],
    },
  ],
};
