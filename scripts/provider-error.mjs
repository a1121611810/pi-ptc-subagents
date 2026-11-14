/**
 * 认出「provider 把请求挡了」这类失败（429 配额 / 限流 / 认证）。
 *
 * 真机脚本读的是 pi 的事件流。provider 报错时，流里没有工具调用、没有正文，只有
 * auto_retry_start 与 stopReason=error。不把它单独认出来，断言就会落成「模型没派发」
 * 「孩子没交报告」这种指向错方向的结论——实测踩过（2026-11-14：MiniMax Token Plan
 * 用量上限 2056，pi 重试 3 次后放弃，父会话零工具调用）。
 */

/** 单个事件里的 provider 错误；没有则 null */
export function providerFailureFromEvent(event) {
  if (
    event?.type === "auto_retry_start" &&
    /rate_limit|用量上限|429|quota/i.test(event.errorMessage ?? "")
  ) {
    return event.errorMessage;
  }
  if (event?.type === "turn_end" && event.stopReason === "error") {
    return event.errorMessage ?? "provider 报错（stopReason=error）";
  }
  return null;
}

/** 事件流文本里的 provider 错误；没有则 null */
export function providerFailureFromText(text) {
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const failure = providerFailureFromEvent(event);
    if (failure) return failure;
  }
  return null;
}
