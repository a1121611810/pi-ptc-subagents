# DSH PTC (Programmatic Tool Calling) — Ground Truth

**Scope.** The _original_ PTC implementation in DeepSeek Harness, read only from a local checkout of the upstream repository. No file under this repository was opened. Every claim below carries a `path:line` citation.

**How to read the citations in this file (read first).** Citations name paths inside the public
upstream repository, `deepseek-ai/deepseek-harness`, pinned to tag **`dsh-v0.2.0-rc.2`** — the
release these findings were read from (every `@deepseek-ai/dsh-*` manifest in that checkout
declares `0.2.0-rc.2`; an earlier draft of this file and `src/runtime/limits.ts` both named
`0.1.6-alpha.2`, which is a different release). A citation is `path:line` against the **TypeScript
source** under `packages/`, not against a build output.

Three citation shapes appear, and the difference is deliberate:

- **`packages/…/src/x.ts:NN`** — the claim was checked against a specific line of the source.
- **A bare `packages/…` path, no line** — the claim is about what a module _contains_ (its public
  surface, which modules it bundles), so the module is the citable unit. These were originally
  cited against a compiled bundle's barrel `export { … }` line or its `//#region` markers; those
  are build artifacts with no source counterpart, so naming the source module is the honest form.
- **`README.md:NN` / `package.json:NN`** — cited in the upstream source tree itself. Note the
  source manifests use pnpm's `workspace:` protocol where a published artifact carries a resolved
  version (e.g. `workspace:*` vs `0.2.0-rc.2`); the version values quoted below are the published
  ones, and the declaration site is what the citation points at.

Where a claim could not be checked against the source, it is stated as **not found in source**
rather than inferred from the build output.

A fourth form appears as `x.js:NN` without a directory: that is a line in the **published
build output** (`lib/*.js`) of the same `0.2.0-rc.2` release, not in the source. It is kept
verbatim rather than re-derived because the build's line numbering is not reproducible from
the source tree, and it stays checkable: the build is published as the npm package for that
same version. Where a claim was worth a source line, it got one — `path:line` in the form
above.

---

## 1. What PTC is, mechanically

### 1.1 One-sentence answer

A PTC program is **the body of an async function**, written by the model, that the harness executes in a **fresh child process** and hands **host-provided async bindings** to; inside the program the model calls tools as ordinary function calls instead of emitting native tool-call turns.

- The model-facing tool is literally named `run_code`; its `code` parameter is "the BODY of an async function (erasable syntax only; top-level `await` and `return` work)": `packages/core/tools/src/ptc.ts:30` (`export const RUN_CODE_NAME = 'run_code'`) and `packages/core/tools/src/ptc.ts:57`.
- The program is **not a file or a module**. The host wraps it in a synthetic async function wrapper and strips TypeScript types: `packages/ptc-runtime/ptc-runtime-node/src/index.ts:45` (`STRIP_PREFIX = "async function __dsh_program__() {\n"`, `STRIP_SUFFIX = "\n}"`) applied at `packages/ptc-runtime/ptc-runtime-node/src/index.ts:206` (`stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX)`), wrapper bytes removed again at `packages/ptc-runtime/ptc-runtime-node/src/index.ts` (`stripped.slice(35, stripped.length - 2)`).
- The child re-assembles it as a real **async function constructor** and invokes it with the binding namespaces and console shim as **parameters**: `packages/ptc-runtime/ptc-runtime-node/src/process.ts` (`new AsyncFunction(...globals, ...errorClassNames, "console", "'use strict';\n" + data.code)(...)`). Note the `'use strict'` prefix.

### 1.2 The seam

`PtcRuntime` is an abstract Cordis service registered as `ctx.ptcRuntime`:

- `packages/ptc-runtime/ptc-runtime/src/index.ts:130` — `var PtcRuntime = class extends Service { … constructor(ctx) { super(ctx, "ptcRuntime") } }`.
- Three readonly descriptors providers override: `executionInstructions` (default `""`, lines 149-151), `sandboxMode` (`undefined` when no confinement, line 153), `timeout` (`{defaultMs, maxMs}`, `undefined` when numeric overrides unsupported, line 155).
- The two provider methods — `resolve(request)` and `run(spec)` — are **not declared on the base class** (the compiled base body has only the three getters and the constructor). They are implemented at `packages/ptc-runtime/ptc-runtime-node/src/index.ts:116` and `:846-864`; the contract that they exist is prose only (`packages/ptc-runtime/ptc-runtime/README.md:32`, `:75`) plus JSDoc at `packages/ptc-runtime/ptc-runtime-node/src/index.ts:106`, `:841-845`.
- Vocabulary named by the README (`PtcRunRequest`, `PtcRunSpec`, `PtcBindingNamespace`, `PtcRunResult`, `PtcRunSandbox`): `packages/ptc-runtime/ptc-runtime/README.md:81`. The actual TS interfaces are **not found in source**; their observable shapes are reconstructed in §3/§4 from the implementation.

### 1.3 Where it executes

- **Separate process, one per run.** `language = "typescript"`, `isolation = "process"` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:65`).
- Launch: resolve the executable in the configured execution world (`index.js:941`), confine the argv through `ctx.sandbox` (`:950-953`), spawn through `ctx.subprocess` (`:961-973`) with `stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe", control: "pipe" }`.
- Required injected services: `["fs", "subprocess", "sandbox", "sandboxPolicy"]` (`index.js:765-770`).
- **One-shot, no state between runs**: `packages/ptc-runtime/ptc-runtime/README.md:128-129`. The provider tells the model "Each call runs in a fresh Node process" (`index.js:785`).
- Bootstrap selection (`index.js:349-366`): explicit `bootstrapPath`, a packaged `pkg` inline form, the sibling built `process.js`, or a source-mode `--input-type=module --eval` closure. Built child entry: `packages/ptc-runtime/ptc-runtime-node/src/process.ts`.

### 1.4 Entry point and the surface handed to the program

The program receives, as **async function parameters**:

| Parameter                                               | What it is                                                                 | Citation                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| one namespace object per declared binding               | null-prototype object; each declared name an own enumerable async function | `process.js:949-988`                                     |
| one error-class constructor per namespace declaring one | real subclass of `Error`                                                   | `process.js:891-899`, injected at `process.js:1013-1030` |
| `console`                                               | 5-method shim: `log`, `info`, `warn`, `error`, `debug`                     | `process.js:774-780`, `:790-797`, `:1030`                |

