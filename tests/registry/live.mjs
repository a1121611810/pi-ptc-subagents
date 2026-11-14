// live 面：真机冒烟接线。吃真凭据 ⇒ 不进 CI，也没有可注入的确定性锚点（exempt）。
export default {
  extras: [
    {
      id: "live.version-smoke",
      face: "live",
      probe: "tests/live/version-smoke.test.ts",
      exempt: "真机面：需要真 pi 版本矩阵 + 真凭据，没有确定性锚点可注入",
    },
    {
      id: "live.knobs-smoke",
      face: "live",
      probe: "tests/live/knobs-smoke.test.ts",
      exempt: "真机面：需要真 pi + 真模型，没有确定性锚点可注入",
    },
    {
      id: "live.session-model-smoke",
      face: "live",
      probe: "tests/live/session-model-smoke.test.ts",
      exempt: "真机面：需要真 pi + 真模型，没有确定性锚点可注入",
    },
    {
      id: "live.compact-inject-smoke",
      face: "live",
      probe: "tests/live/compact-inject-smoke.test.ts",
      exempt: "真机面：需要真 pi + 真模型，没有确定性锚点可注入",
    },
    {
      id: "live.kimi-smoke",
      face: "live",
      probe: "tests/live/kimi-smoke.test.ts",
      exempt: "真机面：需要 release/kimi 装配产物 + 真机，没有确定性锚点可注入",
    },
  ],
};
