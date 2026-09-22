# Image-bearing tool results are hoisted onto the PTC tool result

A PTC program's data channel is lossless JSON in both directions, so an image is invisible to the
model: `await tools.read({ path: "shot.png" })` hands the _program_ an image block, but the only thing
that comes back is the program's JSON return value — a marker string (`Read image file [image/png]`)
or, if the program returns the block, tens of thousands of tokens of base64 that no model can read.
DSH solves this out of band, and this package now does the same at the same seam.

Status: accepted (2026-09-22). Behavior change on the model-facing side (an image can now appear in
the PTC tool result); no protocol, dispatcher-contract or program-visible change.

## What DSH does (the parity target)

`@deepseek-ai/dsh-tools@0.1.6-alpha.1`, in its scheduler's commit step (`lib/types/ptc.js`):

```js
if (!result.isError && result.content.some((block) => block.type === "image")) {
  exec.deferContext(
    createUserMessage({
      content: result.content,
      source: { kind: "plugin", plugin: "tools-ptc" },
    }),
  );
}
```

`deferContext` queues a `UserMessage` that the agent loop appends **after** the tool result, so the
image reaches the model without crossing the program's JSON boundary. DSH also states the contract in
`run_code`'s own description: _"Only what you print or return is program output — curate it.
Image-bearing subtool results are attached after the run."_ Evidence and source references:
`docs/research/dsh-ptc-image-hoisting.md`.

## Decision

**1. Hoist on the host, at the same seam.** The dispatcher already sees every binding result before it
is posted to the worker, so `dispatchCall` is where DSH's `commit` is here: a _successful_ result whose
`content` carries `{ type: "image", data, mimeType }` blocks has those blocks collected onto the run's
outcome (`PtcRunOutcome.images`). Nothing about what the program receives changes — the hoist is
additive, and the worker still gets the whole content.

**2. A failed or cancelled run attaches nothing.** The condition is a successful subtool result _and_ a
successful run: `postCallResult` returning false (the port rejected the payload) or `settleTerminal`
owning the terminal state (timeout/abort) drops the images, because the tool layer _throws_ for those
runs and there is no result to carry them.

**3. The images ride the PTC tool result as image blocks.** `renderToolResult` returns
`[{ type: "text", … }, …imageBlocks]`, which is exactly how pi's own `read` hands a picture to the
model (`AgentToolResult.content` accepts both, and pi resizes tool-result images per
`inputLimits.images.resize`). `details` carries only `imageCount` — a second copy of the base64 in
`details` would pin the same payload twice — and the text block never contains the data.

**4. Nothing is capped, deduped or dropped.** DSH hoists every image-bearing subtool result and so does
this package: how much context a run spends on images is the program's call, and a cap hidden behind a
warning would make this layer a gatekeeper DSH is not. Reading the same file twice attaches the image
twice, because that is what the program did. The volume is not invisible — the TUI row's meta carries
`N images` and the model sees every attachment — but nothing here decides for the program.

**5. The model is told, in DSH's own words.** The contract sentence lives in `ptc_run_code`'s
description, in `PTC_TOOL_GUIDELINES` and in the PTC-mode briefing (which supersedes the guidelines in
that mode): image-bearing tool results are attached after the run, so never return image data as the
completion value.

## Divergences from DSH, stated plainly

- **Same tool result, not a deferred user message** (measured, pi 0.87 —
  `docs/research/prototype-image-delivery-ab/`). All three routes deliver the image in the _same_ LLM
  request with **no extra turn**, so this is not a cost argument: it is provenance. `assistant[toolCall] →
toolResult[text, image]` keeps one call = one result, while `pi.sendUserMessage` and `pi.sendMessage`
  leave the image in a message that reaches the provider as a **user** message — indistinguishable from
  something the user said in a `context` handler's list or after a compaction pass — and share the steer
  queue with the user's own instructions, so ordering against them is not ours to control. (An earlier
  draft of this ADR claimed the message route would add a turn boundary; the prototype disproved that.)
  Conditions that would still flip the choice are listed in the prototype's README.
- **`additionalContexts` has no pi-ptc counterpart** — it is DSH's general ferrying mechanism and this
  package has no nested-tool dispatch to ferry from.

## Consequences

- **Context cost is now automatic.** Reading an image inside a program attaches it, whether or not the
  program wanted to show it — DSH's trade-off, chosen deliberately; the alternative (only when the
  program returns the block) was rejected because "return the image" cannot be expressed in lossless
  JSON without base64 anyway.
- Tools that never produce images are unaffected: `images` is absent, so the outcome shape and every
  existing `toEqual` assertion stay as they were.
- **Images are not output.** They never pass ADR-0003's output budget, which measures logs plus the
  completion value, so a run can attach more image bytes than it may print as text. That is deliberate:
  the budget exists to bound the text a program _writes_, not the pictures it looked at, and pi's
  per-model image resize bounds each attachment at the provider.
- A screenshot-heavy program now costs image tokens rather than being silently degraded to a marker
  string. That is the point: silent degradation is what made the model blind in PTC mode.
