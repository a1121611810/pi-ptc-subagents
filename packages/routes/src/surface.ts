// ADR-0005：surface = 哪个编排器对模型负责。词汇归 routes 持有（模型面散文层），entry 的检测逻辑 import 它
export const SURFACE_MODES = ["full_ptc", "codemode_ptc"] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];

export const FALLBACK_SURFACE_MODE: SurfaceMode = "full_ptc";
