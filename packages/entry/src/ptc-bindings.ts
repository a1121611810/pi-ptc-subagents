// 旧 ADR-0040：bash 是唯一的 opt-in 绑定——known 全集（报错与可授权性），default = known − opt-in
export const KNOWN_BINDING_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write"] as const;
export const OPT_IN_BINDING_NAMES = ["bash"] as const;

export type BindingName = (typeof KNOWN_BINDING_NAMES)[number];

export const DEFAULT_BINDING_NAMES: readonly BindingName[] = KNOWN_BINDING_NAMES.filter(
  (name) => !(OPT_IN_BINDING_NAMES as readonly string[]).includes(name),
);

// 旧 ADR-0005 T7 + 旧 ADR-0010：binding 表 = 已知名单 ∩ 会话作用域（作用域由宿主给：≥0.99 是活跃工具，0.86/0.87 是已注册工具）
export function resolveBindingNames(
  activeToolNames: readonly string[],
  optIns: readonly string[] = [],
): BindingName[] {
  const allowed = new Set<string>([...DEFAULT_BINDING_NAMES, ...optIns]);
  return KNOWN_BINDING_NAMES.filter((name) => activeToolNames.includes(name) && allowed.has(name));
}
