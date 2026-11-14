// standalone 面能力分片：引擎零依赖 / 运行格 / 编译 / 文件四件套 / 限额 / worker 池 / 子调用轨迹 / CLI。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
export default {
  capabilities: [
    {
      id: "engine.zero-dep",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "engine.zero-dep.sibling-dependency",
          file: "packages/ptc/package.json",
          from: '"dependencies": {}',
          to: '"dependencies": { "@pi-ptc/tui": "workspace:*" }',
          why: "引擎 manifest 声明了兄弟包依赖 ⇒ 零依赖契约破掉（引擎必须能脱离本仓单独装）",
          kills: "零宿主导入",
        },
      ],
    },
    {
      id: "run-cell",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "run-cell.unserializable-swallowed",
          file: "packages/ptc/src/worker-main.ts",
          from: '      if (json === undefined) return { status: "rejected", error: "程序返回值不可序列化", logs };',
          to: '      if (json === undefined) return { status: "fulfilled", value: null, logs };',
          why: "不可序列化的返回值被悄悄吞成 null ⇒ 结果信封丢了失败态",
          kills: "C10b 返回值语义",
        },
      ],
    },
    {
      id: "compile",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "compile.types-not-stripped",
          file: "packages/ptc/src/compile.ts",
          from:
            "  const stripped = stripTypeScriptTypes(`async function __ptcProgram() {\\n${source}\\n}`, {\n" +
            '    mode: "strip",\n' +
            "  });",
          to: "  const stripped = `async function __ptcProgram() {\\n${source}\\n}`;",
          why: "编译不剥 TS 类型 ⇒ 模型写的带标注程序直接语法错跑不起来",
          kills: "编译：程序里的 TS 类型标注被剥掉",
        },
      ],
    },
    {
      id: "fs-bindings",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "fs-bindings.jail-disabled",
          file: "packages/ptc/src/fs-bindings.ts",
          from: "  if (real !== workdirReal && !real.startsWith(workdirReal + sep)) {",
          to: "  if (false) {",
          why: "workdir 牢笼判定被架空 ⇒ 程序能读写 workdir 外的文件（符号链接逃逸同理）",
          kills: "workdir 越界",
        },
        {
          id: "fs-bindings.edit-accepts-ambiguous",
          file: "packages/ptc/src/fs-bindings.ts",
          from: "      if (count > 1) throw new Error(`old_string matches ${count} places — must be unique`);",
          to: "      if (false) throw new Error(`old_string matches ${count} places — must be unique`);",
          why: "edit 不再要求唯一匹配 ⇒ 多处命中只改第一处，模型以为改完了",
          kills: "edit：old_string 多处匹配",
        },
        {
          id: "fs-bindings.write-not-atomic",
          file: "packages/ptc/src/fs-bindings.ts",
          from: "      renameSync(tmp, real); // 原子落盘：半途不写坏目标",
          to: '      writeFileSync(real, content, "utf8"); // 原子落盘：半途不写坏目标',
          why: "临时文件没有 rename 覆盖目标 ⇒ 原子落盘退化成「写两份」，临时件还留在盘上",
          kills: "write：原子落盘不留临时文件残留",
        },
      ],
    },
    {
      id: "limits",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "limits.timeout-cap-lowered",
          file: "packages/ptc/src/limits.ts",
          from: "  return Math.min(Math.max(requested, 1_000), DEFAULT_LIMITS.maxTimeoutMs);",
          to: "  return Math.min(Math.max(requested, 1_000), DEFAULT_LIMITS.timeoutMs);",
          why: "超时上限被降到默认值 ⇒ 调用方申请的长任务被提前砍死",
          kills: "limits：请求再大也不突破",
        },
      ],
    },
    {
      id: "pool",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "pool.capacity-not-enforced",
          file: "packages/ptc/src/pool.ts",
          from: "    if (this.#spawned < this.#capacity) {",
          to: "    if (true) {",
          why: "容量判定被架空 ⇒ 池无限起 worker，并发闸门失效",
          kills: "池容量：满后 acquire 超时",
        },
      ],
    },
    {
      id: "sub-calls",
      face: "standalone",
      probe: "tests/standalone/engine.test.ts",
      mutants: [
        {
          id: "sub-calls.args-dropped",
          file: "packages/ptc/src/sub-calls.ts",
          from: "      argsPreview: preview.slice(0, PREVIEW_MAX_CHARS),\n      args,",
          to: "      argsPreview: preview.slice(0, PREVIEW_MAX_CHARS),",
          why: "轨迹只剩预览、没有结构化 args ⇒ 程序型子代理的 delivery 轨迹断了数据源",
          kills: "程序跑通：返回值与子调用记录都在",
        },
      ],
    },
    {
      id: "cli",
      face: "standalone",
      probe: "tests/standalone/cli.test.ts",
      mutants: [
        {
          id: "cli.json-envelope-flattened",
          file: "packages/ptc/src/cli.ts",
          from: "    console.log(JSON.stringify(outcome, null, 2));",
          to: "    console.log(JSON.stringify(outcome.value, null, 2));",
          why: "--json 打的是值不是信封 ⇒ 机器侧读不到 status/logs/subCalls",
          kills: "--json：stdout 是单个 JSON 信封",
        },
      ],
    },
  ],
};
