# PTC Render Bounds (audit 3c)

适用文件:src/tools/render.ts(以及 src/tools/text.ts 的部分函数)。

## 硬约束(README 'TUI rendering' + ADR-0015)

| 维度                   | 上限                | 来源     |
| ---------------------- | ------------------- | -------- |
| 树深度                 | 4                   | README   |
| 容器子节点数           | 6                   | README   |
| 单行字符数             | 120                 | README   |
| 文本块 tail-truncation | 50 KiB / 2000 lines | ADR-0015 |

## 必查

1. cap 常量集中:四个上限必须是命名常量(MAX_DEPTH / MAX_CHILDREN / MAX_WIDTH / MAX_*_BYTES),
   不是 magic number 散落在 render 函数里。改上限时所有引用点必须联动。

2. 截断后元信息:文本块超过 50 KiB / 2000 lines 时必须显式标 truncated(参考 ADR-0015),
   不可静默丢弃。

3. 截断保留符号:容器被截断时必须出保留符号(形如 '...+N more keys' 或尾部省略号),
   用户能看出还有更多。写死的字面量要保持单一来源。

4. 连接符正确:├─ / └─ / │ / space 四种字符用于区分 nesting vs continuation,
   不要混用 ASCII fallback(+-- / |)。

5. 不做 JSON.stringify:返回值渲染走 renderModelValue,禁止对 completion value 走 JSON.stringify。
   那会让 report 退化成换行符噪声(ADR-0013)。

## 阻塞触发

- 改了 cap 但忘了改常量 / 没引入常量 → 建议级(找出所有点)。
- 截断后无 truncated 标记 / 截断静默 → PR 阻塞(违反 ADR-0015 契约)。

## 严重性升级(Q9-D)

不升级 — render bounds 是 visual contract,OCR 视觉 review 够用,不必 delegate。
