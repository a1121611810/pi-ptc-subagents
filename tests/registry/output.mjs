// output 面能力分片：截断契约 / 文本卫生 / 渲染预算 / 结果文本。
// 「锚点 → 缺陷」对照表：锚点必须在目标文件里恰好出现一次（registry.mjs 与 mutate.mjs 各查一次）。
export default {
  capabilities: [
    {
      id: "truncate",
      face: "output",
      probe: "tests/output/display.test.ts",
      mutants: [
        {
          id: "truncate.head-window-empty",
          file: "packages/tui/src/truncate.ts",
          from: "const head = lines.slice(0, TRUNCATION_HEAD_LINES);",
          to: "const head = lines.slice(0, 0);",
          why: "头窗为空 ⇒ 只剩尾窗（真坏过：只留头尾）",
          kills: "截断·纯行溢出",
        },
        {
          id: "truncate.shrink-order-reversed",
          file: "packages/tui/src/truncate.ts",
          from:
            "      if (keptTail.length > 1) keptTail = keptTail.slice(Math.ceil(keptTail.length / 2));\n" +
            '      if (Buffer.byteLength(joined(keptHead, keptTail), "utf8") <= TRUNCATION_MAX_BYTES) break;\n' +
            "      if (keptHead.length > 1) keptHead = keptHead.slice(0, Math.floor(keptHead.length / 2));",
          to:
            "      if (keptHead.length > 1) keptHead = keptHead.slice(0, Math.floor(keptHead.length / 2));\n" +
            '      if (Buffer.byteLength(joined(keptHead, keptTail), "utf8") <= TRUNCATION_MAX_BYTES) break;\n' +
            "      if (keptTail.length > 1) keptTail = keptTail.slice(Math.ceil(keptTail.length / 2));",
          why: "交替收缩写反：先砍头窗（真坏过：收缩顺序写反）",
          kills: "截断·行字节双溢出",
        },
        {
          id: "truncate.utf8-boundary-dropped",
          file: "packages/tui/src/truncate.ts",
          from: "while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;",
          to: "while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x00) cut--;",
          why: "切点不再对齐 UTF-8 边界 ⇒ 切出半个字符（真坏过）",
          kills: "截断·巨行字节兜底",
        },
      ],
    },
    {
      id: "text-hygiene",
      face: "output",
      probe: "tests/output/display.test.ts",
      mutants: [
        {
          id: "text-hygiene.ansi-kept",
          file: "packages/tui/src/text.ts",
          from: '  return text.replace(ANSI_PATTERN, "");',
          to: "  return text;",
          why: "ANSI 不再剥离 ⇒ 控制符进渲染",
          kills: "文本卫生",
        },
      ],
    },
    {
      id: "bounds",
      face: "output",
      probe: "tests/output/display.test.ts",
      mutants: [
        {
          id: "bounds.children-budget",
          file: "packages/tui/src/bounds.ts",
          from: "  VALUE_TREE_MAX_CHILDREN: 6,",
          to: "  VALUE_TREE_MAX_CHILDREN: 7,",
          why: "渲染预算表被改宽 ⇒ 值树子项上限失守",
          kills: "渲染预算冻结表",
        },
      ],
    },
    {
      id: "result-text",
      face: "output",
      probe: "tests/output/display.test.ts",
      mutants: [
        {
          id: "result-text.marker-bytes-lie",
          file: "packages/tui/src/truncate.ts",
          from: "${bytes - keptBytes} 字节",
          to: "${bytes} 字节",
          why: "标记行字节数撒谎（真坏过：标记数字撒谎）",
          kills: "截断·标记行",
        },
        {
          id: "result-text.tail-anchor-off-by-one",
          file: "packages/tui/src/truncate.ts",
          from: "const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);",
          to: "const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES + 1);",
          why: "尾窗锚定错位 ⇒ 原文最后一行被丢（真坏过）",
          kills: "截断·尾窗锚定",
        },
        {
          id: "result-text.rejected-prefix-dropped",
          file: "packages/output/src/result-text.ts",
          from: "`[rejected] ${outcome.error}`",
          to: "`${outcome.error}`",
          why: "rejected 的标记前缀消失 ⇒ 模型分不出失败态",
          kills: "rejected：错误行带",
        },
      ],
    },
  ],
};
