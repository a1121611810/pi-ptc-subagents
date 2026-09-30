# 06 — Upstream / first-party research: DSH "PTC" and the `pi` coding agent

**Research date:** 2026-09-29 (all upstream state as of this date)
**Method:** primary sources only — official GitHub repositories read directly (via the authenticated `gh` CLI and a shallow `git clone`), the official npm registry record, and official release notes / changelogs. **No blog posts, aggregators, or secondhand summaries were used.** Where a rendered docs site was unreachable, the claim is cited to the in-repo source file that generates that site, and this is stated explicitly.

### Legend used throughout

- **(i) Documented** — stated in official first-party documentation (rendered docs site source, official README, official release notes/changelog).
- **(ii) Source-only** — present in the official source tree but _not_ described in official documentation.
- **(iii) Inference** — my reasoning connecting documented facts. Not an official claim.

---

## 0. Headline findings (read this first)

1. **PTC = "Programmatic Tool Calling."** The acronym is expanded exactly once in the whole DSH codebase, in the **client's own UI guide string** shipped in the VS Code-style extension / web GUI. Everything else uses the acronym. (i)
2. **PTC is documented as a _subsystem_ and a _package family_, but there is no PTC page in the user guide** (`docs/user/**` has zero mentions of `PTC` or `run_code`). The only user-facing prose is the in-app preset guide dialog. (i)
3. **The tool surface is exactly one model-callable tool: the reserved transport `run_code`.** Under `mode: ptc`, all other tools are reached _inside_ the program through a generated SDK; the wire contributes only `run_code`. (i)
4. **There is no `CHANGELOG.md` in the DSH repo.** The changelog is GitHub Releases. (i)
5. **For `pi`: subagents are NOT a core documented feature.** They ship as a _checked example extension_ at `packages/coding-agent/examples/extensions/subagent/` and are absent from all 38 pages of the official documentation nav. (i) / (ii)
6. **For `pi`: there is no built-in permission or sandbox system at all** — this is stated bluntly in the official README and the security page. (i)
7. **`pi` v0.99.0 (2026-09-29) shipped `codemode`, which is `pi`'s direct analogue of PTC** — model-written JavaScript in a QuickJS sandbox calling `pi`'s tools. It _is_ documented. (i)

---

# A. DeepSeek Harness (DSH) — "Programmatic Tool Calling"

## A.0 Provenance of the project

