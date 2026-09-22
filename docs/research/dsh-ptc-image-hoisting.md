# DSH: how a PTC program's images reach the model

Investigated 2026-09-22 while deciding whether pi-ptc's PTC mode should keep the model blind to images
(`tools.read` on a PNG returns a marker string, or base64 the model cannot read) or attach them.

## Sources

- `@deepseek-ai/dsh-tools@0.1.6-alpha.1`, `@deepseek-ai/dsh-ptc-runtime@0.1.6-alpha.1`,
  `@deepseek-ai/dsh-workflow-ptc@0.1.6-alpha.1` — npm tarballs (`registry.npmmirror.com`, the registry
  this machine resolves `@deepseek-ai/*` against).
- `https://github.com/deepseek-ai/deepseek-harness` — **not reachable from here** (`gh repo view` ends
  in an API EOF, so the repo was not read). The published packages are the evidence, and they are the
  same source the repo's earlier `dsh-v0.1.6-alpha.2` notes were written against.
- Version gap to close later: the repo's R1 notes cite `alpha.2`; the mirror only served `alpha.1`.
  Nothing below depends on a change between them, but the parity claim should be re-checked against
  `alpha.2` (or the repo's main branch) when network access allows.

## Finding

Images do **not** travel through the program's return value. DSH hoists them out of band, in the
scheduler's commit step (`dsh-tools/lib/types/ptc.js`, the `commit()` of a composite PTC call):

```js
const result =
  parked.kind === "post-result"
    ? await scheduler.finalize(parked.exec, parked.result)
    : scheduler.finish(parked.exec, parked.result);
if (!result.isError && result.content.some((block) => block.type === "image")) {
  exec.deferContext(
    createUserMessage({
      content: result.content,
      source: { kind: "plugin", plugin: "tools-ptc" },
    }),
  );
}
for (const context of result.additionalContexts ?? []) exec.deferContext(context);
```

`deferContext` (documented on `ToolRunContext`, `dsh-tools/lib/types/index.d.ts`; implemented at
`lib/types/index.js` `deferContext(context) { deferredContexts.push(context); }`) attaches a
`UserMessage` to _that tool execution's own result_: the agent loop appends it only after the
`tool/result`, keeping each context's own `source` metadata and call order. So:

- the whole `content` array is forwarded — the deferred message carries the subtool's text block too
  (`Read image file [image/png]`), not just the image;
- failed results are excluded (`!result.isError`);
- nested `additionalContexts` are forwarded through the same channel.

The contract is advertised to the model in the tool description itself, for both flavors
(`lib/types/ptc.js`, `TYPESCRIPT_FLAVOR` / `PYTHON_FLAVOR`):

> "Only what you print or return is program output — curate it. **Image-bearing subtool results are
> attached after the run.**"

The generated SDK text says the same (`lib/types/ts-types.js`), i.e. a model writing PTC code is told
the image will arrive without being returned.

## What I could not establish

- **Any cap** on hoisted images/count/bytes at that site: `grep` for `maxImage`/`imageBytes`/
  `attachment` across the packed `dsh-tools` files finds nothing near the hoist. If DSH caps media
  elsewhere (its LLM/transport layer), it is not visible from these packages.
- Whether DSH's `run_code` tool result itself ever carries image blocks (the run's _own_ result was
  not traced beyond this commit path; the deferred message is what the finding rests on).

## Consequence for pi-ptc

pi has the same seam (the host sees every binding result before it is posted to the worker) and a
richer channel (pi's tool results carry image blocks natively, which is how `read` shows pictures).
ADR-0014 therefore hoists at the dispatcher and attaches image blocks to the PTC tool result, with
caps DSH does not have and the same model-facing sentence.
