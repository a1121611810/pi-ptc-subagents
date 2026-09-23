# PTC Protocol Pair-Correctness (audit 3a, 阻塞级)

适用文件:src/runtime/protocol.ts。

## 风险

PTC 协议帧定义跨 host↔worker 边界。两端必须严格共享同一份表,否则消息路由静默丢弃。
dist/index.js(host)和 dist/worker.js(worker)分别 build,静态 import 自同一 protocol.ts,
但任何硬编码 frame kind 字符串的代码(未通过常量导入)都是潜在 drift 源。

## 必查

1. frame kinds 出口统一:所有 host 端读 HOST_FRAME_KIND.* 的地方都是 import 而非字面量。
   - 检索:在 src/runtime/(除 protocol.ts 本文件)中 grep 字面量 'connect' / 'init' / 'call-result' / 'cancel' / 'ready' / 'call' / 'log' / 'narration' / 'phase' / 'result' / 'error'
   - 命中 = 阻断 finding,要求改为常量引用。

2. log levels 出口统一:所有 'log' / 'info' / 'warn' / 'error' / 'debug' 字面量(在非协议文件里)→ 改为 PTC_LOG_LEVEL.*。
   - 例外:用户可见 UI 文案不算。

3. error kinds 出口统一:'exception' / 'timeout' / 'abort' / ... 字面量必须从 PTC_ERROR_KIND 取。

4. describeValue 共享:protocol.ts 同时被 host bundle 和 worker bundle import,
   任何 describeValue 的输出格式变更都会破坏两端对齐。改它时必须附 grep 两侧 consumer。

## 阻塞触发条件

- 上述任一 finding 命中 → PR 阻塞。
- 例外:仅 protocol.ts 内部常量定义自身的字面量(那是源头,合法)。

## 严重性升级(Q9-D hook)

任何命中此规则的 finding 触发 delegate 模式复核(host agent sub-agent 而非 OCR DeepSeek-flash),
理由:协议 drift 是 silent failure,OCR precision 优势无法补偿 recall 缺失。
