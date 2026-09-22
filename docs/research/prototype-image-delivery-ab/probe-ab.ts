/**
 * PROTOTYPE — throwaway. Answers ONE question: where should the images a PTC program's tool calls
 * produced land in the conversation the model reads? See ./README.md.
 *
 * Three routes, one env var (AB_ROUTE):
 *   toolResult    — image blocks in the probe tool's own result (what pi-ptc does today, ADR-0014)
 *   userMessage   — pi.sendUserMessage([text, image], { deliverAs: "steer" }) from inside execute
 *   customMessage — pi.sendMessage({ customType, content: [text, image] }, { deliverAs: "steer" })
 *
 * A canned provider records every request pi builds (role + content part types, nothing else) and
 * drives the conversation: request 1 asks for the probe tool, later requests finish.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** A valid 1×1 PNG, base64. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const PROVIDER = "probe-ab";
const MODEL = "probe-ab-model";

/** One line per request: what the model would have read, reduced to shapes. */
function describeRequest(index: number, messages: readonly unknown[]): string {
  const described = messages.map((raw) => {
    const message = raw as { role?: string; content?: unknown };
    const parts = Array.isArray(message.content)
      ? message.content.map((part) => {
          const block = part as { type?: string; toolName?: string; content?: unknown };
          if (block.type === "toolResult" || block.type === "tool_result") {
            const inner = Array.isArray(block.content)
              ? block.content.map((c) => (c as { type?: string }).type).join("+")
              : "?";
            return `toolResult(${block.toolName ?? "?"}: ${inner})`;
          }
          if (block.type === "image") return "image";
          if (block.type === "text") return "text";
          if (block.type === "toolCall")
            return `toolCall(${(block as { name?: string }).name ?? "?"})`;
          return block.type ?? "?";
        })
      : ["(string)"];
    return `${message.role ?? "?"}[${parts.join(", ")}]`;
  });
  return JSON.stringify({ request: index, messages: described });
}

export default function probeAb(pi: ExtensionAPI): void {
  const route = process.env.AB_ROUTE ?? "toolResult";
  const out = process.env.AB_OUT;
  let request = 0;

  const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
  const text = {
    type: "text" as const,
    text: "Image from probe_image (a 1x1 PNG).",
  };

  pi.registerTool({
    name: "probe_image",
    label: "probe_image",
    description: "Produce an image for the delivery-route prototype.",
    parameters: Type.Object({}),
    async execute() {
      if (route === "userMessage") {
        pi.sendUserMessage([text, image], { deliverAs: "steer" });
        return { content: [{ type: "text", text: "attached via sendUserMessage" }], details: null };
      }
      if (route === "customMessage") {
        pi.sendMessage(
          { customType: "probe-image", content: [text, image], display: false },
          { deliverAs: "steer" },
        );
        return { content: [{ type: "text", text: "attached via sendMessage" }], details: null };
      }
      return { content: [{ type: "text", text: "here is the image" }, image], details: null };
    },
  });

  pi.registerProvider(PROVIDER, {
    name: "image delivery prototype (offline)",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "not-a-real-key",
    api: "anthropic-messages",
    models: [
      {
        id: MODEL,
        name: "prototype model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, context) => {
      request += 1;
      if (out !== undefined)
        appendFileSync(out, `${describeRequest(request, context.messages)}\n`, "utf8");

      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const base = {
        role: "assistant" as const,
        api: "anthropic-messages" as const,
        provider: PROVIDER,
        model: MODEL,
        usage,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();

      if (request === 1) {
        const toolCall = {
          type: "toolCall" as const,
          id: "call-1",
          name: "probe_image",
          arguments: {},
        };
        const message = { ...base, content: [toolCall], stopReason: "toolUse" as const };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
        return stream;
      }

      const message = {
        ...base,
        content: [{ type: "text" as const, text: `done (${route})` }],
        stopReason: "stop" as const,
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: `done (${route})`,
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: `done (${route})`,
        partial: message,
      });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
}