| Fact                    | Value                                                                                         | Source                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Repo                    | `github.com/deepseek-ai/deepseek-harness`                                                     | [repo](https://github.com/deepseek-ai/deepseek-harness)                         |
| Description             | "DeepSeek Harness: Everything is a Plugin."                                                   | [repo](https://github.com/deepseek-ai/deepseek-harness)                         |
| License                 | MIT                                                                                           | [repo](https://github.com/deepseek-ai/deepseek-harness)                         |
| Default branch          | `master`                                                                                      | [repo](https://github.com/deepseek-ai/deepseek-harness)                         |
| Repo created            | 2026-08-13                                                                                    | GitHub API on the repo                                                          |
| Last push observed      | 2026-09-29T09:41:57Z (commit `639ed015`, "Merge pull request #5479 … release-dsh-0.2.0-rc.2") | [repo commits](https://github.com/deepseek-ai/deepseek-harness/commits/master)  |
| Latest release observed | `dsh-v0.2.0-rc.2`, 2026-09-29T09:42:36Z                                                       | [releases](https://github.com/deepseek-ai/deepseek-harness/releases)            |
| Homepage                | `https://deepseek.com/harness`                                                                | repo metadata                                                                   |
| Docs site               | `https://deepseek-harness.github.io/deepseek-harness/`                                        | [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) |

**Status warning carried in the official README (i):** _"DeepSeek Harness is in *developer preview* and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"_

### Note on the docs site (important for citation honesty)

The published docs site `https://deepseek-harness.github.io/deepseek-harness/` is **generated from the in-repo `docs/` tree** by a VitePress build (`website/build.ts` + `website/.vitepress/config.ts`, driven by `pnpm run docs:build`). Source: [website/build.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/website/build.ts), [package.json scripts](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json). (iii — the mapping is inferred from the build wiring; the README links the site but does not state the source mapping.)

The rendered site itself **could not be fetched from this environment** (see §D). All DSH doc citations below therefore point at the exact `blob/master/...` file that the site is built from. (iii)

---

## A.1 What PTC officially is

### A.1.1 The one-sentence official definition (i)

From the package-group README, the most direct official statement:

> "The `ptc-runtime/` group lets a model write one program that calls host-provided functions as ordinary async calls, then returns only the program's printed output and return value."

— [packages/ptc-runtime/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/README.md)

And the same README's role table describes the seam:

> "`ptc-runtime/` — Defines what a PTC runtime does: run one program against host-provided functions and report what it printed and returned" (`ctx.ptcRuntime`)

### A.1.2 Architectural position (i)

From the subsystem reference:

> "The PTC execution [capability seam] supplies `ctx.ptcRuntime` … It runs one program against host bindings and reports output, failure and applicable sandbox facts. **PTC execution is optional rather than part of the agent-loop spine.**"

— [docs/subsystems/ptc-runtime.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ptc-runtime.md)

That page also assigns ownership of the three pieces:

| Concern                                | Owning document                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry presentation                  | [2026-06-15-ptc.md (PTC foundation)](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-ptc.md)                                   |
| Binding values / typed-return contract | [2026-07-20-ptc-typed-tool-returns.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.md)              |
| Shipped execution provider             | [2026-09-11-sandboxed-node-ptc-runtime.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md) |

> Classification note (iii): these `.agents/notes/**` files are first-party design-decision records committed to the official repo. They are authoritative about intent but are **internal engineering notes, not end-user documentation**. I label them separately below.

### A.1.3 The acronym expansion and the user-facing description (i)

The **client** (the VS Code-style extension + web GUI that share `packages/client`) carries the only place in the entire repository where "PTC" is spelled out. This is the user-facing description, shipped as the in-app _preset guide_ for the built-in `ptc` preset:

> **"PTC means Programmatic Tool Calling. In this built-in preset, the agent uses `run_code` to write a TypeScript program that calls tools through a generated SDK. The program can use loops, conditions, error handling, and concurrent calls where appropriate."**
>
> **"### What reaches the model**
> Tool results first reach the program, which can filter and combine them. The model receives what the program prints or returns; image results are attached separately. Nested tool calls are still recorded and remain subject to tool permissions."
>
> **"### Compared with Standard mode**
> Both modes can handle coding and batch tasks. Standard mode exposes individual tools directly; PTC organizes tool calls in code. The current PTC preset leaves the workflow tool disabled. Speed and token use depend on the task and how the program handles its results."

— [packages/client/ui-agent-preset/src/client/guide-locales.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/guide-locales.ts) (strings `guidePtcIntro`, `guidePtcExplanation`; zh-CN equivalents in the same file)

The short picker copy for the same preset:

> "`presetPtcName`: **"PTC mode"**
> `presetPtcDescription`: "Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.""

— [packages/client/ui-agent-preset/src/client/locales.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/locales.ts)

And the preset-vs-standard contrast, from the Standard-mode guide string in the same file:

> "Standard mode can also write scripts and process files in batches. **PTC changes how tool calls are organized; it is not required for batch tasks.**"

The guide dialog only resolves these pages for **shipped** presets (`trust === 'system'`); custom presets get no guide. — [PresetGuideDialog.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/PresetGuideDialog.tsx) (i)

---

## A.2 The official tool surface

### A.2.1 One model-callable tool: `run_code` (i)

From the tool registry package README:

> "Under `ptc` or `both`, the registry exposes the **reserved `run_code` transport** plus a deterministic SDK generated in the loaded runtime's language. … Under `ptc` alone, **a model-direct call naming any other visible tool resolves to `UNKNOWN_TOOL` before policy** — the announced surface and the callable surface stay the same."

— [packages/core/tools/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) § _PTC mode_

> "`run_code` is a reserved transport **outside filterable capability layers** under `mode: ptc` / `mode: both` … Under `ptc` it is the registry's **only wire contribution**; the other visible capabilities are declared in a generated SDK section in the loaded runtime's language, and a program calls them through bindings scheduled under the native concurrency contract … that re-enter the complete guarded tool pipeline and link each nested execution to this outer result."

— [docs/tool-catalog.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md) § `run_code` (source: `packages/core/tools/src/ptc.ts`)

### A.2.2 The shipped `run_code` JSON Schema (i)

Verbatim from [docs/tool-catalog.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md):

> "Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. **Only what you print or return is program output — curate it.** Image-bearing subtool results are attached after the run."

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The program: the body of an async TypeScript function."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI)."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Positive elapsed-time budget in milliseconds, capped by the deployment maximum."
    },
    "sandbox_permissions": {
      "type": "string",
      "description": "Wider sandbox mode for this complete program execution; requires justification and approval.",
      "enum": ["workspace-write", "danger-full-access"]
    },
    "justification": {
      "type": "string",
      "description": "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user's current request."
    }
  },
  "required": ["code", "description"]
}
```

### A.2.3 The model-facing SDK instructions (i)

The exact system-prompt text the model receives in PTC mode is published in the tools README:

> ```markdown
> ## Writing code for run_code
>
> `run_code` takes two required arguments: `code` — the body of an async TypeScript function
> (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs
> type-stripped) — and `description`, a short summary of what the program does. The declarations
> below are SDK bindings for this program. A declaration does not make its name a directly callable
> tool; only names supplied as separate tool schemas may be called directly. …
>
> Inside the program:
>
> - Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`.
>   Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
> - A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and
>   whose `message` is human-readable — `try/catch` it to handle and continue.
> - Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently;
>   mutating calls run alone, in submission order). Sequence dependent work with `await`.
> - Emit results with `return` and/or `console.log(...)`. Only what you print or return is program
>   output. A successful tool result containing an image is attached after the run so you can inspect
>   it on the next step; every other intermediate result stays out of the conversation, so extract
>   just what you need.
> ```

— [packages/core/tools/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) § _Model Experience → PTC mode schema and system prompt_

Prompt-assembly details (i, same page):

- The `tools:sdk` section uses **first-party order 5000** and **disables prompt-variable interpolation**, "preserving literal `{{…}}` text in tool descriptions and schemas for both runtime languages."
- Under `mode: ptc` the prompt also carries a `tools:ptc-only` rule **earlier in the first-party order**, so the model reads which tools it may call before what each is for.
- Token effect is stated explicitly: _"PTC mode trades end-tool schemas for generated SDK text plus one transport schema rather than promising a universal reduction."_

### A.2.4 How the result is rendered back to the model (i)

> "PTC mode renders the outer program's printed lines and return value, `(run_code completed with no output)` when both are empty, or `Error: code run failed (<kind>): <message>` followed conditionally by `Captured output:` and the captured lines. **Inner dispatch events stay log-only**, while a successful image-bearing sub-result is appended after the outer result as source-attributed context."

— [packages/core/tools/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)

> "Intermediate binding values are execution-local; **only the outer `run_code` result has a hard size cap**."

— same page

### A.2.5 Sub-call identity (i)

> "New sub-calls use `<parent>:ptc:<n>` ids. Consumers treat these ids as opaque and correlate events by exact equality; **restored historical ids retain their original bytes**."

— [packages/core/tools/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)

---

## A.3 The result shape (the `ctx.ptcRuntime` contract)

This is the most precisely specified part of PTC. All from [docs/subsystems/ptc-runtime.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ptc-runtime.md). (i)

### A.3.1 Service Definition

> "`PtcRuntime` is defined in `src/index.ts`. `resolve(request)` returns complete execution inputs, and `run(spec)` executes them. `executionInstructions` supplies provider-owned usage guidance for consumer presentation. `timeout` reports the configured elapsed-time default and maximum when per-call overrides are supported… `language` selects supported program presentation; `isolation` describes the substrate **without claiming security**. `sandboxMode` advertises file-policy support, with `undefined` for a provider that does not supply confinement."

> "**Program, budget, abort, and substrate failures resolve in `PtcRunResult`; only Service Definition contract misuse rejects.** Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection class, **treat programs as hostile peers**, isolate runs from one another, and terminate and await in-flight runs during disposal."

### A.3.2 Request

```ts
interface PtcRunRequest {
  program: string; // body of an async function; completion value -> PtcRunResult.value
  bindings: PtcBindingNamespace[]; // host functions as globals, one global object per namespace
  cwd?: string;
  timeoutMs?: number | null; // omitted = provider default; number = capped budget; null = no deadline
  sandboxPolicy?: SandboxExecutionPolicy;
  signal?: AbortSignal; // resolves PtcRunResult with kind 'abort'
}

interface PtcRunSpec extends PtcRunRequest {
  cwd: string; // absolute, in the provider's execution world
  timeoutMs: number | null; // positive finite after capping, or null
}
```

> "Providers reject unsupported choices before execution."

### A.3.3 Result — the load-bearing invariant

> "**An error is a FIELD on a resolved result, never a rejection of `run()` — reporting a failed program is the caller's job, not an exception path.**"

```ts
interface PtcRunResult {
  sandbox?: PtcRunSandbox;
  value?: PtcJsonValue; // program completion value, ONLY if it ran to completion and crossed the JSON boundary
  logs: string[];
  error?: PtcRunFailure; // present iff the run failed
}

interface PtcRunSandbox {
  mode: SandboxMode;
  denied: boolean; // "not enforcement proof or an exhaustive denial record"
  enforcement?: SandboxEnforcement; // absent for full access
}

type PtcJsonValue =
  null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue };
```

Key documented consequences (i):

- "Invalid or over-limit completions **fail the run instead of substituting a rendered string**; a failed or value-less run leaves `value` absent."
- "**Sandbox mode, observed denial and enforcement completeness are separate facts, so a successful program does not by itself prove that every requested restriction was enforced.**"

### A.3.4 Bindings

> "Each `PtcBindingNamespace` becomes a global object of async callables; **PTC passes `tools`**. Arguments and resolutions must be lossless JSON. **Providers enforce their own transport caps; the seam sets no uniform binding-byte limit.**"

> "Binding names are own properties, so `__proto__` cannot traverse a prototype."

> "A runtime must treat names like `__proto__` or `constructor` as ordinary own properties (**null-prototype construction**), never as prototype collisions."

> "Binding `global` **must match the LANGUAGE-PORTABLE identifier subset `[A-Za-z_][A-Za-z0-9_]*`** and no language's reserved words … a JS-only spelling like `$tools` is **rejected by design, not just by the Python backend**." Backend-owned slots (`RESERVED_BINDING_GLOBALS`, e.g. `console`, `__dsh_main__`) are refused everywhere.

> "A runtime **rejects a lossy or non-cloneable value with a descriptive error rather than corrupting the run**."

### A.3.5 Failure taxonomy (i)

> "Failure kinds are **orthogonal outcomes reported independently**: a budget expiry is not an exception, an abort is not a timeout, and a substrate death (e.g. OOM) is neither."

```ts
type PtcRunFailureKind =
  | "exception" // program threw or failed to parse/transform
  | "timeout" // implementation-owned budget expired
  | "abort" // signal fired
  | "worker-exit" // execution substrate died without settling (e.g. OOM)
  | "invalid-output" // completion value was not lossless JSON
  | "output-limit" // serialized outer logs/value/diagnostic exceeded the cap
  | "protocol" // invalid or over-budget control traffic
  | "sandbox-unavailable"; // required confinement could not be established
```

The `message` field is documented as _"Human-readable detail, suitable for feeding back to a model to self-correct."_

### A.3.6 Output capture (i)

> "Logs are plain strings. **Each source channel preserves emission order, while interleaving across independent channels is backend-dependent** because channel metadata is not part of the seam."
>
> "Implementations cap the serialized outer log-array plus completion-value or failure-message payload… **Overflow is an explicit failure rather than in-band value substitution.**"

---

## A.4 Officially stated limits, defaults and guarantees

### A.4.1 `@deepseek-ai/dsh-ptc-runtime-node` — the shipped Node provider

This is the package named in the task. Defaults are published in a table in its official README. (i)

**Source:** [packages/ptc-runtime/ptc-runtime-node/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime-node/README.md)

| Field                    | Default                   | Official meaning                                                                   |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `timeoutMs`              | **120,000**               | "Default elapsed execution deadline, **including nested tool and approval waits**" |
| `maxTimeoutMs`           | **600,000**               | "Elapsed deadline ceiling applied by the resolver"                                 |
| `maxOutputBytes`         | **67,108,864** (64 MiB)   | "Combined serialized logs and completion or diagnostic budget"                     |
| `maxOldGenerationSizeMb` | **512**                   | "V8 old-generation heap limit in MiB"                                              |
| `maxMessageBytes`        | **134,217,728** (128 MiB) | "Limit for a control frame, outstanding argument bytes and queued control writes"  |
| `maxPendingCalls`        | **128**                   | "Maximum simultaneous host binding calls"                                          |
| `graceMs`                | **3,000**                 | "Managed termination and output-drain grace"                                       |
| `nodeExecutable`         | current Node executable   | "Executable resolved in the subprocess execution world"                            |
| `bootstrapPath`          | package bootstrap         | "Optional absolute path to a preinstalled built bootstrap in that world"           |

Also officially documented about this provider (i):

- "**Each call starts a fresh Node process** and returns captured logs, an exact JSON value, or a structured failure."
- "**Elapsed deadlines, output bounds and a V8 heap limit constrain execution**; cancellation and completion terminate the managed process range."
- "**A requested restricted mode fails when its sandbox backend is unavailable.**"
- "Programs are async function bodies: top-level `await` and `return` work, and **only erasable TypeScript is accepted**."
- "the child retains only executable-search, Windows system, and temporary paths in its OS environment and **replaces the program-visible `process.env` with an empty dictionary**."
- "**The heap limit uses Node argv or a provider-created `NODE_OPTIONS` value for packaged executables; ambient loader and inspector flags are discarded.**"
- "The host preserves `ELECTRON_RUN_AS_NODE` only for child startup… the bootstrap removes the selector before evaluating model code."
- "Timeout or cancellation stops a synchronous loop through the host's managed process owner… **The timer stops when an outcome is selected, before cleanup, so the returned call can take longer than its execution deadline while cleanup settles.**"
- "An enabled deadline… **is not a CPU meter.**"
- Service callers may pass `timeoutMs: null`; **"`run_code` continues to accept only positive numeric overrides."**

The typed config surface is independently published in the generated config catalog. (i) — [docs/config-catalog.md#deepseek-aidsh-ptc-runtime-node](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)

- `inject`: `fs` · `subprocess` · `sandbox` · `sandboxPolicy`
- Config JSDoc adds: _"V8 old-generation heap limit in MiB; **native allocations are excluded**."_

### A.4.2 Explicitly stated "Known Limitations" for the Node provider (i)

Verbatim from the [ptc-runtime-node README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime-node/README.md), headed _"These limits qualify the execution guarantees and retained output"_:

- **"Confinement inherits the selected backend's limits"** — full and partial enforcement are reported separately; sandbox policy and managed-process containment are distinct guarantees.
- **"The heap cap is not a process-tree memory limit"** — native allocations and descendant memory are outside the V8 old-generation bound. **No process-tree CPU meter is supplied.**
- **"Cleanup inherits subprocess observability"** — escaped descendants on a fallback platform may remain outside the managed range.
- **"Execution is one-shot"** — no yield/wait API, live result stream or retained program state exists between calls.
- **"Output caps reject rather than retain every byte"** — spill can preserve only the bounded result delivered by this provider.
- **"Bindings are bounded at transport admission"** — control limits do not bound the memory a host binding allocates while producing its result.
- **"The console shim has five methods"** — `log`, `info`, `warn`, `error` and `debug`.

### A.4.3 Explicitly stated PTC limitations in the tool registry (i)

From [packages/core/tools/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) § _Known Limitations and Deferred Work_:

- **"PTC mode's SDK language follows the one loaded runtime, and a presentation is per agent rather than per tool"** — `mode: ptc`/`both` **rejects prompt assembly** unless `ctx.ptcRuntime.language` has a registered SDK renderer; within one agent no tool can be native-only while another is ptc-only.
- **"PTC mode intermediate values are execution-local and unbounded by bytes"** — "they cannot be reconstructed from session replay and **may exhaust process or worker memory**; only the outer `run_code` output has the worker's configurable hard cap."
- **"`run_code` state is fresh per run"** — "a persistent REPL-style kernel is **rejected for the MVP**, because cross-call state would be invisible to the log."

### A.4.4 Security / sandbox guarantees (i)

- The service doc states the seam `isolation` field _"describes the substrate **without claiming security**."_
- `PtcRunSandbox.denied` is _"Program failure text matched backend diagnostics; **not enforcement proof or an exhaustive denial record**."_
- Node provider summary: _"Execute model-written TypeScript **under the same platform sandbox policy as Bash**."_ and _"**Direct Node APIs remain available** within the selected restrictions."_
- _"Running a program **does not change the Session's standing policy or automatically replay it after a denial**."_
- Escalation: _"A wider `sandbox_permissions` mode **requires a non-empty `justification` and approval before the program starts**. … **Programs are never replayed automatically**: inspect earlier effects before explicitly retrying a denied program."_ (tools README)

### A.4.5 Guarantees the seam _does_ make (i)

- Runs are isolated from one another; each implementation "keeps program state separate between runs and terminates and awaits active executions during disposal."
- "Each implementation… **treat programs as hostile peers**" (models are not trusted even when control messages look correct).
- Nested PTC tool calls "re-enter the complete guarded tool pipeline" and "retain the registry's visibility, ordering, logging and approval rules."
- "The named consumer owns any request-prefix changes" / "**No direct invalidation**" of KV cache by the PTC runtime.

---

## A.5 Release notes — breaking changes local docs may miss

**There is no `CHANGELOG.md` in the DSH repository** (verified: `git ls-files | grep -i changelog` returns nothing). The official changelog is GitHub Releases. (i)

DSH has published ~20 release-candidate/alpha tags from `dsh-v0.1.0-rc.7` (2026-08-17) to `dsh-v0.2.0-rc.2` (2026-09-29).

### PTC-relevant history (i)

| Release              | Date       | Statement                                                                                                                                                                                                                         |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-v0.1.2-rc.1`    | 2026-09-03 | "Rename Code Mode to PTC mode while keeping existing conversation records readable" — **the feature was previously named "Code Mode"** ([releases](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)) |
| `dsh-v0.1.5-rc.1`    | 2026-09-10 | "Support per-call timeouts for Node PTC's `run_code`, with a **default of 120 seconds and a maximum of 600 seconds**."                                                                                                            |
| `dsh-v0.1.5-rc.1`    | 2026-09-10 | "Expand and copy JSON strings in Trajectory, **inspect PTC code and call results**"                                                                                                                                               |
| `dsh-v0.1.5-rc.1`    | 2026-09-10 | "Fix PTC prompt generation failures and unintended text replacements when tool descriptions contain double braces."                                                                                                               |
| `dsh-v0.1.6-alpha.1` | 2026-09-15 | "Extend file, command, and **PTC tools so DSH can run locally while using a remote workspace over SSH**."                                                                                                                         |
| `dsh-v0.1.6-alpha.2` | 2026-09-17 | "Prevent console windows from flashing when running PTC and shell commands on Windows."                                                                                                                                           |
| `dsh-v0.1.7-rc.1`    | 2026-09-23 | **"Rename PTC packages and services to the `ptc-runtime` family without legacy aliases; update custom plugins and configurations."**                                                                                              |
| `dsh-v0.1.7-rc.1`    | 2026-09-23 | **"Replace the workflow executor with `workflow-ptc` under the session file policy; update custom configurations. Python PTC is not supported."**                                                                                 |
| `dsh-v0.1.7-rc.1`    | 2026-09-23 | **"Run Node PTC in separate processes under the session file policy with output and heap limits; `process.env` is empty, so code relying on the previous environment must migrate."**                                             |

> Migration-critical: the two `dsh-v0.1.7-rc.1` entries are explicit **breaking renames with no legacy aliases**. Any custom plugin or config written against the pre-0.1.7 PTC package/service names, or against the in-process Node execution model, must migrate. (i)

**Subagent limits in DSH** (adjacent, and explicitly stated in the same release) (i) — from [dsh-v0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1):

- "Continuable Subagent chains **default to at most 8 live children and a delegation depth of 1**, adjustable in settings."
- "Use `spawn_teammate` in experimental Team mode, **disable `subagent` and `subagent_fork`**, and raise the default **teammate creation limit from 8 to 16**."

---

## A.6 What is NOT documented for PTC (gaps)

- **No PTC content in the user guide.** `git grep -i 'run_code|PTC' -- docs/user` returns **zero matches**. The user-facing guide at `docs/user/guide/index.md` does not mention PTC. (i, negative finding)
- The docs site landing page and rendered PTC pages were not fetchable here (§D).
- No official DSH documentation was found that states a **token/cost guarantee** or a **benchmark** for PTC versus direct tool calling. The only statement is the hedged one: _"PTC mode trades end-tool schemas for generated SDK text plus one transport schema rather than promising a universal reduction."_ (i)

---

# B. The `pi` coding agent (Earendil Works)

## B.0 Provenance — the true owner and name

| Fact                | Value                                                                            | Source                                                                                       |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Repo                | `github.com/earendil-works/pi` (monorepo, "Pi Agent Harness")                    | [repo](https://github.com/earendil-works/pi)                                                 |
| Package             | `@earendil-works/pi-coding-agent`                                                | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)                         |
| Package description | "Coding agent CLI with **read, bash, edit, write** tools and session management" | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)                         |
| Repo subdirectory   | `packages/coding-agent`                                                          | npm `repository.directory`                                                                   |
| License             | MIT                                                                              | [repo LICENSE](https://github.com/earendil-works/pi/blob/main/LICENSE)                       |
| Default branch      | `main`                                                                           | [repo](https://github.com/earendil-works/pi)                                                 |
| npm created         | 2026-05-07T15:15:48Z                                                             | npm registry                                                                                 |
| Latest version      | **0.99.1** (dist-tag `latest`; also a `legacy-node20` tag at 0.74.2)             | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)                         |
| 0.99.1 published    | **2026-09-29T18:23:26Z**                                                         | npm registry / [releases v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1) |
| Repo HEAD observed  | `1b347794`, 2026-09-29T22:47:17+02:00                                            | [commits](https://github.com/earendil-works/pi/commits/main)                                 |
| Docs site           | `https://pi.dev/docs/latest`                                                     | [README](https://github.com/earendil-works/pi/blob/main/README.md)                           |

The package has **51 published versions**; recent sequence `0.85.0 -> 0.87.1 -> 0.99.0 -> 0.99.1` (a version jump from 0.87.x to 0.99.0 on 2026-09-29). (i)

### Docs provenance (iii)

The repo ships a docs tree with an explicit navigation manifest: `packages/coding-agent/docs/*.md` plus `packages/coding-agent/docs/docs.json`, which lists **38 pages**. The README links `https://pi.dev/docs/latest` as "the documentation". I therefore treat the `packages/coding-agent/docs/` files as the official documentation source. The rendered site was **not fetchable from this environment** (§D), so all citations point at the exact `blob/main/...` source file.

---

## B.1 The officially documented tool model (i)

### B.1.1 Built-in tools

The official agent-loop page describes the model as receiving _"tool definitions and skill descriptions"_ — [docs/how-pi-works.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md).

The built-in tool set is **read, bash, edit, write** per the official npm description, plus **find, grep, ls** and **powershell** present in the tool registry. (i for read/bash/edit/write; the fuller set is (ii) — see §C.)

The agent loop itself, verbatim ([docs/how-pi-works.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md)):

> "A submitted message is added to the active branch. Pi builds a model request from the system prompt, active branch, available tools, and model settings, then sends it through the selected provider. The provider streams an assistant response, which can contain text and tool calls. Pi records the response, executes each tool call, and records the results. **That completes one turn.** If tool results or queued messages require another model request, Pi starts another turn. Otherwise, the run ends."

### B.1.2 `codemode` — `pi`'s documented analogue of PTC (i)

**This is the single most relevant finding for part B**, because it is `pi`'s own "programmatic tool calling" feature, added in **v0.99.0, published 2026-09-29** — the same day as the latest release. From the official [CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md) § 0.99.0:

> "**Codemode and MCP** — Connect MCP servers and let models **run JavaScript that calls tools in parallel**."

> "Added codemode, tool search, and MCP support as **built-in extensions**. The `codemode` tool **runs model-written JavaScript in a QuickJS sandbox that calls pi's tools**; enable it with `defaultTools` or `--tools` and configure it with `codemode.mode` and `codemode.inlineBudget`."

The full official behavior spec is in [docs/cli.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) § _Enable codemode_ / _How codemode works_ (i):

> "Codemode scripts run in a **QuickJS sandbox that can only reach the other tools, through `tools.<name>(args)`**; `ALL_TOOLS` lists them. Output comes from `text(value)`, `image(dataUrlOrImageContent)`, `console.*`, and a **top-level `return value`**; `exit()` ends the script early. The result starts with `Script completed` or `Script failed`, the wall time, and the output; a failed script keeps its partial output, followed by `Script error:` and the error."

**Stated limits and defaults (i):**

| Item                     | Documented value                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_output_tokens`      | **default 10000**; longer output keeps its start and end, full text written to a temp file whose path is in the result                                                                                                                                   |
| `timeout_ms`             | **unset by default**; a hard deadline when set. Set via an options line: `// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}`                                                                                                                 |
| `codemode.inlineBudget`  | Declarations share a budget of **3000 estimated tokens**; every namespace is still listed with its tool count, and the description states whether the list is complete                                                                                   |
| `bash` output in scripts | "The `output` of `bash` is **not limited to the 2000 lines or 50KB the model sees: it holds up to 1 MiB**, and longer output keeps its first and last 512 KiB around an omission marker, with `truncated` set and the full output in `full_output_path`" |
| `codemode.mode`          | `on` (default) — declared tools keep being declared, descriptions show how to call them from scripts. `only` — they are **hidden from the model** and listed in the `codemode` description instead                                                       |
| Classifier concurrency   | `models.classify()` runs "**at most four at a time per script**"                                                                                                                                                                                         |

**Cross-call state (i):** "`store(key, value)` and `load(key)` keep JSON values across `codemode` calls: each successful script that stores values appends a `codemode-store` custom entry to the session, so resumed sessions keep the values and **each branch sees only the values written on its path**."

> Direct contrast with DSH PTC: `pi` codemode **does** persist state across calls and per-branch (`store`/`load`), whereas DSH PTC officially documents **"Execution is one-shot — no yield/wait API, live result stream or retained program state exists between calls"** and **"`run_code` state is fresh per run"**. (i, both sides)

### B.1.3 `tool_search` (i)

> "`tool_search` is **off by default**; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It uses the same ranking as `searchTools()` over tools that are **not declared yet** and declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they **stay declared on that branch**."

— [docs/cli.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)

---

## B.2 The officially documented extension model (i)

### B.2.1 Definition

> "Extensions are **TypeScript modules that add executable behavior to Pi**. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone."
>
> "**An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.**"

— [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

From [docs/how-pi-works.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md):

> "Extensions are TypeScript modules loaded into the Pi process. Their factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI."

### B.2.2 Shape, loading and lifecycle

- **Shape:** "An extension exports a **default factory** that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime."
- **Type source:** `ExtensionAPI` is imported from `@earendil-works/pi-coding-agent`; the exact type declarations live at [src/core/extensions/types.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts).
- **No build step:** "Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step."
- **Locations:** "Place the extension in your user or project extensions directory. Pi loads **direct TypeScript or JavaScript files and subdirectories containing an `index.ts` or `index.js` entry point**." Conventional paths are documented in [docs/configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md); extra paths in [docs/settings.md#resources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).
- **Load-time rule:** "Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session. Start long-lived resources from `session_start`… Close session-scoped resources from an **idempotent `session_shutdown` handler**."
- **Run lifecycle:** "A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`. … `agent_before_settle` is the final actionable boundary: it can append entries and request **one** continuation. `agent_settled` is final and notification-only."
- **Reload:** "Reload replaces the extension runtime, so code after `await ctx.reload()` must not reuse state from the old runtime."

### B.2.3 Integration-point table (verbatim, i)

| Capability                                    | Main API                                       |
| --------------------------------------------- | ---------------------------------------------- |
| Observe or modify lifecycle behavior          | `pi.on()`                                      |
| Add a model-callable operation                | `pi.registerTool()`                            |
| Add a `/` command                             | `pi.registerCommand()`                         |
| Add a shortcut or CLI flag                    | `pi.registerShortcut()` or `pi.registerFlag()` |
| Send user or custom messages                  | `pi.sendUserMessage()` or `pi.sendMessage()`   |
| Persist non-context session data              | `pi.appendEntry()`                             |
| Change active tools, model, or thinking level | Session control methods on `pi`                |
| Add a model provider                          | `pi.registerProvider()`                        |
| Add an MCP server                             | `pi.registerMcpServer()`                       |
| Route each request to a model                 | `pi.registerVirtualModel()`                    |
| Add terminal rendering                        | Renderer registration and `ctx.ui`             |
| Communicate with another extension            | `pi.events`                                    |

— [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

### B.2.4 Custom tools and nested calls (i)

> "A custom tool defines a **name, model-facing description, TypeBox parameter schema, and `execute()` function**. Its result requires model-facing `content` and a `details` field for rendering or state reconstruction."
>
> "**Throw from `execute()` to produce a failed tool result. Returning an object does not mark it as an error.**"
>
> "A tool can run other tools with `ctx.executeTool(name, args, { signal, onUpdate })`. **Nested calls go through argument validation and the `tool_call` and `tool_result` handlers like model-issued calls**… their `toolCallId` is assigned by pi as `<parent id>/<n>`. **These ids do not appear as tool calls or tool results in the transcript. Nested calls do not add transcript entries**: their results only reach the calling tool, which reports them itself… The session keeps a **bounded record** of them (name, arguments, status, duration, error; **never results**) as `nestedCalls` on the calling tool's result message."

**Stated nested-call bounds (i):** "Arguments over **8 KiB per call or 32 KiB per tool result** are omitted, **at most 256 calls** are kept, and `complete: false` marks a record that lost anything. The `usage` of nested results, at every depth, is **added to** the calling tool's result `usage`, so a tool reports only its own usage, not that of the tools it called."

> Direct contrast with DSH PTC: `pi`'s nested-call ids are **hidden from the transcript and bounded at 256 records**; DSH PTC's sub-call ids **are** recorded and surfaced in the UI (`<parent>:ptc:<n>`, with a tool-call-history sub-row UI and a dispatch-log spill feature). (i, both sides)

### B.2.5 Tool exposure — the five-level model (i)

Verbatim from [docs/extensions.md#tool-exposure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):

> "`exposure` controls how the model reaches a tool. **"Callable" means callable from other tools through `ctx.executeTool()`** (`ctx.tools`), as the `codemode` tool's scripts do:
>
> - `direct` (**default**): declared to the model while active, and callable while active.
> - `model-only`: declared to the model while active, **never callable**. Use it for tools that orchestrate other tools or ask the user.
> - `codemode`: callable whenever registered, and listed by the `codemode` tool. **Not declared to the model unless activated explicitly.**
> - `deferred`: like `codemode`, but codemode tools do not list it; `tool_search` can find and activate it.
> - `hidden`: registered but unreachable. Re-register a tool with `exposure: "hidden"` **to withdraw it, since tools cannot be unregistered.**"

Also: `namespace: { name, description }` groups related tools; `annotations` carry MCP-style `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` — **"The hints are not verified, but a permission extension can use them to decide which calls to confirm."** `prepareLoadout(loadout)` lets an orchestrating tool rewrite descriptions of declared tools.

### B.2.6 Built-in extensions and the disable path (i)

Built-in extensions shipped in source: `codemode`, `tool-search`, `mcp`, `llama` — [src/extensions/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/extensions).

> "Added a **Built-in section in `pi config`** to disable the built-in `mcp`, `llama.cpp`, `codemode`, and `tool-search` extensions globally or per project, stored as `-builtin:<name>` in the `extensions` setting. **SDK inline extensions opt in with `builtin: true`.**"
>
> "Added a warning when an extension that registers the same tool, command, or flag **replaces a built-in extension**."

— [CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md) § 0.99.0

### B.2.7 Error handling contract (i)

> "Pi reports handler errors and continues where possible. **A `tool_call` handler failure blocks the tool as a fail-safe**; a tool execution failure becomes an error result for the model."
>
> "Release resources in `session_shutdown` **even when normal operation attempted cleanup**. Keep cleanup **idempotent** because cancellation, reload, session replacement, and process exit can converge on the same path."

---

## B.3 The officially documented subagent model

### B.3.1 Headline: subagents are NOT a core documented feature (i)

**Verified negative:** `grep -i 'subagent' packages/coding-agent/docs/*.md` returns **zero matches** across all 38 documented pages, and the `docs.json` navigation contains **no subagent page**. Subagents are not mentioned in the README, the agent-loop page, or the extension docs.

They ship as a **checked example extension**:

- `packages/coding-agent/examples/extensions/subagent/README.md`
- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/examples/extensions/subagent/agents.ts`

— [examples/extensions/subagent/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)

**Classification:** this is **(ii) present in source but undocumented** as a core feature — the example ships _in the official repo_ with its own README, but it is not part of the documented product surface and must be installed manually.

### B.3.2 What the example's own README officially states (i — first-party, but example-scoped)

> "**Isolated context**: Each subagent runs in a **separate `pi` process**"
> "**Streaming output** … **Parallel streaming**: All parallel tasks stream updates simultaneously … **Abort support**: Ctrl+C propagates to kill subagent processes"

**Tool modes (documented table):**

| Mode     | Parameter          | Description                                                |
| -------- | ------------------ | ---------------------------------------------------------- |
| Single   | `{ agent, task }`  | One agent, one task                                        |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (**max 8, 4 concurrent**) |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` placeholder                   |

**Agent definitions** — markdown with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

- "When `model` is omitted, the subagent **inherits the dispatching session's active model and thinking level**."
- Locations: `~/.pi/agent/agents/*.md` (user-level, always loaded); `.pi/agents/*.md` (project-level, **only** with `agentScope: "project"` or `"both"`). Project agents override user agents of the same name when scope is `"both"`.
- Four sample agents ship: `scout` (Haiku; read, grep, find, ls, bash), `planner` (Sonnet; read, grep, find, ls), `reviewer` (Sonnet; read, grep, find, ls, bash), `worker` (Sonnet; all default tools).

**Stated limits (verbatim § _Limitations_):**

- "Output truncated to **last 10 items** in collapsed view (expand to see all)"
- "**Parallel model-visible output is capped at 50 KB per task**; full results remain in tool details"
- "**Agents discovered fresh on each invocation** (allows editing mid-session)"
- "**Parallel mode limited to 8 tasks, 4 concurrent**"

**Stated security model (§ _Security Model_):**

- "This tool executes a **separate `pi` subprocess with a delegated system prompt and tool/model configuration**."
- "**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc."
- "**Default behavior: Only loads user-level agents** from `~/.pi/agent/agents`."
- "To enable project-local agents, pass `agentScope: "both"` (or `"project"`). **Only do this for repositories you trust.**"
- "When running interactively, the tool **prompts for confirmation before running project-local agents in untrusted projects**. Trusted projects skip the additional prompt. Set `confirmProjectAgents: false` to disable confirmation."

**Error handling (§ _Error Handling_):** "Exit code != 0 -> tool returns error with stderr/output"; `stopReason "error"` propagates; `stopReason "aborted"` kills the subprocess; **"Chain mode: Stops at first failing step, reports which step failed."**

**Installation is manual** — the README instructs the user to `ln -sf` the extension, agents and prompt templates into `~/.pi/agent/`. There is no package entry; see [docs/packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for the official distribution mechanism instead.

### B.3.3 Subagent history in the changelog (i)

All entries are fixes to the **example**, not to a core feature — [CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md):

- "Fixed the subagent example repeatedly prompting before running project-local agents in trusted repositories (#8261)."
- "Fixed the subagent example rejecting YAML array syntax for the `tools` frontmatter field (#7598)."
- "Fixed the subagent example dropping parent session model, thinking, and tool configuration (#7897)."
- "Fixed the subagent extension's parallel mode to return useful per-task output and failed-task diagnostics to the parent model instead of 100-character previews (#4710)."
- "**Subagent orchestration example**: Added comprehensive custom tool example for spawning and orchestrating sub-agents with isolated context windows. Includes scout/planner/reviewer/worker agents and workflow commands for multi-agent pipelines. (#215)"

---

## B.4 Sandboxing and permissions in `pi` — the official position (i)

**This is stated unusually bluntly and is the clearest contrast with DSH.**

From the official [README](https://github.com/earendil-works/pi/blob/main/README.md) § _Permissions & Containerization_:

> "**Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.**
>
> If you need stronger boundaries, **containerize or sandbox Pi.**"

From the official [docs/security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md):

> "Treat model-generated commands and code as untrusted. **Pi can read, change, and execute files with the permissions of the account that started it, and it does not ask for approval before every tool call.**"
>
> "**Project trust controls which project resources load at startup, but it does not make that content or the resulting actions safe.**"
>
> "Safety comes from limiting the files, credentials, processes, and network services Pi can access… **Watching the transcript, using project trust, and reviewing changes do not create a security boundary.**"
>
> "**Project trust does not limit what tool calls can access or affect.** After Pi starts, enabled tools still use the operating-system permissions of the Pi process."

And from [docs/index.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md):

> "**Project trust controls which project resources Pi loads, but it does not sandbox tool calls.**"

**Security boundary statement (i):**

> "Expected local-agent behavior, prompt injection from untrusted content, **lack of a built-in sandbox**, and behavior from user-installed extensions or skills are **generally outside the security boundary** unless the report demonstrates a privilege-boundary bypass…"
> — [SECURITY.md](https://github.com/earendil-works/pi/blob/main/SECURITY.md) (linked from the security page)

### B.4.1 Project trust — the one thing `pi` does gate (i)

**Resources requiring a trust decision:** `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and project `.agents/skills`.

**Decision precedence:**

1. Command-line `--approve` / `--no-approve`.
2. User-level and command-line extensions handling the `project_trust` event — **"The first extension that returns yes or no owns the decision."**
3. A saved decision for the current directory or an ancestor; the closest applies. Stored in `~/.pi/agent/trust.json`.
4. Otherwise the `defaultProjectTrust` setting, **default `"ask"`**.

**Documented holes in the trust boundary (i):**

- "**Project trust is not a complete startup boundary.** Pi reads the project `sessionDir` setting while selecting or creating a session, **before it resolves project trust**… it cannot undo that initial session-directory lookup."
- "**Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` load regardless of project trust** unless you disable context loading."
- In print/JSON/RPC modes there is no prompt; `defaultProjectTrust: "always"` **loads** protected resources, `"ask"`/`"never"` **skip** them.

### B.4.2 The four officially documented isolation patterns (i)

From [docs/containerization.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md):

| Method             | Where Pi runs           | What is isolated                                 | Credential handling                                     |
| ------------------ | ----------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Plain Docker       | Container               | Pi, built-in tools, `!` commands, and extensions | Credentials passed into the container                   |
| Docker Sandboxes   | Managed sandbox         | Pi, built-in tools, `!` commands, and extensions | Provider credentials stay on host, substituted by proxy |
| OpenShell          | Local or remote sandbox | Pi, built-in tools, `!` commands, and extensions | Policy-controlled credentials and inference routing     |
| Gondolin extension | **Host**                | Built-in tools and `!` commands only             | Stored Pi credentials remain on host                    |

> "**The method changes where extensions run.** When the complete Pi process runs inside an isolated environment, its extensions run there too. When host Pi delegates built-in tools through Gondolin, **other extension tools still run on the host** unless they also delegate their work."

Documented exposure risks (i): "A read-write host mount lets Pi modify those host files. Mounting `~/.pi/agent` exposes your Pi credentials, settings, extensions, and sessions… **Tool-only isolation does not constrain the host Pi process or extension tools that do not use the isolated backend.**"

### B.4.3 Approval is opt-in via extension (i)

There is **no built-in approval gate**. The official docs give a _worked example_ of building one, using MCP annotations + a `tool_call` handler returning `{ block: true, reason }` — see §B.2.5 and [docs/extensions.md#tool-exposure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). (i)

### B.4.4 `codemode` is a QuickJS sandbox — a different kind (i)

"Codemode scripts run in a **QuickJS sandbox that can only reach the other tools, through `tools.<name>(args)`**" — [docs/cli.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md). This constrains the _script_'s reach, not Pi's OS access. (iii — the docs do not spell out the QuickJS boundary; this reading is inference from the quoted sentence.)

---

## B.5 DSH vs `pi` — direct contrasts (all rows cited above)

| Axis                  | DeepSeek Harness PTC (i)                                                                                                             | `pi` codemode (i)                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Program language      | **TypeScript**, erasable-only                                                                                                        | **JavaScript** in a QuickJS sandbox                                                            |
| Execution isolation   | Fresh **Node process** per call, under the session sandbox policy                                                                    | In-process **QuickJS** sandbox                                                                 |
| Cross-call state      | **"fresh per run"**; one-shot, no retained state                                                                                     | **`store()`/`load()`** persist per-branch across calls                                         |
| Single tool surface   | `run_code` only under `mode: ptc`                                                                                                    | `codemode` + a declarative **`tools` SDK**, budgeted at 3000 tokens                            |
| Default output budget | `maxOutputBytes` **64 MiB**                                                                                                          | `max_output_tokens` **10000** (start+end kept, rest to temp file)                              |
| Default timeout       | **120 s**, max **600 s**                                                                                                             | **unset by default** (`timeout_ms` opt-in, hard deadline)                                      |
| Nested-call records   | Recorded and **shown in UI** (`<parent>:ptc:<n>`)                                                                                    | **Not in transcript**; bounded 256-record `nestedCalls` audit trail                            |
| Host environment      | `process.env` replaced with **empty dict**                                                                                           | Not documented as empty                                                                        |
| Failure model         | 8-value **orthogonal** `kind` taxonomy                                                                                               | Result begins `Script completed`/`Script failed`; `Script error:` + partial output             |
| OS sandbox            | **Built in**, same policy as Bash                                                                                                    | **None**; user must containerize                                                               |
| Subagents             | Not stated in the PTC docs; DSH ships `subagent` / `spawn_teammate` tools, default depth **1**, max **8** live children (0.1.7-rc.1) | **Example extension only**, undocumented as a core feature; max **8** tasks / **4** concurrent |

---

# C. What is "present in source but undocumented"

| Item                                              | Where                                                                                                                                             | Status                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find`, `grep`, `ls`, `powershell` built-in tools | [src/core/tools/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools)                                            | (ii) Present in the tool registry; the documented/npm-described set is "read, bash, edit, write". No docs page enumerates the built-in tool list.       |
| `pi` subagents                                    | [examples/extensions/subagent/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)                | (ii) Ships with its own README, absent from all 38 documented pages and from `docs.json` nav                                                            |
| Built-in extension `llama`                        | [src/extensions/llama](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/extensions/llama)                                 | (ii) Referenced in the 0.99.0 changelog as `llama.cpp`, but has no docs page of its own                                                                 |
| DSH PTC Python backend                            | [packages/experimental/ptc-runtime-python/](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/ptc-runtime-python) | (ii) Ships and is documented _within_ the package README, but the 0.1.7 release notes state **"Python PTC is not supported"** for the workflow executor |
| DSH "Code mode" (the pre-0.1.2 name)              | —                                                                                                                                                 | Renamed; **no compatibility alias**, per the 0.1.7 notes ("without legacy aliases")                                                                     |

---

# D. Could not verify from a primary source

Everything in this section was actively looked for and **not found** or **not reachable**. Nothing here is filled in from memory or from secondary coverage.

## D.1 Domains that were unreachable from this environment (tooling limitation, NOT an absence of documentation)

- `https://deepseek-harness.github.io/` (the DSH published docs site) — **DNS blocked**. Citations above therefore point at the in-repo `docs/` files that generate it.
- `https://deepseek.com/harness` (DSH homepage) — **DNS blocked**.
- `https://pi.dev` and `https://pi.dev/docs/latest` (the pi published docs site) — **DNS blocked**. Citations point at the in-repo `packages/coding-agent/docs/` files.
- `github.com`, `raw.githubusercontent.com`, `api.github.com` via `web_fetch` — **DNS blocked**. Worked around with the authenticated `gh` CLI and `git clone`, both of which reached the same primary sources successfully.
- **Consequence:** I could not visually confirm that the rendered site pages match the in-repo markdown. The `docs.json` nav manifest (38 pages) and the `website/` build wiring are strong evidence, but the page-for-page rendering is (iii) inference.

## D.2 DSH — searched for and not found

- **Any PTC content in the user guide.** `git grep -i 'run_code|PTC' -- docs/user` -> **0 matches**. There is no official "how to use PTC" page for end users.
- **A `CHANGELOG.md` in the DSH repo.** Confirmed absent; release notes live only in GitHub Releases.
- **Any official PTC token-cost saving figure, benchmark, or guarantee.** Only the hedged statement that PTC "trades end-tool schemas for generated SDK text plus one transport schema rather than promising a universal reduction."
- **An explicit official definition of the acronym "PTC" outside the client UI string.** The expansion "Programmatic Tool Calling" appears in exactly one place in the whole repository (the client guide locale). The docs subsystem page never expands it.
- **Published DSH documentation for the client UI strings themselves.** The PTC preset guide text lives in TypeScript locale files, not in a `.md` doc. I could not find a docs page that presents it.
- **Whether the `ptc` preset's "workflow tool disabled" statement is a hard rule or a preset default.** The UI string says "The current PTC preset leaves the workflow tool disabled"; a separate note, [2026-09-01-ptc-omits-workflow-tool.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-09-01-ptc-omits-workflow-tool.md), exists but I did not read it in full.

## D.3 `pi` — searched for and not found

- **A subagent page in the official documentation.** 0 matches for `subagent` across all 38 pages in `packages/coding-agent/docs/`; no entry in `docs.json` navigation.
- **Subagent mentions in the README, the agent-loop page, or the extension page.** None.
- **An officially documented built-in tool list.** No docs page enumerates the built-in tools; the only enumeration is the npm package description ("read, bash, edit, write"). The fuller set (find, grep, ls, powershell) is (ii) from source.
- **An official statement of subagent depth or nesting limits.** The example README documents 8 tasks / 4 concurrent, but says nothing about **nesting depth** (can a subagent spawn a subagent?). The CHANGELOG references `nestedCalls` and `ctx.executeTool()` recursion at "every depth", which implies depth is unbounded but is not stated. **Unresolved.**
- **A QuickJS sandbox boundary specification for `codemode`.** The docs say "a QuickJS sandbox that can only reach the other tools" but do not specify the memory, CPU, wall-clock, or syscall limits, nor whether `fetch`/`WebAssembly`/`Atomics` are reachable. **Unresolved.**
- **The exact `codemode` tool `max_output_tokens` interaction with the `codemode-store` retention** — no documented cap on how much can be stored across calls.
- **Whether `pi`'s built-in `llama` extension (`llama.cpp`) is enabled by default** — the changelog says it can be disabled with `-builtin:llama.cpp`, implying it is on by default, but no docs page states the default. (iii)
- **The rendered content of `https://pi.dev/news/2026/5/7/pi-has-a-new-home`** — surfaced in search but `pi.dev` is DNS-blocked; not fetched, not used.

## D.4 Explicitly excluded

- **No secondhand coverage was used.** The InfoQ article (`infoq.cn`), the aihub.caict.ac.cn mirror, the MiniMax platform page, the pkg.go.dev nacelle doc, and all other secondary hits returned by search were **deliberately not read or cited**, per the primary-source-only constraint.
- **No claim in this document is sourced from memory.** Every factual statement maps to a URL in the Sources appendix, or is explicitly labelled (iii) inference.

---

# Sources

Every URL below was actually fetched or read during this research. GitHub file URLs use the repo's default branch (`master` for DSH, `main` for pi); `gh api` and `git clone` were used because `github.com` is DNS-blocked for `web_fetch`.

## DeepSeek Harness — repository and identity

- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
- https://github.com/deepseek-ai/deepseek-harness/releases
- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1
- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1
- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1
- https://github.com/deepseek-ai/deepseek-harness/commits/master
- https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json
- https://github.com/deepseek-ai/deepseek-harness/blob/master/website/build.ts
- https://github.com/deepseek-ai/deepseek-harness/tree/master/website/.vitepress
- GitHub API (read via authenticated `gh api repos/deepseek-ai/deepseek-harness` and `…/releases?per_page=100`)

## DeepSeek Harness — official PTC documentation

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ptc-runtime.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime-node/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ptc-runtime/ptc-runtime
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/ptc-runtime-python

## DeepSeek Harness — first-party design notes (internal, not end-user docs)

- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-ptc.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-09-01-ptc-omits-workflow-tool.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/bug-fix/2026-08-07-ptc-executor-collapse.md
- (file list only; several of the above were located but **not read in full** — cited for existence and date)

## DeepSeek Harness — client (VS Code-style extension + web GUI)

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/guide-locales.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/locales.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/src/client/PresetGuideDialog.tsx
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md (negative finding: no PTC)

## pi — repository, package and identity

- https://github.com/earendil-works/pi
- https://github.com/earendil-works/pi/blob/main/README.md
- https://github.com/earendil-works/pi/blob/main/LICENSE
- https://github.com/earendil-works/pi/blob/main/SECURITY.md
- https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md
- https://github.com/earendil-works/pi/blob/main/AGENTS.md
- https://github.com/earendil-works/pi/releases
- https://github.com/earendil-works/pi/releases/tag/v0.99.1
- https://github.com/earendil-works/pi/commits/main
- https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- https://registry.npmjs.org/@earendil-works/pi-coding-agent (read via `curl`)

## pi — official documentation (source of https://pi.dev/docs/latest)

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/docs.json
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md
- (full 38-page list enumerated from `docs/docs.json`; the pages above are those read in full)

## pi — subagents, changelog and source

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/extensions
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/nested-tool-calls.ts

## Attempted and unreachable (documented for completeness)

- https://deepseek-harness.github.io/deepseek-harness/ — DNS blocked
- https://deepseek.com/harness — DNS blocked
- https://pi.dev/ — DNS blocked
- https://pi.dev/docs/latest — DNS blocked
- https://pi.dev/docs/latest/extensions — DNS blocked
- https://pi.dev/news/2026/5/7/pi-has-a-new-home — DNS blocked
