# PROTOTYPE (throwaway): where should a PTC run's images land?

**Question.** ADR-0014 attaches images that a PTC program's nested tool calls produced to the _PTC tool
result_. The alternative was DSH's shape: inject a message with the images (`pi.sendUserMessage([…], {
deliverAs: "steer" })`). Which is actually better in pi?

**Answer (measured, not argued).** Keep the tool result. All three routes deliver the image in the same
LLM request with no extra turn; the tool result keeps one call = one result, and the message routes add
a user-role message that the transcript cannot distinguish from something the user said.

## Run it

```bash
node docs/research/prototype-image-delivery-ab/run.mjs
```

Three headless pi sessions (canned provider, no network), one per route. The probe tool produces a 1×1
PNG; the provider records every request pi built, reduced to role + content-part shapes.

## Captured output (pi 0.87.0)

```
=== route: toolResult ===
  request 1:  system[(string)]  user[text]
  request 2:  system[(string)]  user[text]  assistant[toolCall(probe_image)]  toolResult[text, image]
  → 2 LLM request(s)

=== route: userMessage ===
  request 1:  system[(string)]  user[text]
  request 2:  system[(string)]  user[text]  assistant[toolCall(probe_image)]  toolResult[text]
                                              user[text, image]
  → 2 LLM request(s)

=== route: customMessage ===   (pi.sendMessage({ customType, content: [text, image] }))
  request 1:  system[(string)]  user[text]
  request 2:  system[(string)]  user[text]  assistant[toolCall(probe_image)]  toolResult[text]
                                              user[text, image]
  → 2 LLM request(s)
```

## What the runs establish

1. **No route costs an extra turn.** `sendUserMessage`'s "always triggers a turn" only applies when the
   agent is idle; called from inside a tool execute, the steer-queued message lands _before the next LLM
   call_ in the same turn — the same request that carries the tool result.
2. **`sendMessage` and `sendUserMessage` produce the same provider transcript** (`user[text, image]`).
   A custom message is not a distinct role where it matters: at the provider boundary it is a user
   message. Its extras are local (a `customType`, `display: false`, a renderer hook).
3. **The tool-result route is the only one where the image belongs to the call that produced it.**
   `assistant[toolCall] → toolResult[text, image]` is one call, one result. The message routes leave the
   image in a message of its own, which is indistinguishable from user input in a transcript, in a
   `context` handler's message list, or after a compaction/pruning pass.
4. **The message routes share the steer queue** with whatever the user types while the run streams, so
   ordering between "our images" and "the user's instruction" is not ours to control. The tool result has
   no such race: the images are in the result, in call order.

## Verdict

ADR-0014 stands: image blocks on the PTC tool result, no message injection.

Conditions that would flip it — none of which hold today:

- If a pi compaction/pruning pass dropped tool results but kept user messages, the message route would
  outlive the run's own record. Not measured here; would need a compaction probe.
- If the images had to _outlive_ the tool call that produced them in the transcript (e.g. a run whose
  images are produced by a helper and reported later, after the result is closed).
- If pi ever rejects images inside a tool result for some provider path (`input: ["text"]` models were
  not exercised here).

## Not part of the product

Nothing in `src/` imports this directory. It exists to hold the evidence for ADR-0014's divergence
note; delete it once that note no longer needs support.
