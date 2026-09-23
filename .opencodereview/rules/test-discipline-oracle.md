# Test Discipline (Oracle check, dispatch 系列, 阻塞级)

适用文件:tests/dispatch-*.test.ts(dispatch / dispatch-e2e / dispatch-helpers / dispatch-concurrent 等)。

继承 test-discipline.md 的全部要求 + 以下收紧。

## 收紧项

### T1. 端到端测试必须真 spawn 子进程

tests/dispatch-e2e.test.ts 等同名的 e2e 测试,禁止在没 spawn 真实 pi 子进程的情况下 PASS。
const result = await dispatch({ agent: ..., task: ... }, ...); // OK 真 spawn
与仅测 dispatchConcurrencyLimitReached() / decideCloseOutcome() / discoverAgent() 的单元测试是不同层级,
后者不能冠 e2e / end-to-end 名。

### T2. agent fixture scope 必须与 discoverAgent 一致

discoverAgent(name, cwd, agentScope) 默认 agentScope: 'user'(只查 ~/.pi/agent/agents/)。
Test fixture 要么:

- 写 <cwd>/.pi/agents/<name>.md + 显式 agentScope: 'project'|'both' + PI_CODING_AGENT_DIR=<cwd> 让 pi 也加载;
- 或写 ~/.pi/agent/agents/<name>.md(用户级,但留全局残留要清理)。

Fixture 写在 <cwd>/.pi/agents/ 但 dispatch 调用没传 agentScope = scope mismatch = dispatch 必 reject,
e2e 必然失败 — 但若断言是 F1 accept-both,则 PASS 在错误路径上。

### T3. 必须断言 fulfilled + 期望文本

    expect(result.status).toBe('fulfilled');     // OK
    expect(result.text).toMatch(/PONG/);         // OK
    expect(result.usage).toBeDefined();          // OK
    expect(result.usage?.turns).toBeGreaterThan(0);  // OK 真跑过

禁止 F1(accept-both) / F2(conditional) 模式。

### T4. PT_DISPATCH_E2E gate 必须显式 skip

    import { test } from 'vitest';
    test.skipIf(process.env.PT_DISPATCH_E2E !== '1')('...', async () => { ... });  // OK

或不设 gate,默认必跑(CI 跑得起)。

## 阻塞 finding(命中即 PR 阻塞)

- F1/F2/F3 任一命中(继承自 test-discipline.md)
- T1/T2/T3/T4 任一命中

## 严重性升级(Q9-D)

任何命中 → delegate 复核 + fixture 必报红。
本仓库的 tests/test-meta-discipline.test.ts 会自动扫这些模式,F1/F2/F3 必须触发 fixture 失败。
