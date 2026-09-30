# Test Discipline (Oracle check, 阻塞级)

适用文件:tests/**/*.test.ts(dispatch 系列见更严的 test-discipline-oracle.md)。

## 6 条硬约束(详见 docs/testing-constraints.md)

1. IO 边界成功/失败双路径都有单测。
2. Mock / fixture 数据来自真实样例(响应快照、线上文件、字面量常量),不来自实现反推。
3. 失败路径有 warn 或显式错误状态 — 不留静默失败。
4. 期望值能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分测试)。
5. 反事实判据:把实现改成显然错误但符合该断言的版本,测试必须红。
6. characterization vs specification:snapshot / 实现输出抄写的期望值是防回归,不是防错误;
   不能作为实现正确的证据。

## 反事实判据(必跑)

    > 把被测代码改成显然错误但符合该测试断言的版本,测试会红吗?
    > 会红 = specification(防错误)。OK
    > 不会红 = characterization / 没有覆盖。X → 必须补测试或删除该断言。

## 必查

每个新断言 / 修改后的断言都要回答:

| 问题                                             | 合法                                                       | 嫌疑                            |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------- |
| 期望值的来源?                                    | spec 行号 / ticket 验收条件 / 真实数据 / 不变量 / 差分测试 | 实现反推 / 同义反复 / 自洽 mock |
| 防的 regression?                                 | 命名一个具体的、可观察行为                                 | 没说清 / 只 restate 实现        |
| 反事实改错还红?                                  | 是                                                         | 否                              |
| conditional assertion?(if (...) { expect(...) }) | 无                                                         | 命中(详见下方)                  |

## 阻塞 finding(命中即 PR 阻塞)

### F1. accept-both 断言

    expect(result.status).toMatch(/^(fulfilled|rejected)$/)   // X 接受两者
    expect(result.value).toMatch(/^(\d+|null)$/)              // X

期望值要么是 fulfilled,要么是 rejected,不能是两者皆可。

### F2. conditional assertion

    if (result.status === 'fulfilled') {
      expect(result.text.length).toBeGreaterThan(0)   // X 仅 success path 真验证
    }

失败路径被静默放过。改为无条件断言(或拆成两个独立测试)。

### F3. opt-in gate + early return without assert

    if (process.env.PT_DISPATCH_E2E !== '1') {
      console.log('skipped');
      return;   // X vitest 把 return 视为 pass,默认 CI 跑不到真验证
    }

要么显式 test.skip() 让 CI 看到 SKIPPED,要么无条件运行。
本仓库配套 fixture tests/test-meta-discipline.test.ts 自动扫这 3 类。

## 严重性升级(Q9-D)

任何 F1/F2/F3/F4 命中 → delegate 复核(OCR precision 不够,需要反事实判据)。