Plus **ambient Node authority inside the child** (fs, network, `process`, `child_process`, dynamic `import()`). The program is _not_ capability-restricted inside the child; only the OS file sandbox applies: "Direct filesystem, network and subprocess operations remain Node operations, subject to the selected OS sandbox" (`packages/ptc-runtime/ptc-runtime-node/README.md:64`).

---

## 2. The tool set the program receives

### 2.1 It is a registry view, not a fixed set

The binding map is built per call from **the calling agent's visible tool set**:

````js
// packages/core/tools/src/ptc.ts:691
const functions = Object.create(null);
for (const schema of registry.schemas(exec.agent)) {
  if (schema.name === RUN_CODE_NAME) continue;
  Object.defineProperty(functions, schema.name, {
    enumerable: true,
    value: binding(deepFreeze(schema)),
  });
}
``

- Exactly **one** binding namespace is declared, always named `tools`, with a fixed error class: `packages/core/tools/src/ptc.ts:702` — `bindings: [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]`.
- `run_code` is **excluded from its own binding set** (`ptc.js:577-578`).
- Scoped registrations, restrictions and per-agent visibility all flow through `view(scope)`: `packages/core/tools/src/index.ts:1211`.
- So: **registry-derived and per-agent**, not config-fixed.

### 2.2 Operation and parameter shape of each bound function

Each bound function takes **exactly one argument** (a single JSON object) and resolves to the tool's typed canonical JSON value:

- Child side `(args) => { snapshot args; postMessage({type:"call", id, global, name, args: wire}) }`: `packages/ptc-runtime/ptc-runtime-node/src/process.ts`.
- Host side dispatch: `packages/ptc-runtime/ptc-runtime-node/src/index.ts:313`.
- Failure → **promise rejection**. The program sees a `ToolCallError` whose `toolName` is the bound name and whose `message` is human-readable (`process.js:901-903`, `:966-969`; host turns `ok:false` into `entry.reject(new CapturedError(message.message))` at `process.js:932`). Model-facing prose: `packages/core/tools/src/ts-types.ts:257`.
- Arguments must be **lossless JSON**; a lossy argument rejects locally before posting (`process.js:958-962`), and the host independently re-validates (`index.js:1104-1108`).
- The **return value must also be lossless JSON**; `undefined` becomes a failure (`index.js:1117-1118`).

### 2.3 What the model is told the surface is

The model's declaration of the surface is a **generated TypeScript/Python SDK block** in the system prompt, not a JSON tool schema:

- `renderToolsSdk(schemas)` builds `ToolArgsMap`, `ToolOutputMap`, `ToolName`, a declared `ToolCallError`, and `declare const tools: { [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]> }`: `packages/core/tools/src/ts-types.ts:316`.
- Fixed usage prose: `SDK_INSTRUCTIONS` (`ts-types.js:222-224`), `SDK_PROGRAM_INSTRUCTIONS` (`ts-types.js:225-232`).
- A Python renderer exists in parallel (`packages/core/tools/src/py-types.ts`), keyed by the runtime's `language` (`ptc.js:46-49`, `:97-114`).
- Under `mode: 'ptc'` the model may name **only** `run_code`; native schemas are stripped and `knownNames` collapses to `["run_code"]` (`packages/core/tools/src/index.ts:1024`), enforced at the execution boundary by `collapses()` (`packages/core/tools/src/index.ts:1352`).
- Prompt section: `PTC_ONLY_INSTRUCTION = "`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program."` (`packages/core/tools/src/index.ts:59`), registered as section `tools:ptc-only` at `:281-286`.
- `run_code` is a **reserved name**: registration and restriction both reject it (`packages/core/tools/src/index.ts:1081`, `:503`).
- Presentation modes: `native | ptc | both`, default `native` (`packages/core/tools/src/index.ts`); per-scope override via `tools.presentAs(mode)` (`index.js:377-380`), implemented by `@deepseek-ai/dsh-agent-tool-presentation` (`packages/core/agent-tool-presentation/src/index.ts:70`).

---

## 3. The protocol / wire shape

### 3.1 Framing

**4-byte big-endian uint32 length prefix + UTF-8 JSON payload**, on a dedicated co-shipped pipe (`fd 7`), separate from stdout/stderr.

- Reader: `packages/ptc-runtime/ptc-runtime-node/src/index.ts` — 4-byte header (`this.header.readUInt32BE(0)`), then `parse(new TextDecoder("utf-8", { fatal: true }).decode(frame))`.
- Frame bound: `length === 0 || length > this.maxBytes` is a protocol failure (`index.js:265-266`).
- Writer: `index.js:290-320` — `header.writeUInt32BE(body.length)`, corked write, queued bytes bounded (`index.js:292-293`).
- The identical `JsonChannel` is compiled into both sides: host `index.js:217-338`, child `process.js:202-323`.

### 3.2 Handshake

1. Child → host `{ type: "ready" }` (`process.js:1111`).
2. Host → child `{ type: "boot", data }` (`index.js:1049-1051`).
3. Any other frame before readiness is a protocol failure ("program frame arrived before bootstrap readiness", `index.js:1043-1047`).
4. The child refuses anything that is not a `boot` frame first ("expected program boot frame", `process.js:1076-1084`).

### 3.3 The boot payload `data` (built at `index.js:932-940`)

