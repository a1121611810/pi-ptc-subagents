import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ADR-0039/0032：agent 定义发现——<dir>/<name>.md + 极简 frontmatter（--- 包围的 key: value 行）
export interface AgentDefinition {
  name: string;
  path: string;
  /** ADR-0032：frontmatter childReport: false/no 退出报告契约；typo 视为开（意外的契约是可见多字段，反过来不可恢复） */
  childReport: boolean;
  /** frontmatter tools: a,b,c（argv 收窄已接） */
  tools?: string[];
  /** ADR-0044：定义可钉模型/思考档位——解析序「调用参数 → 定义 → 会话」 */
  model?: string;
  thinkingLevel?: string;
}

export function parseAgentMarkdown(path: string, name: string): AgentDefinition {
  const raw = readFileSync(path, "utf8");
  const definition: AgentDefinition = { name, path, childReport: true };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return definition;
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!;
    if (key === "childReport") definition.childReport = !(value === "false" || value === "no");
    if (key === "tools") definition.tools = value.split(",").map((t) => t.trim());
    if (key === "model") definition.model = value;
    if (key === "thinkingLevel" || key === "thinking_level") definition.thinkingLevel = value;
  }
  return definition;
}

export type AgentScope = "user" | "project" | "both";

export interface AgentDirs {
  userDir: string;
  projectDir: string;
}

// 层级覆盖：both = [project, user]（近者优先——project 定义覆盖同名 user 定义）
function scopedDirs(dirs: AgentDirs, scope: AgentScope = "both"): string[] {
  if (scope === "user") return [dirs.userDir];
  if (scope === "project") return [dirs.projectDir];
  return [dirs.projectDir, dirs.userDir];
}

export function findAgent(
  name: string,
  dirs: AgentDirs,
  scope: AgentScope = "both",
): AgentDefinition | null {
  for (const dir of scopedDirs(dirs, scope)) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return parseAgentMarkdown(path, name);
  }
  return null;
}

export function listAgentNames(dirs: AgentDirs, scope: AgentScope = "both"): string[] {
  const names = new Set<string>();
  for (const dir of scopedDirs(dirs, scope)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) names.add(file.slice(0, -3));
    }
  }
  return [...names];
}
