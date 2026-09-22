/**
 * Test fixture: a canned provider that reports what pi actually assembled for the request.
 *
 * There is no way to assert on the model-visible tool set without a provider round-trip — the tool
 * declarations are assembled per request. This fixture supplies that round-trip offline: a custom
 * `streamSimple` (pi-ai's `createAssistantMessageEventStream` exists "for use in extensions") that
 * observes the normalized transcript and returns a fixed reply, so no network, credentials or
 * retries are involved.
 *
 * The observed values come from pi-ai's transcript helpers rather than a hand-built payload:
 * `getCurrentTools()` replays the `tools`/`sections` patches in the leading system message into the
 * authoritative declaration list, and `getCurrentSystemPrompt()` the prompt. Those are the same
 * helpers pi's own providers read, so this records pi's assembly — not the fixture's opinion of it.
 *
 * `PTC_PROBE_NARROW` (comma-separated tool names) makes the fixture narrow the session loadout in
 * `session_start`, which is how the tests verify the mechanism PTC mode depends on: that
 * `setActiveTools()` really does change what the provider is asked to offer. PTC mode itself cannot
 * be exercised from a test process (it is TUI-only and there is no TTY here), so the two halves are
 * verified separately — this fixture proves pi's half, and the mode unit tests prove ours.
 *
 * Not a `.test.ts` file, so the test runner never collects it as a suite.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";

const PROVIDER = "ptc-probe";
const MODEL = "ptc-probe-model";

/** What a test wants to know about the request pi built. */
interface ProbeRecord {
  /** Tool names the model was offered, in declaration order. */
  tools: string[];
  /** The assembled system prompt (where `promptSnippet` entries land). */
  prompt: string;
}

function record(): void {
  // Written by `streamSimple` below; declared here so the type is next to the shape it describes.
}

export default function cannedProvider(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const narrow = process.env.PTC_PROBE_NARROW;
    if (narrow === undefined || narrow.length === 0) return;
    pi.setActiveTools(narrow.split(",").map((name) => name.trim()));
  });

  pi.registerProvider(PROVIDER, {
    name: "PTC probe (offline)",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "not-a-real-key",
    api: "anthropic-messages",
    models: [
      {
        id: MODEL,
        name: "PTC probe model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, context) => {
      const out = process.env.PTC_PROBE_OUT;
      if (out !== undefined) {
        const payload: ProbeRecord = {
          tools: getCurrentTools(context.messages).map((tool) => tool.name),
          prompt: getCurrentSystemPrompt(context.messages),
        };
        writeFileSync(out, JSON.stringify(payload), "utf8");
      }

      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "probe done" }],
        api: "anthropic-messages" as const,
        provider: PROVIDER,
        model: MODEL,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "probe done", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "probe done", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });

  void record;
}