```js
{
  code: string,                 // type-stripped program body
  namespaces: Array<{
    global: string,
    names: string[],            // Object.keys(binding.functions)
    errorClass?: { name: string, memberNameProperty: string }
  }>,
  maxOutputBytes: number
}
``

### 3.4 Complete message vocabulary (reconstructed from the code)

Child → host:

| Message                                          | Meaning                                          | Citation                                     |
| ------------------------------------------------ | ------------------------------------------------ | -------------------------------------------- |
| `{ type: "ready" }`                              | handshake                                        | `process.js:1111`                            |
| `{ type: "log", text: string }`                  | one captured log entry (host type-checks `text`) | `process.js:998-1002`, `index.js:1058-1064`  |
| `{ type: "output-limit" }`                       | the child's own ledger is exhausted              | `process.js:1003-1005`, `index.js:1065-1068` |
| `{ type: "call", id, global, name, args: Wire }` | binding invocation                               | `process.js:972-978`                         |
| `{ type: "done" }` (no `value`)                  | completion returned `undefined`                  | `process.js:842`                             |
| `{ type: "done", value: Wire }`                  | lossless-JSON completion                         | `process.js:851`, `index.js:1084`            |
| `{ type: "done", error: { kind, message } }`     | program failure                                  | `process.js:863-866`, `index.js:1070-1082`   |

Host → child:

| Message                                        | Meaning                          | Citation             |
| ---------------------------------------------- | -------------------------------- | -------------------- |
| `{ type: "boot", data }`                       | program + namespace declarations | `index.js:1049-1051` |
| `{ type: "reply", id, ok: true, value: Wire }` | binding success                  | `index.js:1119-1124` |
| `{ type: "reply", id, ok: false, message }`    | binding failure                  | `index.js:1126-1131` |

Host-side validation of every inbound frame (all are **protocol** failures): non-record frame (`index.js:1039-1042`); unknown `type` (`:1142`); `log.text` not a string (`:1059-1062`); terminal `error.kind` not in `exception | invalid-output | output-limit` (`:1071`); `call.id` must be a safe integer **and exactly `nextId++`** — calls are strictly sequential (`:1093-1097`); `(global, name)` must be a declared own property else "program requested an undeclared binding" (`:1098-1103`); `args` must decode as lossless JSON (`:1104-1108`); `pending > maxPendingCalls` or `pendingBytes > maxMessageBytes` (`:1109-1112`).

After the child posts its terminal frame it stops routing replies (`process.js:1085`) and `send()` becomes a no-op (`process.js:1097-1098`, `if (terminalSent) return;`).

### 3.5 The JSON wire encoding (depth-independent)

Values are not transported as nested JSON; they are flattened to a **pre-order token stream**:

- `encodePtcJsonWire` — `packages/ptc-runtime/ptc-runtime-node/src/index.ts:327`: scalars as themselves, arrays as `{ kind: "array", length }` + items, objects as `{ kind: "object", keys }` + values.
- `decodePtcJsonWire` — `index.js:675-751`, documented as "Malformed or incomplete traffic returns `undefined`; traversal is iterative and therefore independent of the transported value's application depth" (`index.js:668-674`).
- Rejections include sparse arrays, `undefined` properties, non-finite numbers, `-0`, symbol keys, duplicate object keys, extraneous marker fields (`index.js:603`, `:618`, `:708`, `:642-666`).
- The child snapshots before encoding (`process.js:845`, via `snapshotPtcJsonValue`).

### 3.6 dsh-hook-protocol / dsh-sdk-protocol

Neither participates in the PTC path. A grep for `ptc|run_code|programmatic` across `packages/hooks/hook-protocol/src/` and `packages/sdk/protocol/src/` returns **no matches**. They are hook matchers for two tool dialects (`packages/hooks/hook-protocol/src/index.ts:16`) and newline-delimited JSON-RPC 2.0 transport (`packages/sdk/protocol/src/index.ts:4`). **Not found in source:** any PTC-specific hook or SDK protocol.

---

## 4. The result the model sees

### 4.1 PtcRunResult (provider → consumer), built at `index.js:910-914`

```js
{
  logs: string[],                                   // always present
  value?: <lossless JSON>,                          // only when the program returned a value
  error?: { kind: string, message: string },        // only on failure
  sandbox: { mode, denied: boolean, enforcement?: 'full' | 'partial' }
}
``

- `sandbox` is **always attached by the Node provider**, independent of outcome (`index.js:911-914`), seeded `{ mode: policy.mode, denied: false }` (`:868-871`), with `enforcement` copied from the sandbox provider when confinement ran (`:955`).
- `sandbox` is **outside the output budget**: "fixed result-envelope fields and sandbox metadata are outside that ledger" (`packages/ptc-runtime/ptc-runtime-node/README.md:90`).
- Success shape: `{ logs, ...(value !== undefined ? { value } : {}) }` (`index.js:388-394`). Failure shape: `{ logs, error }` (`index.js:396-402`).

### 4.2 run_code output schema (`packages/core/tools/src/ptc.ts:364`)

