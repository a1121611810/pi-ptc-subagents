import { stripTypeScriptTypes } from "node:module";

// ADR-0014：程序强制严格模式、无 opt out；「use strict」经指令序言内传，程序自写指令成为 no-op
// 决策 30：产出是「在运行格内求值」的源码（worker 侧 vm.runInContext），程序的全局 = 格内注入绑定
export function compileProgram(source: string): string {
  // 先包进函数体再剥类型：node 的 strip 按 module 目标解析，顶层 return/await 会被拒
  const stripped = stripTypeScriptTypes(`async function __ptcProgram() {\n${source}\n}`, {
    mode: "strip",
  });
  return `"use strict";\n${stripped}\n;globalThis.__ptcProgram = __ptcProgram;`;
}
