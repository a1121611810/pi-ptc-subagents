// website 面能力分片：站点 gate（判据脚本原地保留，探针只调用它们）。
export default {
  capabilities: [
    {
      id: "site.gates",
      face: "website",
      probe: "tests/website/site-gates.test.ts",
      // 这份探针会调反事实 harness，它对**真实工作树**取摘要（性质 4：跑完必须与跑之前逐字节相同）
      // ⇒ 别的探针并发写工作树就会让它红。标成 alone：基线里它必须单独跑（2026-11-14 踩到过）。
      alone: true,
      mutants: [
        {
          id: "site.gates.invented-tool-allowed",
          file: "packages/website/scripts/check-landing-tool-names.mjs",
          from: ": !registered.has(claim)",
          to: ": false",
          why: "落地页可以宣称没注册的工具名 ⇒ 第一方向失守",
          kills: "反事实·落地页工具名",
        },
        {
          id: "site.gates.broken-link-allowed",
          file: "packages/website/scripts/check-internal-links.mjs",
          from: "return candidates.some((c) => routes.includes(c));",
          to: "return true;",
          why: "任何路由都算解析成功 ⇒ 死链放行",
          kills: "反事实·内部链接",
        },
        {
          id: "site.gates.unprojected-doc-allowed",
          file: "packages/website/scripts/check-projection-coverage.mjs",
          from: "if (projected.has(doc)) continue;",
          to: "if (true) continue;",
          why: "没人投影的文档也算已投影 ⇒ 覆盖检查失守",
          kills: "反事实·投影覆盖",
        },
      ],
    },
  ],
};