```js
{
  type: 'object',
  additionalProperties: false,
  properties: {
    logs:    { type: 'array', required: true, items: { type: 'string' } },
    result:  { type: 'json' },
    sandbox: {
      type: 'object', additionalProperties: false,
      properties: {
        mode:        { type: 'string', required: true, enum: ['read-only','workspace-write','danger-full-access'] },
        denied:      { type: 'boolean', required: true },
        enforcement: { type: 'string', enum: ['full','partial'] }
      }
    }
  }
}
``

The value returned from `execute` is `{ logs, sandbox?, result? }` (`packages/core/tools/src/ptc.ts:725`) — the field is **renamed** `value` → `result` at this boundary.

### 4.3 Text rendering for the model (`packages/core/tools/src/ptc.ts:375`)

- `rendered = value.result === undefined ? '' : renderValue(value.result)`; a string result is emitted verbatim, anything else is pretty-printed as 2-space JSON with indentation capped at 10 characters total (`ptc.js:151-231`, `MAX_JSON_INDENT_CHARS = 10` at `ptc.js:158`).
- `parts = [logs.join('\n'), rendered].filter(nonEmpty)`.
- Appends `"File sandbox enforcement is partial on this host."` when `sandbox.enforcement === 'partial'`.
- Appends `"The ${sandbox.mode} file sandbox denied an operation."` + escalation guidance when `sandbox.denied`.
- If nothing at all: the literal `'(run_code completed with no output)'`.

**So the model sees one flat text block, not a tree.** There is no structured PTC result tree in the tools path. (The workflow PTC path _does_ carry a structured result — see §5.3.)

### 4.4 Failure text given to the model (`packages/core/tools/src/ptc.ts:720`)

``
code run failed (${result.error.kind}): ${result.error.message}
Captured output:
<logs joined by newline>                        # only when logs.length > 0
File sandbox: <mode>; enforcement: <x>; operation denied.   # only when sandbox !== undefined
<escalation guidance>                            # only when sandbox.denied
``

thrown as `CodeRunFailedError extends HarnessError` with `code: 'CODE_RUN_FAILED'` (`packages/core/tools/src/ptc.ts:174`), which the registry pipeline renders as a structured `isError` tool result.

---

## 5. Nesting and sub-calls

### 5.1 Tool sub-calls from inside the program

A **single ordered scheduler lane** in the host (not the child):

- The driver loop: `packages/core/tools/src/ptc.ts:473`. Each pass (a) commits the head-of-line settled dispatch in submission order, (b) starts the next queued entry when a slot is free, (c) otherwise sleeps on a wakeup promise. Quiescence = pending queue, commit queue and in-flight pool all empty.
- Reclassification happens **at start time** against the same agent view the SDK declared, fail-closed (`ptc.js:377`, `:491`).
- Ordering: post-execute commits strictly ordered; an `exclusive` dispatch blocks all later starts until its full pipeline completes (`ptc.js:363-366`).
- Every sub-dispatch is logged for reconstruction: `tool/ptc-dispatch-start` before start (`ptc.js:496-502`) and `tool/ptc-dispatch` on settle (`ptc.js:470-482`). Payload types: `PtcDispatchStartEventData { rootCallId, parentCallId, subCallId, name, arguments }` and `PtcDispatchEventData extends PtcDispatchStartEventData { isError, content, error? }` (declarations quoted at ``packages/interaction/permission-presets/src/.ts`typert.host.js:423` and `:427`; event name registered at `packages/core/session/src/known-event-types.ts:74`).
- Sub-call identity: `subCallId = brandString(`${exec.callId}:ptc:${n}`)` with `n` a per-run counter (`ptc.js:431`).
- The extension hook `tools/ptc-dispatch-log` is a waterfall that may replace only the **durable log copy** of a settled sub-result (`packages/core/tools/src/index.ts:1330`; catalogued at `packages/extensions/tool-cordis/src/api-catalog.ts:4317`).

### 5.2 Can a PTC program call another PTC program?

**No.** `run_code` is explicitly skipped when building the binding set (`packages/core/tools/src/ptc.ts:690`), so a program cannot reach `run_code` even under `mode: 'both'`. There is **no depth counter and no depth limit anywhere** — grepping `depth` across ``packages/core/tools/src/.ts`types/` finds only JSON-renderer indentation (`ptc.js:162-217`) and Python-SDK type-nesting caps (`py-types.js:261-325`). Nesting is prevented **structurally (absence of the binding)**, not by a counter.

### 5.3 The second PTC consumer: dsh-workflow-ptc

Workflow orchestration is also a PTC program, with a different, **fixed** binding shape:

- One namespace named `workflowHost`, functions `begin`, `startChild`, `childResult`, `disposeChild`, `progress`: `packages/workflow/workflow-ptc/src/index.ts`, requested at `:417-427`.
- The program text is a fixed string importing a generated ESM guest from a `data:text/javascript` URL: `packages/workflow/workflow-ptc/src/index.ts`.
- The engine hard-requires a TypeScript PTC runtime: `if (ctx.ptcRuntime.language !== "typescript") throw new Error("workflow-ptc requires the Node TypeScript PTC runtime")` (`packages/workflow/workflow-ptc/src/index.ts:117`).
- It requests `timeoutMs: null` — **no elapsed deadline** for workflows (`packages/workflow/workflow-ptc/src/index.ts`).
- The workflow's _user-facing_ tool is `workflow` from `dsh-tool-workflow`, whose output is `oneOf` a foreground shape `{ kind: "foreground", runId, agentsStarted, result }` and a background shape `{ kind: "background", jobId, runId }` (`packages/workflow/tool-workflow/src/index.ts:380`), config `toolName: 'workflow'`, `maxResultChars: 50000`, `enableRunInBackground: true` (`packages/workflow/tool-workflow/src/index.ts:62`).
- Subagent children are the workflow's nesting: `agent()` starts a child through `ctx.subagents` (`packages/workflow/workflow-ptc/src/index.ts`); `parallel()`/`pipeline()` fan out (guest implementations inside the embedded guest source at `packages/workflow/workflow-ptc/src/index.ts`).

---

## 6. Limits and their literal default values

### 6.1 Node PTC provider config — `packages/ptc-runtime/ptc-runtime-node/src/index.ts:58`

| Key                      | Default (literal in code)                  | Meaning                                              |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| `timeoutMs`              | `12e4` = **120000**                        | default elapsed deadline                             |
| `maxTimeoutMs`           | `6e5` = **600000**                         | ceiling applied by the resolver                      |
| `maxOutputBytes`         | `67108864` = **64 MiB**                    | combined serialized logs + completion/diagnostic     |
| `maxOldGenerationSizeMb` | `512`                                      | V8 old-gen heap limit                                |
| `maxMessageBytes`        | `134217728` = **128 MiB**                  | control frame + queued-write + outstanding-arg limit |
| `maxPendingCalls`        | `128`                                      | max simultaneous host binding calls                  |
| `graceMs`                | `3e3` = **3000**                           | managed termination / output-drain grace             |
| `nodeExecutable`         | `process.execPath` (set at `index.js:794`) | executable resolved in the exec world                |
| `bootstrapPath`          | `undefined`                                | optional absolute preinstalled built bootstrap       |

Constructor-time validation (`index.js:796-807`): every numeric field must be positive and finite; `timeoutMs|maxTimeoutMs|graceMs` must not exceed `MAX_TIMER_DELAY_MS = 2147483647` (`packages/util/timeout/src/index.ts`, applied at `index.js:797-801`); `maxOutputBytes` must be a safe integer `>= 4`; `maxMessageBytes` must fit an unsigned 32-bit frame length (`<= 4294967295`); `maxPendingCalls`/`maxOldGenerationSizeMb` must be safe integers; `bootstrapPath` must be absolute.

### 6.2 Derived and effective limits

- `timeout` descriptor: `{ defaultMs: min(timeoutMs, maxTimeoutMs), maxMs: maxTimeoutMs }` (`index.js:818-823`) — if `timeoutMs > maxTimeoutMs` the reported default equals the cap.
- `resolve()` clamps with `clampTimeout(requested, def, max) = Math.min(requested ?? def, max)` (`index.js:837`; implementation `packages/util/timeout/src/index.ts:54`). **`timeoutMs: null` means "no elapsed deadline"** and passes through unchanged (`index.js:837`).
- `run()` re-validates: non-null `timeoutMs` must be finite, `> 0`, `<= maxTimeoutMs` (`index.js:849`).
- `sandboxMode` = `ctx.sandboxPolicy.defaultMode` (`index.js:815-817`).
- Default `cwd` = `sandboxPolicy.workspaceRoot`, and must be absolute (`index.js:832-833`).

### 6.3 Tools-level limit

- `maxParallelSubCalls`: `z.natural().min(1).default(10)` (`packages/core/tools/src/index.ts:812`), re-validated in `resolveMaxParallelSubCalls` with a hardcoded `?? 10` (`index.js:207-213`), passed to the transport as `maxParallel` (`index.js:361`). This is the number of `run_code` sub-tool calls that may be **in flight at once**; the same cap back-pressures the async log-append pool (`packages/core/tools/src/ptc.ts:660`).
- Concurrency classification is fail-closed: only an exact `true` from `isConcurrencySafe` is `parallel`; unknown/hidden/undeclared/invalid/throwing ⇒ `exclusive` (`packages/core/tools/src/index.ts:1304`).

### 6.4 Workflow PTC engine config — `packages/workflow/workflow-ptc/src/index.ts:109`

| Key                   | Default   | Notes                                                                    |
| --------------------- | --------- | ------------------------------------------------------------------------ |
| `provider`            | `'spawn'` | host-side subagent provider                                              |
| `maxConcurrentAgents` | `0`       | `0` resolves to `min(16, max(1, availableParallelism() - 2))` (line 619) |
| `maxTotalAgents`      | `1000`    | hard ceiling for one run (line 588)                                      |
| `maxItemsPerCall`     | `4096`    | `parallel()`/`pipeline()` item cap (line 589)                            |
| `syncTimeoutMs`       | `5000`    | VM timeout for the script's **initial synchronous slice** (line 590)     |

Cross-limit: the Node provider's `maxPendingCalls` also throttles workflow concurrency (`packages/workflow/workflow-ptc/README.md:49`).

### 6.5 Truncation and output bounding

- The **outer output ledger** is seeded at `bytes = 2` (the JSON `[]`) and charges each log entry its exact serialized JSON-string bytes plus a 1-byte separator (`packages/ptc-runtime/ptc-runtime-node/src/index.ts`).
- Byte measurement is code-point aligned and short-circuits the moment the cap is crossed (`index.js:102-112` `jsonStringBytesUpTo`, `index.js:119-193` `jsonValueBytesUpTo`), so a pathological value cannot force materialization.
- On overflow the provider **retains a fitting prefix of the final log** and returns an explicit `output-limit` failure (`index.js:404-436`) with message `outer output exceeded ${maxOutputBytes} bytes` (`index.js:405`).
- The child has its **own** `LogBuffer` over the same `maxOutputBytes` (`packages/ptc-runtime/ptc-runtime-node/src/process.ts`); once exhausted it emits the fitting prefix then one `{ type: "output-limit" }` frame (`process.js:750-762`).
- `util.inspect` inside the console shim is bounded: `{ depth: 4, maxArrayLength: 100, maxStringLength: 1e4 }` (`packages/ptc-runtime/ptc-runtime-node/src/process.ts`).
- `stderr` capture is tail-bounded to `maxOutputBytes` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:262`).

