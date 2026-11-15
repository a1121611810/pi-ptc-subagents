// 判据面：provider 错误归因（scripts/provider-error.mjs）。
// 这个模块是三个真机脚本的共同前提——它把「provider 把请求挡了」与「行为出错」分开，
// 认错方向就会把真 bug 报成配额问题（2026-11-14 实测踩过：MiniMax Token Plan 上限，
// pi 重试 3 次后放弃，父会话零工具调用）。
// 判据脚本原地保留（刀口 layer-only），这里只补薄探针 + 变异覆盖——之前它零 mutant、零探针。
import { expect, it } from "vitest";
import {
  providerFailureFromEvent,
  providerFailureFromText,
} from "../../scripts/provider-error.mjs";

it("provider 错误：认得出配额与限流（auto_retry_start 的消息里有特征）", () => {
  const event = {
    type: "auto_retry_start",
    errorMessage: "AI_APICallError: Rate limit reached for model minimax (429)",
  };
  expect(providerFailureFromEvent(event), "限流消息该被认出来").toBeTruthy();

  const quota = { type: "auto_retry_start", errorMessage: "已达到 Token Plan 用量上限 2056" };
  expect(providerFailureFromEvent(quota), "用量上限该被认出来").toBeTruthy();
});

it("provider 错误：认不出行为错误（工具失败不是 provider 挡的）", () => {
  // 无条件把 turn_end+error 当 provider 错误 ⇒ 真 bug 被报成「配额用尽」，方向指错
  const toolFailure = {
    type: "turn_end",
    stopReason: "error",
    errorMessage: "Tool read not found",
  };
  expect(
    providerFailureFromEvent(toolFailure),
    "工具失败不是 provider 挡的 ⇒ 该返回 null，让上层报真实错误",
  ).toBeNull();

  const noMessage = { type: "turn_end", stopReason: "error" };
  expect(providerFailureFromEvent(noMessage), "没消息也认不出 provider 特征").toBeNull();
});

it("provider 错误：turn_end 带配额特征时仍认得出", () => {
  const event = {
    type: "turn_end",
    stopReason: "error",
    errorMessage: "HTTP 429: quota exceeded",
  };
  expect(providerFailureFromEvent(event), "turn_end 里的配额特征该被认出来").toBeTruthy();
});

it("provider 错误：事件流文本里能捞出 provider 失败", () => {
  const stream = [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({ type: "auto_retry_start", errorMessage: "429 rate_limit" }),
    JSON.stringify({ type: "turn_end", stopReason: "error", errorMessage: "429 rate_limit" }),
  ].join("\n");
  expect(providerFailureFromText(stream), "事件流里该捞出 provider 失败").toBeTruthy();

  // 干净的事件流不该被误判
  const clean = [JSON.stringify({ type: "turn_end", stopReason: "stop" })].join("\n");
  expect(providerFailureFromText(clean), "干净的流不该报 provider 错误").toBeNull();

  // 非 JSON 行不该炸
  expect(providerFailureFromText("这不是 JSON\n{也不是"), "垃圾输入不该抛").toBeNull();
});
