import { stripTypeScriptTypes } from "node:module";

export type PtcProgram = () => Promise<unknown>;

// ADR-0060：程序强制严格模式、无 opt out；「use strict」经 Function 体指令序言内传，程序自写指令成为 no-op
export function compileProgram(source: string): PtcProgram {
  // 先包进函数体再剥类型：node 的 strip 按 module 目标解析，顶层 return/await 会被拒
  const stripped = stripTypeScriptTypes(`async function __ptcProgram() {\n${source}\n}`, {
    mode: "strip",
  });
  return new Function(`"use strict";\n${stripped}\nreturn __ptcProgram;`)() as PtcProgram;
}