---

## 7. Isolation model

### 7.1 What actually isolates the program

Four independent mechanisms, in the order the host applies them:

**(a) Process separation (the primary boundary).** One fresh managed child per run (`index.js:961-973`). The child is an untrusted peer: the host re-validates every frame it emits (`index.js:1038-1156`) even when frames look well-formed.

**(b) OS file confinement via ctx.sandbox**

```js
// packages/ptc-runtime/ptc-runtime-node/src/index.ts:224
confined =
  policy.mode === "danger-full-access"
    ? void 0
    : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal);
``

`SandboxProvider` is a **fail-closed** seam: "must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden" (`packages/sandbox/sandbox/src/index.ts:155`). Missing backend ⇒ `SandboxUnavailableError` with code `SANDBOX_UNAVAILABLE` (`packages/sandbox/sandbox/src/index.ts:128`), mapped by the PTC provider to `sandbox-unavailable` (`index.js:1170`). Modes: `read-only | workspace-write | danger-full-access` (`packages/sandbox/sandbox/src/index.ts:13`).

**(c) Environment scrubbing — two stages.**

_Host side_: the child is launched with an env whose keys are **preserved with value `undefined`** except the startup allow-list and `ELECTRON_RUN_AS_NODE`:

```js
// packages/ptc-runtime/ptc-runtime-node/src/index.ts:230
const env = Object.fromEntries(
  Object.keys(process.env)
    .filter(
      (key) =>
        !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) &&
        key.toUpperCase() !== "ELECTRON_RUN_AS_NODE",
    )
    .map((key) => [key, void 0]),
);
``

_Child side_, after the control channel is adopted and **before** the program is evaluated:

```js
// packages/ptc-runtime/ptc-runtime-node/src/process.ts:27
for (const key of Object.keys(processState.env))
  if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()))
    Reflect.deleteProperty(processState.env, key);
processState.env = Object.create(null);
``

`STARTUP_ENVIRONMENT_NAMES = { PATH, PATHEXT, SYSTEMROOT, WINDIR, TEMP, TMP }` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts` and identically `packages/ptc-runtime/ptc-runtime-node/src/process.ts`). The model is told "process.env starts empty" (`index.js:785`, `packages/workflow/workflow-ptc/README.md:59`). The private launch marker `DSH_SUBPROCESS_CONTROL` is deleted on consumption (`packages/ptc-runtime/ptc-runtime-node/src/process.ts:27`); the pipe is opened at **fd 7** (`process.js:17-22`, `packages/subprocess/subprocess/src/control.ts:17`).

**(d) Resource limits.** V8 heap cap via `--max-old-space-size=${maxOldGenerationSizeMb}` (`index.js:944`, applied as argv at `:947` or as `NODE_OPTIONS` for packaged executables at `:957-960`); elapsed deadline (`index.js:883-886`); output/control byte caps (§6); pending-call cap (`index.js:1109`); managed-process termination with a drain grace (`index.js:893-909`).

