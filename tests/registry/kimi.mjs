// kimi 面能力分片：搜索核（provider/记忆/配额/三动作）· MCP 协议面 · 册子散文 · 运行时三件事（闸门/版本探测/正确性矩阵）。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
// kills 必须是该探针里唯一一条用例标题的子串——红了别的用例不算杀死（scripts/mutate.mjs 归属核对）。
export default {
  capabilities: [
    {
      id: "route.prose-single-source",
      face: "kimi",
      probe: "tests/kimi/prose.test.ts",
      mutants: [
        {
          id: "route.prose-single-source.server-description-hardcoded",
          file: "packages/kimi-mcp/src/server.ts",
          from: "        description: KIMI_MCP_TOOLS.web_ds_search.description(),",
          to: '        description: "Search the web with three actions.",',
          why: "server 描述改写字面量——不再走册子渲染（模型可见散文漂了）",
          kills: "server 工具描述逐字等于册子渲染",
        },
        {
          id: "route.prose-single-source.schema-description-hardcoded",
          file: "packages/kimi-mcp/src/server.ts",
          from: "      description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.action,",
          to: '      description: "action",',
          why: "schema 字段描述改写字面量——参数说明不再来自册子",
          kills: "schema 字段描述逐字等于册子",
        },
        {
          id: "route.prose-single-source.registry-field-description-empty",
          file: "packages/routes/src/registry.ts",
          from: "  web_ds_search: KIMI_MCP_WEB_DS_SEARCH,",
          to: '  web_ds_search: { ...KIMI_MCP_WEB_DS_SEARCH, inputSchemaDescriptions: { ...KIMI_MCP_WEB_DS_SEARCH.inputSchemaDescriptions, query: "" } },',
          why: "册子里的字段描述被清空——散文缺口（真坏过：册子块不完整）",
          kills: "册子自检：每条 Kimi 工具描述非空且在 token 预算内",
        },
      ],
    },
    {
      id: "kimi-prose",
      face: "kimi",
      probe: "tests/kimi/prose.test.ts",
      mutants: [
        {
          id: "kimi-prose.repeat-billing-note-dropped",
          file: "packages/routes/src/registry.ts",
          from:
            '      "配额按 MCP server 进程计（默认 30 次/进程，0 = 不限）——不是跨会话的全局限额；open/find 命中本会话记忆不重复消耗。",\n' +
            '      "模型自带联网搜索（DeepSeek 服务端工具）时别用它——会重复检索并重复计费。",',
          to:
            '      "配额按 MCP server 进程计（默认 30 次/进程，0 = 不限）——不是跨会话的全局限额；open/find 命中本会话记忆不重复消耗。",\n' +
            '      "模型自带联网搜索时别用它。",',
          why: "二选一提示消失——模型会与宿主自带搜索重复检索并重复计费",
          kills: "二选一提示：web_ds_search 与 doc_ds_ocr 都写明重复计费",
        },
        {
          id: "kimi-prose.upload-fact-dropped",
          file: "packages/routes/src/registry.ts",
          from: '      "把本地 PDF / Word / PPT / 图片转成文字（DeepSeek OCR，逐页返回；文件会上传到 DeepSeek 侧处理，本机不留副本）。只允许 workdir 内的文件。",',
          to: '      "把本地 PDF / Word / PPT / 图片转成文字（DeepSeek OCR，逐页返回）。只允许 workdir 内的文件。",',
          why: "上传事实从描述里消失——文件会离开本机却没说",
          kills: "上传事实：doc_ds_ocr 描述写明文件会上传到 DeepSeek 侧",
        },
        {
          id: "kimi-prose.tool-name-drift",
          file: "packages/routes/src/registry.ts",
          from: '  name: "doc_ds_ocr",',
          to: '  name: "doc_ds_ocr_v2",',
          why: "工具名漂移——册子↔server 双向一致照样绿，SKILL.md 按名字引用就对不上",
          kills: "工具名显式列举：三个 Kimi 工具名钉死",
        },
      ],
    },
    {
      id: "kimi-protocol",
      face: "kimi",
      probe: "tests/kimi/protocol.test.ts",
      mutants: [
        {
          id: "kimi-protocol.error-shape-dropped",
          file: "packages/kimi-mcp/src/server.ts",
          from: '    isError: outcome.status !== "fulfilled",',
          to: "    isError: false,",
          why: "程序失败不落 isError——模型分不出失败态（workdir 越界那条也糊过去）",
          kills: "workdir 越界：程序失败走 isError 形状",
        },
      ],
    },
    {
      id: "search-provider",
      face: "kimi",
      probe: "tests/kimi/search.test.ts",
      mutants: [
        {
          id: "search-provider.error-status-ignored",
          file: "packages/search/src/deepseek.ts",
          from: "  if (!response.ok) {",
          to: "  if (response.status === 404) {",
          why: "非 2xx 不再落失败形状——5xx 的错误体被当成成功响应解析",
          kills: "HTTP 非 2xx 落失败形状（status + 重试指引）",
        },
      ],
    },
    {
      id: "search-memory",
      face: "kimi",
      probe: "tests/kimi/search.test.ts",
      mutants: [
        {
          id: "search-memory.char-budget-loosened",
          file: "packages/search/src/memory.ts",
          from: "    while (totalChars > SEARCH_MEMORY_MAX_CHARS) {",
          to: "    while (totalChars > SEARCH_MEMORY_MAX_CHARS * 2) {",
          why: "记忆桶字符预算放宽——超大正文留在桶里挤爆上下文",
          kills: "字符预算超限的正文不入桶",
        },
      ],
    },
    {
      id: "search-quota",
      face: "kimi",
      probe: "tests/kimi/search.test.ts",
      mutants: [
        {
          id: "search-quota.failure-consumes-quota",
          file: "packages/search/src/quota.ts",
          from: "      if (success) used++;",
          to: "      used++;",
          why: "失败也占额——官方口径是只计成功调用，失败不耗配额",
          kills: "失败不耗配额",
        },
      ],
    },
    {
      id: "search-run",
      face: "kimi",
      probe: "tests/kimi/search.test.ts",
      mutants: [
        {
          id: "search-run.find-case-sensitive",
          file: "packages/search/src/run.ts",
          from: '    regex = new RegExp(action.pattern, "i");',
          to: "    regex = new RegExp(action.pattern);",
          why: "find 的行匹配变成大小写敏感——页内匹配漏命中",
          kills: "find 动作页内行匹配（大小写不敏感）",
        },
      ],
    },
    {
      id: "kimi-nudge-gate",
      face: "kimi",
      probe: "tests/kimi/runtime.test.ts",
      mutants: [
        {
          id: "kimi-nudge-gate.threshold-off-by-one",
          file: "scripts/lib/tool-shape.mjs",
          from: "    if (s.runLen === RUN_THRESHOLD && s.fired < NUDGE_BUDGET) {",
          to: "    if (s.runLen === RUN_THRESHOLD + 1 && s.fired < NUDGE_BUDGET) {",
          why: "闸门晚一轮才拦——连打 5 次不再被拦（真坏过：阻断第 5 次的契约）",
          kills: "同形态连打第 5 次被阻断",
        },
      ],
    },
    {
      id: "kimi-version-probe",
      face: "kimi",
      probe: "tests/kimi/runtime.test.ts",
      mutants: [
        {
          id: "kimi-version-probe.same-version-notified",
          file: "scripts/kimi-version-check.mjs",
          from: "  if (latest === undefined || !isNewer(latest, installed)) return;",
          to: "  if (latest === undefined) return;",
          why: "同版本也出声——每轮唠叨「有新版本」，把提示的可信度磨光",
          kills: "同版本：不出声",
        },
      ],
    },
    {
      id: "kimi-server-correctness",
      face: "kimi",
      probe: "tests/kimi/server-correctness.test.ts",
      mutants: [
        {
          id: "kimi-server-correctness.jail-disabled",
          file: "packages/ptc/src/fs-bindings.ts",
          from: "  if (real !== workdirReal && !real.startsWith(workdirReal + sep)) {",
          to: "  if (real !== workdirReal && false) {",
          why: "workdir 锁失效——程序能读工作区外的文件（信任边界破）",
          kills: "判据脚本：kimi-bench 正确性矩阵全过",
        },
        {
          id: "kimi-server-correctness.timeout-message-loses-name",
          file: "packages/kimi-mcp/src/server.ts",
          from: '    return { isError: true, content: [{ type: "text", text: "timeoutMs 必须是数字" }] };',
          to: '    return { isError: true, content: [{ type: "text", text: "参数必须是数字" }] };',
          why: "参数校验的报错不点名参数——模型不知道该改哪个字段",
          kills: "判据脚本：kimi-bench 正确性矩阵全过",
        },
        {
          id: "kimi-server-correctness.edit-unique-check-loosened",
          file: "packages/ptc/src/fs-bindings.ts",
          from: "      if (count > 1) throw new Error(`old_string matches ${count} places — must be unique`);",
          to: "      if (count > 99) throw new Error(`old_string matches ${count} places — must be unique`);",
          why: "edit 的唯一性检查放宽——多处匹配时只改第一处（猜着改）",
          kills: "判据脚本：kimi-bench 正确性矩阵全过",
        },
      ],
    },
  ],
};
