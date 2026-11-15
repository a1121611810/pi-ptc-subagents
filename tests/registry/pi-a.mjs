// pi 面能力分片（产品/entry 一组）：产物形态 · 产物 import 门禁 · 工具名对齐 · 入口装配
//                          · 开关与闸 · 升级提示 · floor 回退 · OCR 核 · 册子门禁（output 面）。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
// kills 必须是探针里唯一一条用例标题的子串——红了的是别的用例 = 假杀死。
export default {
  capabilities: [
    {
      id: "artifact.imports",
      face: "pi",
      probe: "tests/pi/artifact.test.ts",
      mutants: [
        {
          id: "artifact.imports.semicolon-boundary-lost",
          file: "scripts/check-artifact-imports.mjs",
          from: `/(?:^|[;}\\n])[ \\t]*(?:import|export)\\b[^;]*?\\bfrom\\s*["']([^"']+)["']/g,`,
          to: `/(?:^|[}\\n])[ \\t]*(?:import|export)\\b[^;]*?\\bfrom\\s*["']([^"']+)["']/g,`,
          why: "语句边界少了分号 ⇒ 压缩产物（整个文件一行）里第二个 import 被漏掉（真坏过：只认行首会漏）",
          kills: "压缩产物（整个文件一行）里第二个 import 也算数",
        },
        {
          id: "artifact.imports.asi-brace-boundary-lost",
          file: "scripts/check-artifact-imports.mjs",
          from:
            `/(?:^|[;}\\n])[ \\t]*(?:import|export)\\b[^;]*?\\bfrom\\s*["']([^"']+)["']/g, ` +
            `// import/export ... from "x"`,
          to:
            `/(?:^|[;\\n])[ \\t]*(?:import|export)\\b[^;]*?\\bfrom\\s*["']([^"']+)["']/g, ` +
            `// import/export ... from "x"`,
          why: "语句边界少了右花括号 ⇒ ASI 形状 `}export{...}from` 的未声明 import 漏检（真坏过：压缩器在 } 后省掉分号）",
          kills: "压缩产物里 `}export{...}from` 的形状也算数",
        },
        {
          id: "artifact.imports.devdeps-count-as-declared",
          file: "scripts/check-artifact-imports.mjs",
          from:
            "    ...Object.keys(manifest.peerDependencies ?? {}),\n" +
            "    ...Object.keys(manifest.optionalDependencies ?? {}),",
          to:
            "    ...Object.keys(manifest.peerDependencies ?? {}),\n" +
            "    ...Object.keys(manifest.optionalDependencies ?? {}),\n" +
            "    ...Object.keys(manifest.devDependencies ?? {}),",
          why: "devDependencies 也算数 ⇒ 只在 devDeps 里声明的包被当成已声明（devDeps 不随包安装）",
          kills: "devDependencies 不算声明",
        },
      ],
    },
    {
      id: "artifact.shape",
      face: "pi",
      probe: "tests/pi/artifact.test.ts",
      mutants: [
        {
          id: "artifact.shape.chunk-into-subdir",
          file: "packages/entry/rolldown.config.mjs",
          from: '    chunkFileNames: "[name].js",',
          to: '    chunkFileNames: "chunks/[name].js",',
          why: "共享块挪进 chunks/ 子目录 ⇒ worker 按同目录找 worker.js 找不到（共享块必须留在输出根）",
          kills: "共享块留在输出根",
        },
        {
          id: "artifact.shape.cli-in-shared-chunk",
          file: "packages/entry/rolldown.config.mjs",
          from: "          test: /packages\\/ptc\\/src\\/(dispatcher|pool|limits|sub-calls|fs-bindings|worker-source)\\.ts$/,",
          to: "          test: /packages\\/ptc\\/src\\/(dispatcher|pool|limits|sub-calls|fs-bindings|worker-source|cli)\\.ts$/,",
          why: "分组规则把 cli.ts 摇进共享块 ⇒ 只要 import entry 就执行 CLI（2026-11-02 实测踩到）",
          kills: "import entry 不执行 ptc CLI",
        },
        {
          id: "artifact.shape.ptc-cli-entry-missing",
          file: "packages/entry/rolldown.config.mjs",
          from: '    "ptc/cli": "../ptc/src/cli.ts",',
          to: "",
          why: "少一个入口 ⇒ 发布物缺 ptc/cli.js（一次构建四入口是发布形态的硬约定）",
          kills: "四个入口都在",
        },
      ],
    },
    {
      id: "tool-name-registry",
      face: "pi",
      probe: "tests/pi/artifact.test.ts",
      mutants: [
        {
          id: "tool-name-registry.registry-name-drift-stop",
          file: "packages/routes/src/registry.ts",
          from: '    name: "ptc_task_stop",',
          to: '    name: "ptc_task_stop_v2",',
          why: "册子声明的工具名漂了 ⇒ 注册名与册子对不上（工具名不许漂）",
          kills: "entry 注册的 name == 册子声明的 name",
        },
        {
          id: "tool-name-registry.registry-name-drift-progress",
          file: "packages/routes/src/registry.ts",
          from: '    name: "ptc_progress_update",',
          to: '    name: "ptc_progress_update_v2",',
          why: "册子声明的工具名漂了（进展更新那张卡）",
          kills: "entry 注册的 name == 册子声明的 name",
        },
        {
          id: "tool-name-registry.entry-name-drift-task-output",
          file: "packages/entry/src/index.ts",
          from: '    name: "ptc_task_output",',
          to: '    name: "ptc_task_output_v2",',
          why: "entry 注册的工具名漂了 ⇒ 模型照册子叫的名字调不到这个工具",
          kills: "entry 注册的 name == 册子声明的 name",
        },
      ],
    },
    {
      id: "entry-gates",
      face: "pi",
      probe: "tests/pi/entry.test.ts",
      mutants: [
        {
          id: "entry-gates.ocr-switch-fail-open",
          file: "packages/entry/src/index.ts",
          from: "      ocrEnabled: parsed.webDsOcr === true,",
          to: "      ocrEnabled: parsed.webDsOcr !== false,",
          why: "开关 fail-open ⇒ 配置没写也开（ADR-0002：DeepSeek 工具默认关，缺凭据时也不注册）",
          kills: "开关默认关（fail-closed）",
        },
        {
          id: "entry-gates.strict-read-set-hardcoded",
          file: "packages/dispatch/src/child-process.ts",
          from: '    ...(input.ocrEnabled ? ["doc_ds_ocr"] : []),',
          to: '    ...(input.searchEnabled ? ["doc_ds_ocr"] : []),',
          why: "strict 读集不再随开关派生（ADR-0003 实测坑：能力被 strict 悄悄滤掉）",
          kills: "strict 读集随开关派生",
        },
        {
          id: "entry-gates.engine-drops-ocr-switch",
          file: "packages/dispatch/src/engine.ts",
          from: "        ocrEnabled: this.#ocrEnabled,",
          to: "        ocrEnabled: false,",
          why: "引擎把 ocrEnabled 丢掉 ⇒ 开关在中间层失效（注册了但孩子调不到）",
          kills: "引擎把 ocrEnabled 传给 argv 构建器",
        },
      ],
    },
    {
      id: "session-assembly",
      face: "pi",
      probe: "tests/pi/entry.test.ts",
      mutants: [
        {
          id: "session-assembly.surface-detection-broken",
          file: "packages/entry/src/index.ts",
          from: '      ? "codemode_ptc"\n      : FALLBACK_SURFACE_MODE;',
          to: '      ? "full_ptc"\n      : FALLBACK_SURFACE_MODE;',
          why: "surface 检测失效 ⇒ codemode 面也注册 PTC 对（决策 28：一个面一个编排器）",
          kills: "surface 检测：活跃表含 codemode",
        },
      ],
    },
    {
      id: "upgrade-notice",
      face: "pi",
      probe: "tests/pi/upgrade.test.ts",
      mutants: [
        {
          id: "upgrade-notice.same-version-not-silent",
          file: "packages/entry/src/upgrade-notice.ts",
          from: "  if (previousNumber === current) return;",
          to: "  if (previousNumber === current + 1) return;",
          why: "同版不再静默 ⇒ 每次启动都重复播报同一条（状态哨兵的意义没了）",
          kills: "同版本不重复显示",
        },
        {
          id: "upgrade-notice.tui-notify-instead-of-widget",
          file: "packages/entry/src/upgrade-notice.ts",
          from: '  if (ctx.mode === "tui" && typeof ui?.setWidget === "function") {',
          to: "  if (false) {",
          why: "TUI 里退回 notify ⇒ 文案进全局共享状态槽，别的扩展一调就被顶掉（2026-11-02 真机复现）",
          kills: "TUI 模式：升级提示走 widget 区",
        },
        {
          id: "upgrade-notice.verification-section-included",
          file: "packages/entry/src/upgrade-notice.ts",
          from: 'const CHANGE_SECTIONS = ["Added", "Changed", "Fixed"];',
          to: 'const CHANGE_SECTIONS = ["Added", "Changed", "Fixed", "Verification"];',
          why: "Verification 段（测试结论）混进「变了什么」⇒ 提示里出现不相干的条目",
          kills: "CHANGELOG 解析",
        },
      ],
    },
    {
      id: "floor-fallback",
      face: "pi",
      probe: "tests/pi/entry.test.ts",
      mutants: [
        {
          id: "floor-fallback.version-gate-loosened",
          file: "packages/entry/src/index.ts",
          from: "  return M > 0 || (M === 0 && m >= 99);",
          to: "  return M > 0 || (M === 0 && m >= 9);",
          why: "版本门把 0.99 写成 0.9 ⇒ floor（0.86/0.87）被当成有通道 ⇒ 文件回退路径整个失效",
          kills: "floor（无 executeTool 通道）",
        },
      ],
    },
    {
      id: "ocr-core",
      face: "pi",
      probe: "tests/pi/ocr.test.ts",
      mutants: [
        {
          id: "ocr-core.jail-symlink-escape-allowed",
          file: "packages/search/src/ocr.ts",
          from: "  if (real !== rootReal && !real.startsWith(rootReal + sep)) {",
          to: "  if (false) {",
          why: "软链越界不再拒 ⇒ 工作区里的软链能把文件指向外面送出去（jail 少了一半）",
          kills: "jail：工作区外的路径被拒",
        },
        {
          id: "ocr-core.coordinate-markup-kept",
          file: "packages/search/src/ocr.ts",
          from: "const OCR_MARKUP = /<[|｜]ref[|｜]>|<[|｜]box[|｜]>\\s*\\[\\[[\\s\\S]*?\\]\\]\\s*<[|｜]box[|｜]>/g;",
          to: "const OCR_MARKUP = /<[|｜]ref[|｜]>/g;",
          why: "坐标标记不剥 ⇒ 版面坐标混进正文（剥标记不剥字）",
          kills: "官方坐标标记要剥掉",
        },
        {
          id: "ocr-core.budget-does-not-drop-pages",
          file: "packages/search/src/ocr.ts",
          from: "    if (kept.length > 0 && used + block.length > budgetChars) {",
          to: "    if (false) {",
          why: "超预算不丢整页 ⇒ 12k 预算被顶穿（模型上下文白烧）",
          kills: "归约：预算外整页丢弃",
        },
        {
          id: "ocr-core.empty-result-cached",
          file: "packages/search/src/ocr.ts",
          from: "  if (recognized) context.memory.storeText(real, rendered);",
          to: "  context.memory.storeText(real, rendered);",
          why: "空结果入记忆 ⇒ 一次识别失败被固化成「这份文件就是空的」，同一文件永远不再请求官方",
          kills: "空结果不进记忆",
        },
        {
          id: "ocr-core.empty-text-cached",
          file: "packages/search/src/ocr.ts",
          from: "  if (recognized) context.memory.storeText(real, rendered);",
          to: "  if (outcome.value.pages.length > 0) context.memory.storeText(real, rendered);",
          why: "记忆守卫退回旧口径（只看有没有页）⇒ 「页在但正文空」的识别失败被固化成永久结论",
          kills: "没识别出正文不入记忆",
        },
        {
          id: "ocr-core.recognized-always-true",
          file: "packages/search/src/ocr.ts",
          from: "    recognized,",
          to: "    recognized: true,",
          why: "机器通道恒说「识别出正文」⇒ 官方没识别出来时，宿主/程序读结构化通道会被误导",
          kills: "机器通道要说清有没有识别出正文",
        },
        {
          id: "ocr-core.no-text-notice-dropped",
          file: "packages/search/src/ocr.ts",
          from: "  if (!hasRecognizedText(result.pages)) {",
          to: "  if (false) {",
          why: "告知语被吞 ⇒ 模型分不清「官方没识别出来」与「这份文档本来就是空白页」",
          kills: "官方没识别出正文时必须明说",
        },
      ],
    },
    {
      id: "ocr-tool-shape",
      face: "pi",
      probe: "tests/pi/entry.test.ts",
      mutants: [
        {
          id: "ocr-tool-shape.output-schema-dropped",
          file: "packages/entry/src/doc-ds-ocr-tool.ts",
          from: "    outputSchema: DOC_DS_OCR_OUTPUT,",
          to: "",
          why: "工具不声明 outputSchema ⇒ 模型侧拿不到结构化字段的契约（声明即契约）",
          kills: "文档识别工具声明了 outputSchema",
        },
        {
          id: "ocr-tool-shape.structured-content-missing",
          file: "packages/entry/src/doc-ds-ocr-tool.ts",
          from: "        structuredContent: structured,",
          to: "",
          why: "声明了 outputSchema 却不兑现 structuredContent ⇒ 契约不成立（pi 的机器可读结果通道空着）",
          kills: "文档识别工具的成功结果兑现 structuredContent",
        },
      ],
    },
    {
      id: "registry.mechanical",
      face: "output",
      probe: "tests/output/registry-gates.test.ts",
      mutants: [
        {
          id: "registry.mechanical.token-ceiling-widened",
          file: "packages/routes/src/registry.ts",
          from: "export const ROUTE_INDEX_TOKEN_CEILING = 560;",
          to: "export const ROUTE_INDEX_TOKEN_CEILING = 600;",
          why: "索引 token 上限被放宽 ⇒ 超预算不再被门禁抓住（每个 turn 都吃一行 > WARNING）",
          kills: "机械点 4 索引 token 预算",
        },
        {
          id: "registry.mechanical.progress-switch-ignored",
          file: "packages/routes/src/registry.ts",
          from: "route.id === PHASED_PROGRESS_ROUTE_ID && !progressEnabled",
          to: "route.id === PHASED_PROGRESS_ROUTE_ID && !nudge",
          why: "进展更新开关被读成别的旗标 ⇒ 工具没注册时索引仍在教模型调它（地图说假话）",
          kills: "开关一致性：进展更新 off 时索引不提未注册的工具",
        },
        {
          id: "registry.mechanical.detail-pointer-dangling",
          file: "packages/routes/src/registry.ts",
          from: '    detail: "docs/routes/manage-a-task.md",',
          to: '    detail: "docs/routes/manage-a-task-v2.md",',
          why: "detail 指针悬空 ⇒ 模型按索引去 read 读不到",
          kills: "机械点 7 索引每路一行 + detail 指针",
        },
      ],
    },
  ],
};