### 7.2 What is NOT isolated (explicitly)

- **No capability restriction on Node APIs inside the child** — fs, net, child_process all work; only the OS file sandbox applies (`packages/ptc-runtime/ptc-runtime-node/README.md:64`; the `executionInstructions` handed to the model say exactly this, `index.js:785`).
- **Network is not restricted by the file policy** (`packages/workflow/workflow-ptc/README.md:59`).
- **The heap cap is not a process-tree memory limit** and there is no CPU meter (`packages/ptc-runtime/ptc-runtime-node/README.md:140`).
- **Escapees may survive cleanup** on fallback platforms (`README.md:141`).
- **Bindings are unbounded at transport admission** — "control limits do not bound the memory a host binding allocates while producing its result" (`README.md:144`).
- The seam disclaims security: `language`/`isolation` "are diagnostic descriptors; neither grants authority or proves confinement" (`packages/ptc-runtime/ptc-runtime/README.md:45`).

### 7.3 Prototype-pollution hardening (notable)

Both sides capture Node intrinsics at module load and use them so model-mutated prototypes are never consulted: `intrinsicObjectCreate`, `intrinsicObjectDefineProperty`, `intrinsicReflectApply`, `intrinsicArrayIsArray`, captured `String.prototype.*`, `Set.prototype.*` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts`, `:492-512`). The child's module bootstrap is **dependency-free** ("Lossless-JSON snapshots for the dependency-free source bootstrap closure", `index.js:488-490`). Binding namespaces are `Object.create(null)` (`process.js:952`) and functions are installed with `Object.defineProperty` so a tool named `__proto__` becomes an ordinary own key (`process.js:953-955`; same rationale host-side at `packages/core/tools/src/ptc.ts:679`).

---

## 8. Error and failure semantics

### 8.1 The exact failure-kind vocabulary

| Kind                  | Raised when                                                                                                | Citation                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `exception`           | program parse error or thrown value                                                                        | `index.js:1170` (`parsing ? "exception"`), `process.js:884`                            |
| `timeout`             | the elapsed deadline fired                                                                                 | `index.js:917-920`                                                                     |
| `abort`               | caller cancellation                                                                                        | `index.js:921-924`                                                                     |
| `worker-exit`         | early process exit, stdout/stderr not closing cleanly, failed managed cleanup, control-channel I/O failure | `index.js:897-900`, `:902-905`, `:1034-1036`, `:1146-1149`, `:1151-1154`, `:1162-1166` |
| `invalid-output`      | completion value is not lossless JSON                                                                      | `process.js:849`, `index.js:1085-1088`                                                 |
| `output-limit`        | the combined outer budget is exceeded                                                                      | `process.js:854-859`, `index.js:981-984`, `:432`                                       |
| `protocol`            | malformed or excessive control traffic                                                                     | `index.js:1022-1027` and every `protocolFailure(...)` call                             |
| `sandbox-unavailable` | confinement backend unusable, or the confined runner failed to start                                       | `index.js:1030-1032`, `:1164`, `:1170`                                                 |

Only `exception | invalid-output | output-limit` may arrive **from the child** in a `done` frame (`index.js:1071`); the other five are host-only decisions.

### 8.2 Reject vs. resolve discipline

- **Program outcomes always resolve.** Only _caller misuse_ rejects: `resolve()`/`run()` after disposal, a missing resolved policy, a non-absolute `cwd`, an out-of-range `timeoutMs` (`index.js:830`, `:847-849`), and bad binding names in `validateBindings` (`index.js:21-34`). Contract: `packages/ptc-runtime/ptc-runtime/README.md:53` and `packages/ptc-runtime/ptc-runtime/src/index.ts:99`.
- **The model always sees the failure.** A failed run becomes `CodeRunFailedError` whose message carries kind, message, captured logs and sandbox facts (`packages/core/tools/src/ptc.ts:720`); JSDoc: "so the model can self-correct" (`ptc.js:118-121`).
- **No silent failure anywhere in the dispatch lane.** `shapeDispatchLog` warns and falls back to the original content when a listener throws (`packages/core/tools/src/index.ts:1330`); child disposal failure warns (`packages/workflow/workflow-ptc/src/index.ts`); the `logWork` pool is drained at run settlement so no settle event is lost (`packages/core/tools/src/ptc.ts:525`).
- **Post-settlement discard rule:** if a binding resolves after the run is over the program gets an error, not a stale value — "run_code run is over (${reason}); ${name} result discarded" (`packages/core/tools/src/ptc.ts:670`); queued-but-unstarted calls are _abandoned_ and reject with "… tool call abandoned" (`ptc.js:371-375`, `:492-494`).
- **Terminal-frame irreversibility:** the child ignores every control frame after posting `done` (`process.js:1085`, `:1097-1098`).
- **Workflows are noisier still:** hook misuse throws a fatal `WorkflowError` that kills the whole script rather than dissolving into a per-item `null`; only child-run failures and ordinary in-stage errors map to `null` (`packages/workflow/workflow/src/index.ts:131`; guest `parallel`/`pipeline` in the embedded source at `packages/workflow/workflow-ptc/src/index.ts`). Observed `WorkflowError` codes in compiled code: `SCRIPT_PARSE`, `META_INVALID`, `INVALID_ARGUMENT`, `UNSUPPORTED_OPTION`, `UNSUPPORTED_SCHEMA`, `AGENT_CAP`, `ITEM_CAP`, `AGENT_START`, `AGENT_RESULT`, `RESULT_UNSERIALIZABLE` (e.g. `packages/workflow/workflow-ptc/src/index.ts:55`, `:532`, `:570`, `:563`, guest at `:12`). The authoritative `WorkflowErrorCode` union is **not found in source** (types erased).

### 8.3 Sandbox-denial detection

`sandbox.denied` is computed by case-insensitive substring matching of the failure message against the sandbox provider's `denialSignatures`:

```js
// packages/ptc-runtime/ptc-runtime-node/src/index.ts:300
sandbox.denied = confined.denialSignatures.some((s) =>
  failure.message.toLowerCase().includes(s.toLowerCase()),
);
``

---

## 9. Images / attachments / binary results in the PTC path

**The PTC transport is text-and-JSON only.** The completion value must be lossless JSON (`process.js:841-852`) and a lossy one is `invalid-output`; the wire format cannot carry bytes (`index.js:588-623`). Binding arguments and results are subject to the same rule in both directions (`process.js:958-962`, `index.js:1117-1118`).

Images reach the model by exactly one route — a **deferred context message**, not a return value:

```js
// packages/core/tools/src/ptc.ts:640
if (!result.isError && result.content.some((block) => block.type === "image")) {
  exec.deferContext(
    createUserMessage({
      content: result.content,
      source: { kind: "ptc-mode" },
    }),
  );
}
``

- Only **successful** results with an image block are attached; failures never attach.
- `'ptc-mode'` is a first-class message-source kind: `'ptc-mode': { kind: 'ptc-mode' }` inside the `MessageSourceMap` declaration quoted at ``packages/subagent/subagent/src/.ts`typert.host.js:547`.
- The model is told this in the SDK prose: "A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need." (`packages/core/tools/src/ts-types.ts:259`); the `run_code` description repeats it (`packages/core/tools/src/ptc.ts:59`).
- The same `source: { kind: 'ptc-mode' }` channel is reused by the spill policy to return oversized text previews as extra context (`packages/spill/spill-policy/src/index.ts:144`, `:248`).
- **No attachment/binary path exists inside the PTC runtime contract.** `dsh-attachment` / `dsh-attachment-local` are unrelated (no PTC references).

---

## 10. Version / identity facts

| Fact                                        | Value                                                                                                  | Citation                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `@deepseek-ai/dsh-ptc-runtime` version      | `0.2.0-rc.2`                                                                                           | `packages/ptc-runtime/ptc-runtime/package.json:4``          |
| … repository                                | `git+https://github.com/deepseek-ai/deepseek-harness.git`                                              | `packages/ptc-runtime/ptc-runtime/package.json:8``          |
| … subdirectory                              | `packages/ptc-runtime/ptc-runtime`                                                                     | `packages/ptc-runtime/ptc-runtime/package.json:10``         |
| … description                               | "Abstract PTC execution seam (ctx.ptcRuntime) for the DeepSeek Harness"                                | `:3`                                                   |
| … peer deps                                 | `@deepseek-ai/cordis ~4.0.4`, `@deepseek-ai/dsh-sandbox 0.2.0-rc.2`                                    | `:24-27`                                               |
| `@deepseek-ai/dsh-ptc-runtime-node` version | `0.2.0-rc.2`                                                                                           | `packages/ptc-runtime/ptc-runtime-node/package.json:4``     |
| … subdirectory                              | `packages/ptc-runtime/ptc-runtime-node`                                                                | `packages/ptc-runtime/ptc-runtime-node/package.json:10``    |
| … description                               | "Sandboxed Node process implementation of the DeepSeek Harness PTC execution capability"               | `:3`                                                   |
| … subpath export                            | `./process` → `./lib/process.js` (types `./lib/types/process-entry.d.ts`)                              | `packages/ptc-runtime/ptc-runtime-node/package.json:16-20`` |
| … runtime deps                              | `@deepseek-ai/dsh-util-values`, `@deepseek-ai/schemastery ~3.18.4`                                     | `:34-37`                                               |
| `@deepseek-ai/dsh-workflow-ptc` version     | `0.2.0-rc.2`                                                                                           | `packages/workflow/workflow-ptc/package.json:4``         |
| … subdirectory                              | `packages/workflow/workflow-ptc`                                                                       | `packages/workflow/workflow-ptc/package.json:10``        |
| `@deepseek-ai/dsh-tools` version            | `0.2.0-rc.2`, dir `packages/core/tools`                                                                | `packages/core/tools/package.json:4``, `:10`         |
| `@deepseek-ai/dsh-tool-workflow` version    | `0.2.0-rc.2`, dir `packages/workflow/tool-workflow`                                                    | `packages/workflow/tool-workflow/package.json:4``, `:10` |
| License                                     | MIT across all three                                                                                   | each `package.json`                                    |
| Seam exports                                | `DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, PtcRuntime, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS` | `packages/ptc-runtime/ptc-runtime/src/index.ts:42`        |
| Node provider exports                       | `NodePtcRuntime` (named + default)                                                                     | `packages/ptc-runtime/ptc-runtime-node/src/index.ts`  |
| workflow-ptc exports                        | `MaterializeError, PtcWorkflowEngine (default), materializeFromRealm, validateMeta`                    | `packages/workflow/workflow-ptc/src/index.ts:21`       |

**Mentioned in READMEs but NOT part of the published set:** `dsh-experimental-ptc-runtime-python`, the private CPython provider (referenced at `packages/ptc-runtime/ptc-runtime/README.md:45` and `packages/workflow/workflow-ptc/README.md:28`). `ls packages | grep ptc` yields only the two `ptc-runtime` entries above, plus `packages/experimental/ptc-runtime-python` — which is a separate, unpublished package (see below). Its fd-3 protocol and behaviour are **not found in source**. Its existence is nonetheless load-bearing: `PORTABLE_RESERVED_WORDS` is the ECMAScript ∪ Python union precisely so one binding list is valid on both (`packages/ptc-runtime/ptc-runtime/src/index.ts:72`), and `RESERVED_BINDING_GLOBALS` includes `__dsh_main__`/`__builtins__`/`__name__`/`__debug__` for the same reason (`packages/ptc-runtime/ptc-runtime/src/index.ts:28`).

---

## Appendix A — Portable-identifier exclusion sets (exact)

From `packages/ptc-runtime/ptc-runtime/src/index.ts`:

- `RESERVED_BINDING_GLOBALS` (5; lines 27-33): `console`, `__dsh_main__`, `__builtins__`, `__name__`, `__debug__`.
- `RESERVED_ERROR_MEMBERS` (6; lines 44-51): `name`, `message`, `stack`, `args`, `with_traceback`, `add_note`.
- `DUNDER_MEMBER = /^__.+__$/` (line 56) — any `__x__` form is refused as an error member.
- `PORTABLE_RESERVED_WORDS` (**71 entries**, lines 67-139) — the ECMAScript ∪ Python reserved-word union, including `_` (line 138).
- Identifier regex enforced host-side: `/^[A-Za-z_][A-Za-z0-9_]*$/` (no `$`) (`packages/ptc-runtime/ptc-runtime-node/src/index.ts`).

Rejection messages, verbatim: "binding global <name> is not a usable identifier", "reserved binding global <name>", "duplicate binding global <name>", "binding error class <name> is not a usable identifier", "duplicate injected global <name>", "binding error member property <name> is not usable" (`packages/ptc-runtime/ptc-runtime-node/src/index.ts`).

## Appendix B — The complete run_code input schema

Required: `code` (string), `description` (string, non-empty after `trim()` — enforced at `packages/core/tools/src/ptc.ts:381`).
Optional controls, present only when the mounted runtime supports them (`packages/core/tools/src/ptc.ts:120`):

- `timeoutMs`: number — "Positive elapsed-time budget in milliseconds, **including nested tool and approval waits**. Default ${defaultMs}; capped at ${maxMs}. **Zero does not disable the deadline.**" Validated to be a positive finite number (`ptc.js:300-302`).
- `sandbox_permissions`: string enum `["workspace-write", "danger-full-access"]` (`ESCALATION_TARGETS`, `packages/sandbox/sandbox/src/index.ts:13`).
- `justification`: string; `sandbox_permissions` and `justification` must travel **together**, and the justification must be a non-empty sentence (`packages/sandbox/sandbox/src/index.ts:19`, called at `ptc.js:296`). Escalation goes through a user approval prompt **before anything executes** (`packages/core/tools/src/ptc.ts:393`) and must be _strictly wider_ than the standing mode (`packages/sandbox/sandbox/src/index.ts`).

## Appendix C — Explicitly "not found in source"

- All `*.d.ts` type declarations (0 files in the extraction).
- The authoritative `WorkflowErrorCode` union (only the codes actually thrown in compiled code were observable).
- The `dsh-experimental-ptc-runtime-python` provider and its fd-3 protocol.
- Any `PtcRunRequest`/`PtcRunSpec`/`PtcBindingNamespace`/`PtcRunResult`/`PtcRunSandbox` interface text — only README vocabulary plus runtime-constructed shapes are available.
- `dsh-util-values` (`snapshotJsonValue`, `deepFreeze`, `brandString`, `assertNever`) is imported by the PTC packages but its package is not in the extraction. Its logic does appear inlined inside the guest blob at `packages/workflow/workflow-ptc/src/index.ts` as `walkJsonValue`.
- Any PTC-related content in `dsh-hook-protocol` / `dsh-sdk-protocol`.

---

## Sources — every file actually read

All paths below are inside `deepseek-ai/deepseek-harness` at tag **`dsh-v0.2.0-rc.2`**, and the
line ranges are the ones the original pass read in that release's **published build output**
(`lib/*.js`). Each is given here as its source module: the build's own `lib/` layout and its
`//#region` bundling do not exist in the source tree, so a `lib/index.js:755` style range is
cited throughout this file as the source module it was built from.

**PTC packages**

- `packages/ptc-runtime/ptc-runtime/package.json`
- `packages/ptc-runtime/ptc-runtime/README.md`
- `packages/ptc-runtime/ptc-runtime/src/.ts`index.js (full, 161 lines)
- `packages/ptc-runtime/ptc-runtime-node/package.json`
- `packages/ptc-runtime/ptc-runtime-node/README.md`
- `packages/ptc-runtime/ptc-runtime-node/src/.ts`index.js (full, 1178 lines)
- `packages/ptc-runtime/ptc-runtime-node/src/.ts`process.js (full, 1136 lines)
- `packages/workflow/workflow-ptc/package.json`
- `packages/workflow/workflow-ptc/README.md`
- `packages/workflow/workflow-ptc/src/.ts`index.js (full, 658 lines)

**Tools / registry**

- `packages/core/tools/package.json`
- `packages/core/tools/src/.ts`types/ptc.js (full, 658 lines)
- `packages/core/tools/src/.ts`types/ts-types.js (full, 290 lines)
- `packages/core/tools/src/.ts`types/index.js (lines 200-260, 340-460, 560-800, plus greps)
- `packages/core/tools/src/.ts`index.js (grep for ptc; confirmed to be the bundle of the above)

**Workflow**

- `packages/workflow/workflow/README.md`
- `packages/workflow/workflow/src/.ts`types/index.js (full, 79 lines)
- `packages/workflow/workflow/src/.ts`types/runtime-types.js (full — empty type module)
- `packages/workflow/workflow/src/.ts`types/types.js (full)
- `packages/workflow/tool-workflow/package.json`
- `packages/workflow/tool-workflow/src/.ts`index.js (full, 437 lines)

**Supporting**

- `packages/sandbox/sandbox/src/.ts`index.js (lines 11-60, 250-290)
- `packages/util/timeout/src/.ts`index.js (lines 27-63 + export list)
- `packages/subprocess/subprocess/src/.ts`control.js (lines 1-25)
- `packages/subprocess/subprocess/src/.ts`index.js (grep)
- `packages/sandbox/sandbox-policy/src/.ts`index.js (grep: defaultMode, workspaceRoot, resolve)
- `packages/hooks/hook-protocol/src/.ts`index.js (head; confirmed no PTC content)
- `packages/sdk/protocol/src/.ts`index.js (head; confirmed no PTC content)
- `packages/core/agent-tool-presentation/src/.ts`index.js (grep: PTC-aware presentAs)
- `packages/extensions/tool-cordis/src/.ts`types/api-catalog.js (grep: tools/ptc-dispatch-log)
- `packages/spill/spill-policy/src/.ts`types/index.js (grep: ptc-mode context source)
- `packages/interaction/permission-presets/src/.ts`typert.host.js (lines 423-427: PtcDispatchEventData / PtcDispatchStartEventData)
- `packages/subagent/subagent/src/.ts`typert.host.js (line 547: MessageSourceMap including ptc-mode)
- `packages/core/session/src/.ts`types/known-event-types.js (grep: tool/ptc-dispatch)
- Directory listing of the upstream `packages/` tree, and a search for `*.d.ts` / `typert_*` / `types` directories
````
