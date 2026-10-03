# DSH Ground Truth — Sandboxing, Isolation & Human Approval

**Scope:** original ground truth for DSH's isolation and human-approval axis, read from the public
upstream `deepseek-ai/deepseek-harness` at tag `dsh-v0.2.0-rc.2`. Every claim cites `path:line`.
Absent behaviour is stated as **not found in source**.
A fourth form appears as `x.js:NN` without a directory: that is a line in the **published
build output** (`lib/*.js`) of the same `0.2.0-rc.2` release, not in the source. It is kept
verbatim rather than re-derived because the build's line numbering is not reproducible from
the source tree, and it stays checkable: the build is published as the npm package for that
same version. Where a claim was worth a source line, it got one — `path:line` in the form
above.

---

## 0. TL;DR — the single most important architectural fact

**DSH's isolation is a _file-effect_ policy only, and it is enforced by two _different_ mechanisms depending on whether the effect arrives through a process or through a tool call.** A shell command is confined by a real OS kernel primitive (Seatbelt / bubblewrap / Landlock / Windows restricted token). A file mutation issued by the agent's own `fs` tool is fenced by an **in-process JavaScript path-containment check that the source itself explicitly refuses to call a security boundary**. There is no network policy, no syscall policy, no seccomp, and no container/microVM anywhere in this axis.

Second-order consequence any port must replicate: **the filesystem fence is a cooperative seam over one process, not a kernel boundary**, so a compromised or malicious _plugin_ running in the agent process bypasses it entirely, while a malicious _child process_ is contained. This asymmetry is stated in the source, not inferred.

---

## 1. The actual isolation architecture

### 1.1 Layer map

DSH uses a **capability-seam architecture (Cordis services)**. Each seam has one abstract Service Definition and one mounted backend; **mounting the sandboxing backend instead of the local one is the whole swap** — the model-facing tools are unchanged.

| Layer                               | Package                                   | Registered as                 | Enforces                                                                                                |
| ----------------------------------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Policy owner                        | `dsh-sandbox-policy`                      | `ctx.sandboxPolicy`           | Deployment default mode, per-session mode fold, workspace root resolution. **Enforces nothing itself.** |
| Process confinement (abstract seam) | `dsh-sandbox`                             | `ctx.sandbox` (abstract)      | `confine(argv, policy, signal) -> { argv, enforcement, denialSignatures, runnerFailureRules }`          |
| Process confinement (local impl)    | `dsh-sandbox-local`                       | `ctx.sandbox`                 | Platform runner selection + argv wrapping                                                               |
| Shell consumers                     | `dsh-bash-sandbox`, `dsh-pwsh-sandbox`    | `ctx.shell`                   | Wrap the exact argv through `ctx.sandbox.confine`; classify the result                                  |
| Filesystem seam                     | `dsh-fs`                                  | `ctx.fs` (abstract)           | Vocabulary only                                                                                         |
| Filesystem local impl               | `dsh-fs-local`                            | `ctx.fs`                      | **No confinement at all**                                                                               |
| Filesystem sandboxing impl          | `dsh-fs-sandbox`                          | `ctx.fs`                      | In-process path-containment fence on `writeText`/`editText` only                                        |
| Process spawning                    | `dsh-subprocess` / `dsh-subprocess-local` | `ctx.subprocess`              | Env scrub, process-tree _termination_ containment (not permission isolation)                            |
| Human approval                      | `dsh-user-approval`                       | `ctx.approval`                | Fail-closed one-shot decision waterfall                                                                 |
| User questions                      | `dsh-user-questions`                      | `ctx.userQuestions`           | Blocking ask with a UI answerer waterfall                                                               |
| Presets                             | `dsh-permission-presets`                  | `ctx.permissionPresets`       | Bundles (sandbox mode x approval policy); refuses to mount over an unconfined shell                     |
| Observed-state policy               | `dsh-fs-observation-policy`               | _(no service — event plugin)_ | Read-before-write guards                                                                                |

Evidence:

- `dsh-sandbox/lib/index.js:252-256` — _"Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a host-path file policy. Containers, microVMs, and remote execution replace the surrounding capability seam instead; this service shares the host kernel and filesystem."_
- `dsh-sandbox-policy/lib/index.js:56-62` — _"Enforcing filesystem, one-shot bash, and terminal backends read the SAME resolved policy here."_
- `dsh-fs-sandbox/lib/index.js:95-101` — _"loading it INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole swap — the model-facing tools are untouched"_.
- `dsh-sandbox/README.md:168` — _"Same-world confinement only — containers, microVMs, and remote execution require replacing capability implementations rather than adding a provider here."_

### 1.2 Per-platform OS mechanisms (the concrete names)

`PLATFORM_CHAINS` (`dsh-sandbox-local/lib/index.js:173-177`):

```js
const PLATFORM_CHAINS = {
  linux: ["bwrap", "landlock"],
  darwin: ["seatbelt"],
  win32: ["windows-acl"],
};
```

**macOS — Seatbelt (sandbox-exec + SBPL profile).** Built as an SBPL string at `dsh-sandbox-local/lib/index.js:65-75`:

```js
const forms = [
  "(version 1)",
  "(allow default)",
  "(deny file-write*)",
  `(allow file-write* (literal ${sbplString("/dev/null")}))`,
];
const roots = writableRoots(policy);
if (roots.length > 0)
  forms.push(
    `(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`,
  );
return ["-p", forms.join(" ")];
```

Deny-by-default for writes, then a narrow allow. Executable: `sandbox-exec` (`dsh-sandbox-local/lib/index.js:528-530`). Enforcement claimed `full` (`:190`).

**Linux — bubblewrap, falling back to a Landlock launcher.**

bwrap profile (`dsh-sandbox-local/lib/index.js:22-39`):

```js
const args = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--unshare-pid",
  "--proc",
  "/proc",
  "--die-with-parent",
];
if (policy.mode === "workspace-write") {
  args.push("--tmpfs", "/tmp");
  args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
}
```

Note what is **absent**: no `--unshare-net`, no `--unshare-user`, no seccomp filter. A PID namespace and a private `/dev` are the only namespace work.

Landlock launcher grants (`dsh-sandbox-local/lib/index.js:45-52`):

```js
const readWrite = ["/dev/null"];
if (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);
return grantArgs({ readOnly: ["/"], readWrite });
```

The launcher itself is `@deepseek-ai/node-addon-system/landlock-run` (imported at `dsh-sandbox-local/lib/index.js:6`) — **not present in that release's published packages**, so the native grant syscall is **not found in source**. Landlock also self-reports partial enforcement on older ABIs (`RUNNER_FAILURE_RULES.landlock[0].informationalLines`, `dsh-sandbox-local/lib/index.js:236`).

**Windows — ACL restricted token + Low integrity + DACL/mandatory-label grants.** Runner: `lib/runner.js` launched as `[node, runner, ...]` (`dsh-sandbox-local/lib/index.js:539-553`). Restricted-token creation (`dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js:884-897`):

```js
const restrictingSids = buildRestrictingSids(mode === "read-only" ? [logonSid, known.world] : /* ... */ [logonSid, known.world, ...writeSids]);
if (api.createRestrictedToken(currentToken, 13, 0, null, 0, null, restrictingSids.length/16, restrictingSids, tokenSlot) === 0) throwLastError$(...);
```

`13` is `DISABLE_MAX_PRIVILEGE`; the restricting-SID list IS the write capability. The token is additionally lowered to **Low integrity** (`TokenIntegrityLevel`, `TokenInformationClass 25`, `dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js:833-839`). Enforcement claimed **partial** (`dsh-sandbox-local/lib/index.js:191`), and the source says exactly why (`dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js:1168-1173`):

> _"Known boundaries (inherent to restricted tokens, not this port): writes are restricted; reads, network, and process visibility are NOT (WRITE_RESTRICTED intersects only write accesses); console isolation is unavailable..."_

Grant materialisation is per-workspace standing + per-session random temp (`dsh-sandbox-local/lib/index.js:396-444`), fail-closed with cleanup on partial failure (`:422-436`).

### 1.3 Process-tree termination containment (a separate, weaker layer)

`ctx.subprocess` chooses how it can _kill a whole tree_, not how it restricts it (`dsh-subprocess-local/lib/index.js:1384-1404`):

- Linux: transient **user-systemd scope** via `systemd-run` (`:478-513`).
- Windows (ordinary processes): **Job object** via a private native runner (`:525-535`, `:588+`).
- Everything else, including **all of macOS**: `"fallback"`.

---

## 2. The sandbox policy model

### 2.1 The type

`SANDBOX_MODES` — a closed union of exactly three strings (`dsh-sandbox-policy/lib/index.js:26-30`):

```
"read-only" | "workspace-write" | "danger-full-access"
```

Service config — **default is `read-only`** (`dsh-sandbox-policy/lib/index.js:97-104`):

```js
static Config = z$1.object({
	mode: z$1.union(["read-only","workspace-write","danger-full-access"]).default("read-only"),
	workspaceRoot: z$1.string()
});
```

The per-call resolved policy is a plain object, not a branded type (`dsh-sandbox-policy/lib/index.js:141-148`):

```js
resolve(request = {}) {
	return {
		mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
		workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
		...session === void 0 ? {} : { sessionId: session.id }
	};
}
```

**Fields: `mode`, `workspaceRoot` (absolute), optional `sessionId`.** Precedence: approved explicit mode > session's last `sandbox/mode` event > deployment default.

### 2.2 How roots are declared

There is **no root list in the policy**. The mode is the vocabulary; the root is singular:

- `workspaceRoot` is validated to be absolute (`dsh-sandbox-policy/lib/index.js:67-70`) and falls back to `config.workspaceRoot ?? process.cwd()` (`:113`).
- The writable allow-list is _derived_ in one shared home, `writableRoots()` (`dsh-sandbox/lib/index.js:166-173`):

```js
function writableRoots(policy) {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
}
```

- Roots are canonicalised with `realpathSync.native` and fall back to the literal spelling when resolution fails — deliberately conservative (`dsh-sandbox/lib/index.js:150-156`).
- bwrap and Landlock keep **their own** grant spellings (`--tmpfs /tmp` vs an ephemeral grant), and the source says parity is pinned by test, not by shared code (`dsh-sandbox/lib/index.js:133-136`).

**No extra writable roots exist in the policy type.** `dsh-sandbox-policy/README.md:147`: _"One primary workspace root per session — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`."_

### 2.3 Is network scoped?

**No. Not at all, on any platform, in any mode.** Three independent confirmations:

1. `dsh-sandbox/README.md:167` — _"File effects are the whole policy vocabulary — the seam expresses no network, process, syscall, device, or credential restrictions."_
2. `dsh-sandbox-policy/README.md:148` — _"File-effect modes only — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them."_
3. In code: no network token appears in any profile builder. bwrap args are `ro-bind / /`, `dev /dev`, `unshare-pid`, `proc /proc`, `die-with-parent` (`dsh-sandbox-local/lib/index.js:22-39`) — no `--unshare-net`. The Seatbelt profile opens with `(allow default)` (`:68`). Landlock grants are filesystem-only (`:45-52`). Windows restricted tokens restrict writes only (`dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js:1169`).

A grep for `network` across all sandbox packages returns exactly **one** hit — the Windows "not restricted" boundary note.

### 2.4 How env vars are scrubbed

One scrub, defined in the seam, applied by every spawner (`dsh-subprocess/lib/index.js:32`, `:50-56`):

```js
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
function scrubbedParentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== void 0 &&
      !SENSITIVE_ENV_PATTERN.test(key) &&
      !key.toUpperCase().startsWith("DSH_")
    )
      env[key] = value;
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === void 0) Reflect.deleteProperty(env, name);
    else env[name] = value;
  }
  return env;
}
```

- **Two rules:** drop anything matching `/KEY|PASSWORD|SECRET|TOKEN/i`; drop every `DSH_*`.
- `PATH`, `HOME`, locale and proxy vars **survive** (`dsh-subprocess/lib/index.js:36-38`).
- Explicit caller env **merges after** the scrub, so a deliberately supplied credential is preserved (`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:686-707`, `:1516-1527`). Windows keys are upper-cased for the merge to respect case-insensitive names (`:700-706`).
- Bash then layers model-friendly overrides on top: `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat` (`dsh-bash-local/lib/index.js:22-27`, applied `:122-126`). pwsh gets the same minus `TERM` (`dsh-pwsh-local/lib/index.js:87-91`).
- A separate private control channel exists for Node children: fd 7 + a one-shot `DSH_SUBPROCESS_CONTROL` launch marker, deleted before app code runs (`dsh-subprocess/lib/control.js:5-25`).

---

## 3. Fail-open vs fail-closed

### 3.1 The deciding branches, quoted

**Process confinement — FAIL CLOSED.** `dsh-sandbox-local/lib/index.js:490-512`:

```js
selectRunner(mode) {
	this.selectedRunner ??= this.chainVerdict();
	if (this.selectedRunner === "unavailable") throw new SandboxUnavailableError(mode);
	return this.selectedRunner;
}
chainVerdict() {
	const chain = this.internals.chain ?? PLATFORM_CHAINS[this.internals.platform ?? process.platform] ?? [];
	const [first, ...rest] = chain;
	if (first === void 0) return "unavailable";
	if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] };
	for (const runner of chain) {
		const enforcement = this.probeRunner(runner);
		if (enforcement !== "unusable") return { runner, enforcement };
	}
	return "unavailable";
}
```

And the error itself (`dsh-sandbox/lib/index.js:270-275`):

> `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.`

The abstract contract forbids the alternative outright (`dsh-sandbox/lib/index.js:277-281`):

> ```
> Abstract process-sandbox service. `confine` must return enforcing argv
> or fail closed at wrap or runner-execution time; silent unconfined
> passthrough is forbidden.
> ```

**Runtime runner breakage — also FAIL CLOSED**, in three separate places: a fatal runner signature on a settled foreground run (`dsh-bash-sandbox/lib/index.js:104-105`), a positive runner-executable spawn failure (`:116`), and the same pair in pwsh (`dsh-pwsh-sandbox/lib/index.js:190-191`, `:202`).

**Filesystem — FAIL CLOSED under a mounted fence** (`dsh-fs-sandbox/lib/index.js:153-166`): `read-only` always throws; `workspace-write` throws unless contained.

**Approval — FAIL CLOSED in four distinct places** (`dsh-user-approval/lib/types/index.js:169-190`): aborted signal -> `cancelled`; policy `never` -> `rejected` **before dispatch**; no terminal answerer -> `unavailable`; a throwing answerer -> `unavailable`; a rogue non-vocabulary return -> normalised to `unavailable`.

### 3.2 The genuine fail-OPEN surfaces

**(a) Process-tree termination containment degrades to a warning.** `dsh-subprocess-local/lib/index.js:1384-1404`:

```js
selectContainmentMode(kind) {
	if (platform === "linux") { /* ... */ if (available) return "linux-scope";
		fallbackReason = "the current user-systemd scope or private bootstrap is unavailable"; }
	if (kind === "ordinary" && platform === "win32") { if (probeWindowsJob()) return "windows-job"; }
	this.warnFallback(platform, kind, fallbackReason);
	return "fallback";
}
warnFallback(platform, kind, selectedReason) {
	if (this.fallbackWarningIssued) return;
	this.fallbackWarningIssued = true;
	this.ctx.logger.warn(`subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`);
}
```

**This is the largest fail-open in the axis.** It is a one-shot warning (latched by `fallbackWarningIssued`, `:1400`) and the process still runs. It is _not_ a file-permission bypass — the sandbox layer is independent and still closed — but it is a real resource/lifecycle boundary that silently weakens. On macOS this path is **always** taken for ordinary processes (`:1402`, _"macOS has no supported persistent process-range owner"_), and for terminals on every platform.

**(b) Windows ACL cleanup failures are reported, not thrown.** `dsh-sandbox-local/lib/index.js:469-472` — `logger.warn` per failure. Rationale at `:450-451`: _"cordis teardown must not be aborted by grant cleanup."_ Residual ACEs/temp dirs are left behind; a new provider never reuses the residue's random path or SID (`:389-390`).

**(c) Seatbelt's sole candidate is chosen without a probe.** `dsh-sandbox-local/lib/index.js:165-171`: _"darwin has exactly one candidate, selected without any probe."_ If `sandbox-exec` is broken but present, the failure surfaces as a _runner_ failure (exit-gated on the `sandbox-exec: ` signature, `:238`), not as a probe-time refusal. Still closed, but a different branch.

**(d) The filesystem fence's TOCTOU window is accepted.** `dsh-fs-sandbox/lib/index.js:82-85`: _"The residual TOCTOU (an ancestor symlink swapped between the containment re-check and the syscall) is narrowed by re-canonicalizing immediately before delegating and is accepted for this threat model."_

### 3.3 Findings table

| #   | Boundary                                        | Direction                                       | Deciding code                                                                                                     |
| --- | ----------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Process sandbox backend unavailable on host     | **CLOSED**                                      | `dsh-sandbox-local/lib/index.js:492` -> `SandboxUnavailableError`                                                 |
| 2   | Platform has no runner chain at all             | **CLOSED**                                      | `dsh-sandbox-local/lib/index.js:499` `return "unavailable"`                                                       |
| 3   | All candidates probe "unusable"                 | **CLOSED**                                      | `dsh-sandbox-local/lib/index.js:511`                                                                              |
| 4   | Runner crashes mid-run (fatal stderr signature) | **CLOSED**                                      | `dsh-bash-sandbox/lib/index.js:105`; `dsh-pwsh-sandbox/lib/index.js:191`                                          |
| 5   | Runner binary missing/EACCES at spawn           | **CLOSED**                                      | `dsh-bash-sandbox/lib/index.js:116` via `isRunnerSpawnFailure` (`dsh-sandbox/lib/index.js:203-213`)               |
| 6   | fs write under `read-only`                      | **CLOSED**                                      | `dsh-fs-sandbox/lib/index.js:157`                                                                                 |
| 7   | fs write outside roots under `workspace-write`  | **CLOSED**                                      | `dsh-fs-sandbox/lib/index.js:164`                                                                                 |
| 8   | fs write under `danger-full-access`             | **OPEN BY DESIGN**                              | `dsh-fs-sandbox/lib/index.js:156` `return target`                                                                 |
| 9   | No sandboxing fs backend mounted at all         | **OPEN BY COMPOSITION**                         | `dsh-fs-local/lib/index.js:864` has no fence; `sandboxMode` getter returns `undefined` (`dsh-fs/lib/index.js:86`) |
| 10  | No sandboxing shell executor mounted            | **OPEN BY COMPOSITION**                         | `dsh-bash-local` has no `sandboxMode`; `dsh-permission-presets/lib/index.js:177` refuses to mount over it         |
| 11  | Approval asked with no answerer composed        | **CLOSED**                                      | `dsh-user-approval/lib/types/index.js:184` default `() => Promise.resolve('unavailable')`                         |
| 12  | Answerer throws                                 | **CLOSED**                                      | `dsh-user-approval/lib/types/index.js:190` `() => 'unavailable'`                                                  |
| 13  | Answerer returns a non-vocabulary value         | **CLOSED**                                      | `dsh-user-approval/lib/types/index.js:187`                                                                        |
| 14  | Approval policy `never`                         | **CLOSED** (rejects)                            | `dsh-user-approval/lib/types/index.js:178-179`                                                                    |
| 15  | Escalation requested with no `ctx.approval`     | **CLOSED**                                      | `dsh-sandbox/lib/index.js:103`                                                                                    |
| 16  | Escalation to a non-strictly-wider mode         | **CLOSED**                                      | `dsh-sandbox/lib/index.js:102`                                                                                    |
| 17  | Escalation rejected / cancelled / unavailable   | **CLOSED**                                      | `dsh-sandbox/lib/index.js:118-120`                                                                                |
| 18  | User question with no answerer                  | **CLOSED**                                      | `dsh-user-questions/lib/types/index.js:323` `NO_PROVIDER`                                                         |
| 19  | User question from a delegated (owned) agent    | **CLOSED**                                      | `dsh-user-questions/lib/types/index.js:151-154` `DELEGATED_CALLER`                                                |
| 20  | **Process-tree containment unavailable**        | **OPEN (warned, latched once)**                 | `dsh-subprocess-local/lib/index.js:1396-1403`                                                                     |
| 21  | **Windows ACL grant cleanup on teardown**       | **OPEN (warned)**                               | `dsh-sandbox-local/lib/index.js:469-472`                                                                          |
| 22  | **macOS Seatbelt (sole candidate)**             | **CLOSED, but unprobed**                        | `dsh-sandbox-local/lib/index.js:500-503`                                                                          |
| 23  | **fs-fence ancestor-symlink TOCTOU**            | **ACCEPTED RISK**                               | `dsh-fs-sandbox/lib/index.js:82-85`                                                                               |
| 24  | **Network, syscalls, devices, credentials**     | **UNSCOPED (not fail-open; not in vocabulary)** | `dsh-sandbox/README.md:167`; no code path                                                                         |

---

## 4. Filesystem policy

### 4.1 Read roots

**There are none — every mode permits reading anything the host user can read.** `dsh-fs-sandbox/lib/index.js:71-75`:

> _"Reads pass through untouched: every mode permits reading."_

`readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`, `stat`, `lstat` are inherited verbatim from `LocalFileSystem` and are not overridden (`dsh-fs-local/lib/index.js:802-863`). Windows restricted tokens agree (`dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js:1169`: _"reads, network, and process visibility are NOT"_ restricted).

### 4.2 Write roots

Exactly two fences exist, both on mutations only:

- `writeText` -> `checkedTarget` -> `super.writeText` (`dsh-fs-sandbox/lib/index.js:125-127`)
- `editText` -> `checkedTarget` -> `super.editText` (`:139-141`)

`checkedTarget` (`:153-166`):

```js
async checkedTarget(target, sandboxPolicy) {
	const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	const { mode } = policy;
	if (mode === "danger-full-access") return target;
	if (mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
	const fresh = await this.resolve(target.displayPath);
	let contained = false;
	for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) { contained = true; break; }
	if (!contained) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
	return fresh;
}
```

Note the check-here-write-there fix: it **re-resolves immediately before** delegating and returns _that_ fresh target, so the checked identity is the mutated one.

Containment mechanics (`dsh-fs-sandbox/lib/index.js:53-65`): lexical prefix match on case-folded paths (`caseSensitive = process.platform !== "win32"`, `:53`), then an **inode-identity ancestor walk** for Windows 8.3 / casing aliases (`:38-40`, `:58-64`).

### 4.3 Workspace confinement

The workspace root is `SessionHeader.cwd` — the session's own cwd, resolved fresh per call (`dsh-sandbox-policy/lib/index.js:145`, used at `dsh-tool-fs/lib/index.js:1124`). There is no separate "confine to repo root" concept.

### 4.4 What is denied

Under `workspace-write`, a write is denied unless its canonical target is the workspace root or under `/tmp` or `os.tmpdir()` (`dsh-sandbox/lib/index.js:166-173`). Renames, deletes and creates are all covered because `writeFileAtomic` is the only mutation primitive (`dsh-fs-local/lib/index.js:873`, `:892`).

### 4.5 How denial is surfaced to the caller

Two levels.

**Structured:** `FsError` with code `FS_SANDBOX_DENIED` (`dsh-fs/lib/index.js:34-40`; codes raised at `dsh-fs-sandbox/lib/index.js:157,164`).

**Model-facing:** `dsh-tool-fs/lib/index.js:1159-1163` rewraps it, keeping the code:

```js
mapError(error, policy) {
	if (!(error instanceof FsError) || error.code !== "FS_SANDBOX_DENIED") return error;
	return new FsError(`${sandboxDenialMarker(mode)}\n${escalationHintMarker("operation")}`, "FS_SANDBOX_DENIED", { cause: error });
}
```

Marker text (`dsh-sandbox/lib/index.js:64-66` / `:76-78`):

```
[sandbox: file access denied under <mode> mode]
[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```

Bash cannot use a typed channel — it matches the **child's stderr** against per-backend signatures (`dsh-sandbox-local/lib/index.js:206-217`):

```js
bwrap: ["read-only file system"], landlock: ["permission denied"],
seatbelt: ["operation not permitted"],
"windows-acl": ["access is denied","access to the path","permission denied","operation not permitted"]
```

The source is candid that this is a heuristic: `dsh-sandbox/README.md:170` — _"a confined child that deliberately mimics its runner can cause a false availability or diagnostic attribution; this cannot bypass confinement."_

---

## 5. Human approval / permission system

### 5.1 The model

Two independent knobs, bundled into presets.

**Knob 1 — sandbox mode** (file effects): `read-only | workspace-write | danger-full-access`.

**Knob 2 — approval policy** (`APPROVAL_POLICIES`, `dsh-user-approval/lib/types/index.js:17`): `ask | never`.

Both are **per-session, event-sourced**. The session log is the only store; there is no external config:

- `setSandboxMode(session, mode)` appends one `sandbox/mode` event (`dsh-sandbox-policy/lib/index.js:40-42`).
- `setApprovalPolicy(session, policy)` validates then appends `approval/policy` (`dsh-user-approval/lib/types/index.js:46-51`).
- Event shapes (`dsh-permission-presets/lib/typert.host.js:483`):

```ts
'sandbox/mode':     { mode: SandboxMode; source?: 'delegation' };
'approval/asked':   { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string };
'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome };
'approval/policy':  { policy: ApprovalPolicy; source?: 'delegation' };
'permission/preset':{ preset: string };
```

**Outcome vocabulary** — `OUTCOMES` (`dsh-user-approval/lib/types/index.js:15`):

```
allowed-once | rejected | cancelled | unavailable
```

**`allowed-once` is the only grant.** There is no "always allow" and no persistent allow-list anywhere in the source.

### 5.2 Presets — yes

`PermissionPresetService.Config.presets` (`dsh-permission-presets/lib/index.js:138-159`) defaults to two entries:

```js
"workspace-write":    { sandbox: "workspace-write",    approval: "ask",   ... }
"danger-full-access": { sandbox: "danger-full-access", approval: "never", ... }
```

Plus a derived `CUSTOM_PRESET = "custom"` (`:50`) that is a _display_ state, never a switch target (`:175`), and a fixed `AUTO_PRESET = "auto"` (`:52`, `AUTO_PRESET_SPEC` at `:58-61`) registered only while an integration is live.

Switching a preset is **two event appends, never a direct write** (`dsh-permission-presets/lib/index.js:344-361`). Selecting the already-effective preset appends nothing (`:359`).

**Composition-time guard** (`:177`):

> `if (ctx.shell.sandboxMode === void 0) throw new Error("permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration");`

Session bootstrap pins every missing fact before publication (`:370-389`), so a session can never start with an unstated permission state.

### 5.3 Which decisions require a human

**Exactly one: a sandbox escalation retry.** There is no per-tool permission gate, no command allow/deny list, no path allow-list, no domain allow-list.

The escalation ladder is a strictly-wider table checked at execution, never in the schema (`dsh-sandbox/lib/index.js:30-33`):

```js
const WIDER_MODES = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
};
```

`ESCALATION_TARGETS = ["workspace-write", "danger-full-access"]` is what the _schema_ advertises (`dsh-sandbox/lib/index.js:42`). The rationale for the split: a `danger-full-access` default would otherwise advertise nothing while a narrowed session stays confined with no lever.

Argument pairing is validated before anything runs (`dsh-sandbox/lib/index.js:51-55`): `sandbox_permissions` and `justification` must travel together, and the justification must be a non-empty sentence.

### 5.4 How the answer is threaded back into execution

`approveEscalation` (`dsh-sandbox/lib/index.js:99-123`) — the ordered, fail-closed sequence:

```js
async function approveEscalation(request, approval) {
	const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;                                // no widening -> no ask
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(...);       // not strictly wider
	if (approval.approver === void 0) throw new Error(...);                            // no approval service
	if (approval.agent === void 0) throw new Error(...);                               // no agent
	const outcome = await approval.approver.request({
		agent: approval.agent, toolName: approval.toolName, callId: approval.callId,
		reason: `escalate sandbox to ${mode}: ${justification}`,
		displayReason: { en: `Allow this operation with ${mode} permissions: ${justification}`, zh: `...` },
		...approval.signal ? { signal: approval.signal } : {}
	});
	switch (outcome) {
		case "allowed-once": return mode;
		case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
		case "cancelled": throw new Error(...);
		case "unavailable": throw new Error(...);
		default: return assertNever(outcome, "EscalationOutcome");
	}
}
```

The granted mode is consumed by **one call only** — the tool builds a per-call policy object and hands it down (`dsh-tool-fs/lib/index.js:1128-1143`; bash at `dsh-tool-bash/lib/index.js:364`, `:644`). It is never persisted to the session log.

**Service side** (`dsh-user-approval/lib/types/index.js:121-138`): the ask must be **turn-enclosed** or it throws before appending anything (`:123-127`, because a bare event between turns is crash-tail garbage on replay). Then `approval/asked` is appended, the waterfall is dispatched, and `approval/decided` is appended — an unlogged decision is refused (`:104-119`).

The decision is a **Cordis waterfall**, `approval/request` (`:184`), scoped to the agent. Signature (`dsh-tool-cordis/lib/types/api-catalog.js:3852-3857`):

```
'approval/request'( this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome> ): Promise<ApprovalOutcome>
```

Wire shape (`dsh-tool-cordis/lib/types/api-catalog.js:4475-4476`):

```ts
export interface ApprovalRequestEvent {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: ToolCallId;
  readonly reason?: string;
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
  readonly signal?: AbortSignal;
}
```

### 5.5 Client-UI message shapes

`dsh-client-ui-approval/lib/client.js` is a browser module. The transport is a **remote event subscription**, not a bespoke RPC (`:355-357`):

```js
ctx.remote.$on("approval/request", function (request, next) {
  return answerApproval(ctx, this, request, next, registerPendingInteraction);
});
```

Client-side presentation object `PendingApproval` (`:152-252`) — fields: `sessionId`, `kind: "approval"`, `key` (`approval:<n>`, one-shot remount axis), `toolName`, `callId?`, `reason?`, `displayReason?`, `result` (a `Promise.withResolvers` promise), plus `answerable` / `answer(outcome)` / `delegate()` / `isDelegation(reason)` / `abort(reason)`.

**Delegation is first-class**: an unanswerable request rejects with a private `#delegated` symbol, which the listener converts into `next()` (`:222-235`, `:300-305`). Disposal, scope teardown and transport loss all end a pending card (`:240-251`).

Rendered as a **composer takeover** (the user cannot type while pending), with two buttons and fixed shortcuts (`:79`, `:320-341`):

- `Enter` -> `allowed-once`; `Escape` -> `rejected`
- Labels (`:257-271`): `等待审批` / `Waiting for approval`, `拒绝` / `Reject`, `允许一次` / `Allow once`
- A `conversation.approval.detail` slot lets the owning tool inject the exact command/diff under review (`:350-353`)
- IME composition and repeat-key guards are explicit (`:78-95`)

Permission-preset UI is separate: a payload-free invalidation event plus a re-read (`dsh-client-ui-permission-presets/lib/client.js:42`, `:120`), and a process-level default written through `ctx.remote.settings.mutate(ns, [{op:"set", path:["defaultPreset"], value}], revision)` (`:655-659`). `danger-full-access` and `auto` require an explicit acknowledge dialog (`:755-760`).

### 5.6 Subagent delegation pins a _stricter_ policy

`captureDelegatedPolicyOverrides` (`dsh-subagent/lib/types/child-agent.js:185-192`):

```js
return {
  permissionPreset: preset === "auto" || preset === "danger-full-access" ? preset : undefined,
  sandboxMode: parent.ctx.get("sandboxPolicy")?.overrideOf(parent.session),
  approvalPolicy: parent.ctx.get("approval") === undefined ? undefined : "never",
};
```

A child agent is **always** pinned to `approval: 'never'` — its escalation denials stay final and never re-prompt the human. The parent's explicit session mode override is inherited; the parent's _deployment default_ is not.

---

## 6. User questions

**Seam:** `ctx.userQuestions` (`dsh-user-questions/lib/types/index.js:75-93`), a Typert remote service. **Model-facing tool:** `ask_user_question` in `dsh-tool-ask-user` (`dsh-tool-ask-user/lib/index.js:19`).

### 6.1 Mechanism

`ask(request)` (`dsh-user-questions/lib/types/index.js:294-338`) validates, then blocks on a Cordis waterfall:

```js
const noAnswerer = () =>
  Promise.reject(
    new UserQuestionError("no user-questions answerer accepted the request", "NO_PROVIDER"),
  );
return await (agent === undefined
  ? this.ctx.waterfall("user-questions/request", request, noAnswerer)
  : this.ctx.waterfall(
      scopeTarget(agent, agent),
      "user-questions/request",
      { ...request, agent },
      noAnswerer,
    ));
```

Wire shapes (`dsh-tool-cordis/lib/types/api-catalog.js:4483-4508`):

```ts
interface AskUserQuestionItem {
  id;
  question;
  detail?;
  header?;
  options?: { label; description? }[];
  multiSelect?;
  intent?;
}
interface AskUserQuestionAnswer {
  answers: { id; selected: string[]; custom?: string }[];
}
interface AskUserQuestionRequestEvent {
  questions: AskUserQuestionItem[];
  agent?: Agent;
  signal?: AbortSignal;
  wait?: { callId; timed?: boolean };
}
```

**Pre-flight validation that types cannot express** (`dsh-user-questions/lib/types/index.js:311-322`): a `plan-review` intent's `approve` label must be one of the question's own options, and the question must carry the `detail` it reviews — otherwise a UI would put in front of the user a choice the asker never offered, or an approval of something invisible. Both raise `BAD_INTENT`.

**Human-availability gate** (`:146-155`): the caller must be the **exact live runtime root agent** (`CALLER_NOT_LIVE`), and must not be owned by another live agent (`DELEGATED_CALLER`). Runtime ownership, not session lineage, decides this.

### 6.2 Timed variant — "pending", not "answered"

`askTimed` (`:239-277`) attaches a `TimedQuestionWait` and maps `ASK_TIMED_OUT` to a **pending result rather than a failure** (`:265-266`):

```js
if (error instanceof UserQuestionError && error.code === "ASK_TIMED_OUT")
  return { pending: true, callId };
```

Result union (`dsh-tool-cordis/lib/types/api-catalog.js:7487-7488`): `AskUserQuestionAnswer | { pending: true; callId }`.

The pending notice is a _field of the result value_, because the recorded result text is re-read as one JSON object by the projection (`dsh-tool-ask-user/lib/index.js:27`):

> _"No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer... Do not treat this as permission."_

### 6.3 How a late answer resumes execution

The question stays **answerable after the tool returned**. A session projection folds tool events into `{ active, settled }` (`dsh-user-questions/lib/types/projection.js:50-79`) with each active entry carrying `state: 'open' | 'continued'`.

`answer(agent, callId, answer)` (`dsh-user-questions/lib/types/index.js:173-213`) then **steers a user message into the running agent**:

```js
const message = createUserMessage({
  source: { kind: "user-question-reply", callId, outcome: "answered" },
  content: [
    {
      type: "text",
      text: JSON.stringify({
        kind: "answer_to_pending_question",
        tool: "ask_user_question",
        callId,
        questions: question.questions,
        answers: answer.answers,
      }),
    },
  ],
});
agent.steer(message);
```

Double-answer is refused with `REPLY_QUEUED` (`:180-182`); a batch that does not name each question exactly once is `BAD_ANSWER` (`:186-191`). The queued reply is released when the agent admits the message or the turn ends (constructor handlers, `:104-138`).

**This is the key difference from approval:** approval is a synchronous await inside one tool call and its grant is _consumed once_; a user question can be answered _after_ the tool call returned, and the answer re-enters the agent's inbox as a user message.

---

## 7. Resource limits

### 7.1 Memory / CPU

**NOT FOUND IN SOURCE.** A grep across the whole extracted tree for `ulimit`, `rlimit`, `RLIMIT`, `setrlimit`, `cpus`, `cpuLimit`, `maxMemory`, `memoryLimit`, `nice` returns **zero hits**. There is no cgroup, no rlimit, no Job-Object memory/cpu limit, no systemd `MemoryMax=`.

The Windows Job object is used for **tree ownership/termination only**, not quotas.

### 7.2 What _is_ enforced

| Limit                     | Value                                               | Code                                              |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| bash default timeout      | 120 s                                               | `dsh-bash-local/lib/index.js:72`                  |
| bash max timeout cap      | 600 s                                               | `dsh-bash-local/lib/index.js:73`                  |
| bash stdout cap           | 64 KB                                               | `dsh-bash-local/lib/index.js:74`                  |
| bash per-stream spill cap | 64 MB                                               | `dsh-bash-local/lib/index.js:31`, `:75`           |
| TERM->KILL grace          | 3 s                                                 | `dsh-bash-local/lib/index.js:29`, `:76`           |
| probe timeout             | 5 s                                                 | `dsh-sandbox-local/lib/index.js:256`              |
| tool-call timeout         | per-tool, cooperative                               | `dsh-tool-call-timeout-policy/lib/index.js:3-6`   |
| ask_user_question wait    | default 120 s, model-settable, `-1` = block forever | `dsh-tool-ask-user/lib/index.js:9`, `:64`, `:120` |

Every one of these is a **bounded-timer / bounded-buffer** control, not a resource quota.

### 7.3 Security boundary or accident mitigation?

**Accident mitigation. The code says so.**

- `dsh-timeout/lib/index.js:3-5`: _"The library only notifies through abort signals; each capability still owns the mechanism that stops its work and translates timeout reasons into public outcomes."_
- Tool-call timeouts are **cooperative, not enforced** (`dsh-tool-call-timeout-policy/lib/index.js:3-6`): _"A tool declares `timeoutMs` and promises to honor `exec.signal`"_. A tool that ignores cancellation keeps running.
- `dsh-bash-local/lib/index.js:60-64` frames the budgets as _"Bounded output, spill files, managed-range SIGTERM->SIGKILL escalation, and quiescence are the subprocess service's mechanics"_.
- The **one** place a limit participates in isolation is process-tree termination, and that degrades open (finding #20 above).

Note also the comment in the bash tool that deployment policy is explicitly _not_ this layer's job: `dsh-tool-bash/lib/index.js:218-219` — _"TODO(permissions): deployment policy belongs in `tools/pre-execute` and sandboxing executors."_

---

## 8. The observation policy (`dsh-fs-observation-policy`)

**It is not a sandbox.** It is a **read-before-write integrity guard** against a model clobbering a file it never read.

It **registers no service** — it is a bare event plugin with three listeners and its own `WeakMap` (`dsh-fs-observation-policy/lib/index.js:85-95`):

```js
ctx.on("fs/write-intent", (target, actor) => ... gate.writeIntent(target, actor));
ctx.on("fs/edit-intent",  (target, actor) => ... gate.editIntent(target, actor));
ctx.on("fs/observed",     (target, observation, actor) => { gate.observe(target, observation, actor); });
```

**State** — weak owner -> `targetKey` -> observation (`:22`). Owner is the agent's session (`:29-31`), so state dies with the session and is GC-safe.

**Decisions** (`:51-75`):

| Decision                          | Rule                                    | Error                                                           |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| write, unseen or confirmed absent | `{ kind: "createIfAbsent" }`            | —                                                               |
| write, confirmed present          | `{ kind: "replaceIfVersion", version }` | —                                                               |
| edit, unseen                      | **throw**                               | `FS_NOT_OBSERVED` — _"edit requires reading ... first"_ (`:67`) |
| edit, confirmed absent            | **throw**                               | `FS_NOT_FOUND` (`:68`)                                          |
| edit, confirmed present           | `{ version }` (CAS basis)               | —                                                               |

**Enforcement is split**: the policy only _derives the intent_; the provider performs the atomic freshness/no-clobber check. In `LocalFileSystem.writeText` (`dsh-fs-local/lib/index.js:868-871`):

```js
if (expected?.kind === "replaceIfVersion") { ... if (existing.version !== expected.version) throw new FsError(`... file changed since it was read`, "FS_STALE_VERSION"); }
else if (expected?.kind === "createIfAbsent" && existing) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
```

The check and the rename share one critical section via `withLock(target.targetKey, ...)` (`dsh-fs-local/lib/index.js:770-779`, `:865`, `:884`), and the write is atomic.

**Absent this plugin, tools retain unconditional mutation behaviour** (`dsh-fs-observation-policy/lib/index.js:7-8`). Event integrity is separately checked: `fs/observed` kind must be `present` (with non-empty version) or `absent` (`dsh-fs/lib/invariant.js:18-27`).

**Not in scope:** it says nothing about _where_ files may be written, grants nothing, and does not observe the filesystem. Its only input is DSH's own read events.

---

## 9. Audit checklist for a port

Things a third-party design must get right, in the order they matter:

1. **Two enforcement mechanisms, not one.** Kernel confinement for processes; an in-process fence for tool-issued file mutations. Conflating them is the single most likely architectural error.
2. **Three modes, not a boolean**, and the _widest_ mode is a first-class value reachable only through a deliberate user action.
3. **Fail closed at four independent points**: no backend, no runner, no answerer, no agent.
4. **The escalation grant is per-call and single-use.** There is no "always allow" in the vocabulary. A port that adds session-scoped allow-lists changes the security model.
5. **`network` is not in the vocabulary.** Any port claiming network isolation is doing something DSH does not.
6. **Env scrub is two regexes**, and it is an _allow-through-by-pattern_ filter, not a blocklist of known secrets.
7. **The approval audit pair must be turn-enclosed** — an approval logged between turns is dropped as crash-tail on replay.
8. **Subagents are pinned to `approval: 'never'`** so a child cannot re-prompt the human.
9. **Resource limits are cooperative timers, not quotas.** A port that enforces real cgroups/rlimits is _stronger_ than DSH and must not be described as parity.
10. **Process-tree containment is best-effort and warns once.** On macOS it is always the fallback.

---

## Sources

### Primary code (all under the upstream `packages/` tree)

| Path                                                 | Lines cited                                                                                                                                                   | What                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-sandbox/lib/index.js`                           | 30-33, 42, 51-55, 64-66, 76-78, 99-123, 133-136, 150-156, 166-173, 203-213, 224-237, 252-256, 264-275, 277-287                                                | Escalation ladder + markers, `approveEscalation`, `writableRoots`, runner-failure classification, `SANDBOX_UNAVAILABLE`, `SandboxProvider` contract                                          |
| `dsh-sandbox-policy/lib/index.js`                    | 26-30, 40-42, 56-62, 67-70, 97-104, 105, 112-131, 141-148, 154-156                                                                                            | `SANDBOX_MODES`, `setSandboxMode`, Config, `resolve()`, projection registration                                                                                                              |
| `dsh-sandbox-policy/lib/invariant.js`                | 36-38                                                                                                                                                         | `sandbox/mode` validation                                                                                                                                                                    |
| `dsh-sandbox-local/lib/index.js`                     | 6, 22-39, 45-52, 65-75, 100-135, 143-163, 165-177, 187-192, 198-200, 206-217, 231-243, 252-292, 305-334, 336-344, 357-382, 389-444, 454-473, 490-522, 528-553 | Profile builders, `PLATFORM_CHAINS`, `STATIC_ENFORCEMENT`, `DENIAL_SIGNATURES`, `RUNNER_FAILURE_RULES`, `confine`, ACL grants, `selectRunner`/`chainVerdict`/`probeRunner`, revocation       |
| `dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js`      | 179, 833-839, 850-897, 907-910, 1146-1186, 1291                                                                                                               | `CreateRestrictedToken`, Low integrity, restricting-SID lists, documented boundaries                                                                                                         |
| `dsh-sandbox-windows-acl/lib/runner.js`              | whole                                                                                                                                                         | Win32 ACL runner entry                                                                                                                                                                       |
| `dsh-fs/lib/index.js`                                | 34-40, 58-96                                                                                                                                                  | `FsError`, `FileSystem` SD, `sandboxMode` getter                                                                                                                                             |
| `dsh-fs/lib/invariant.js`                            | 9-28                                                                                                                                                          | `fs/*` event invariants                                                                                                                                                                      |
| `dsh-fs-local/lib/index.js`                          | 161-212, 770-801, 802-863, 864-882, 883-900                                                                                                                   | `resolveLocalTarget` (realpath + ancestor walk), `withLock`, reads, `writeText`, `editText`                                                                                                  |
| `dsh-fs-sandbox/lib/index.js`                        | 6-65, 67-102, 103-113, 125-141, 142-166                                                                                                                       | Containment mechanics, "not a security boundary" statement, `SandboxedFileSystem`, `checkedTarget`                                                                                           |
| `dsh-bash-local/lib/index.js`                        | 22-31, 41-58, 60-64, 69-76, 88-105, 107-128, 140-146, 157-318                                                                                                 | `ENV_OVERRIDES`, config budgets, `resolve`, `spawnSpec`, `executeArgv`                                                                                                                       |
| `dsh-bash-sandbox/lib/index.js`                      | 10-12, 32-53, 65-119, 125-133, 138-151, 161-167                                                                                                               | `SandboxBashExecutor`, `danger-full-access` bypass, runner-failure throws, `onProcessDone`                                                                                                   |
| `dsh-pwsh-local/lib/index.js`                        | 87-91, 140, 186, 223-225                                                                                                                                      | `ENV_OVERRIDES`, config, env merge                                                                                                                                                           |
| `dsh-pwsh-sandbox/lib/index.js`                      | 118-205, 224-249                                                                                                                                              | pwsh twin of the bash sandbox consumer                                                                                                                                                       |
| `dsh-subprocess/lib/index.js`                        | 12-13, 25-56, 57-90, 103                                                                                                                                      | `DSH_ENV_PREFIX`, `SENSITIVE_ENV_PATTERN`, `scrubbedParentEnv`, SD contract                                                                                                                  |
| `dsh-subprocess/lib/control.js`                      | 5-25                                                                                                                                                          | fd-7 control channel + launch marker                                                                                                                                                         |
| `dsh-subprocess-local/lib/index.js`                  | 425-443, 451-513, 525-535, 1284-1331, 1332-1355, 1356-1383, **1384-1404**, 1405-1440                                                                          | Group signalling, systemd scope, Windows Job, env/exec lookup, `spawn`, **`selectContainmentMode`/`warnFallback` (fail-open)**                                                               |
| `dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js` | 6, 686-707, 708-735, 736-745, 1511-1527                                                                                                                       | `childEnv`, `taskkillProcessTree`, `targetEnvironment`                                                                                                                                       |
| `dsh-user-approval/lib/types/index.js`               | 14-21, 22-39, 40-51, 57-82, 83-102, 103-138, 139-148, 149-162, 163-206                                                                                        | `OUTCOMES`, `APPROVAL_POLICIES`, model sentences, `setApprovalPolicy`, `request`, `decide`                                                                                                   |
| `dsh-user-approval/lib/types/invariant.js`           | 4-34, 35-41, 42-101                                                                                                                                           | Audit-pair validation (turn-enclosure, id matching, closed vocabulary)                                                                                                                       |
| `dsh-user-approval/lib/types/types.js`               | 12-14                                                                                                                                                         | `ApprovalRequestId` brand                                                                                                                                                                    |
| `dsh-client-ui-approval/lib/client.js`               | 31-139, 141-149, 150-252, 254-271, 273-281, 282-310, 311-358                                                                                                  | `ApprovalPanel`, `PendingApproval`, locales, waterfall listener, shortcuts, slot registration                                                                                                |
| `dsh-permission-presets/lib/index.js`                | 46-61, 62-77, 78-105, 106-111, 138-159, 160-232, 238-251, 291-306, 313-337, 344-361, 362-389, 390-404                                                         | `CUSTOM_PRESET`, `AUTO_PRESET_SPEC`, state schema, `applyPermissionEvent`, Config presets, misconfiguration guard, projection, `derive`, `set`, `pinInitialPermission`, `emitCatalogChanged` |
| `dsh-permission-presets/lib/typert.host.js`          | 63-88, 383, 483, 650-659                                                                                                                                      | Remote `catalog`, `SessionEventMap`, `permission-presets/catalog-changed`                                                                                                                    |
| `dsh-client-ui-permission-presets/lib/client.js`     | 12-120, 264-437, 559-669, 738-760, 799-831                                                                                                                    | Catalog store, `PermissionSelect`, `PermissionRow`, `settings.mutate` write path, acknowledge dialog                                                                                         |
| `dsh-user-questions/lib/types/index.js`              | 50-73, 74-139, 140-145, 146-159, 160-213, 214-277, 278-341                                                                                                    | `UserQuestionError`, service, `assertLiveRoot`, `answer`, `askTimed`, `ask`                                                                                                                  |
| `dsh-user-questions/lib/types/projection.js`         | 1-13, 14-80, 84-94, 95-127, 128-140                                                                                                                           | Tool<->service schema bridge, projection schemas, `questionsOf`                                                                                                                              |
| `dsh-user-questions/lib/types/timed-wait.js`         | whole                                                                                                                                                         | `TimedQuestionWait`                                                                                                                                                                          |
| `dsh-tool-ask-user/lib/index.js`                     | 8-18, 19, 20-27, 28-58, 59-130+                                                                                                                               | Timeout validation, description, pending notice, request/result mapping, timed schema                                                                                                        |
| `dsh-fs-observation-policy/lib/index.js`             | 1-10, 11-76, 77-95                                                                                                                                            | `ObservedStateGate`, three listeners                                                                                                                                                         |
| `dsh-timeout/lib/index.js`                           | 1-30, 31-46, 47-73                                                                                                                                            | `TimeoutReason`, `clampTimeout`, `deadline`                                                                                                                                                  |
| `dsh-tool-call-timeout-policy/lib/index.js`          | 3-13                                                                                                                                                          | Cooperative-timeout contract                                                                                                                                                                 |
| `dsh-subagent/lib/types/child-agent.js`              | 185-192, 193-212                                                                                                                                              | `captureDelegatedPolicyOverrides`, `appendDelegatedPolicyOverrides`                                                                                                                          |
| `dsh-tool-fs/lib/index.js`                           | 1085-1108, 1109-1144, 1145-1163                                                                                                                               | Escalation schema fields, `resolvePolicy`, `mapError`                                                                                                                                        |
| `dsh-tool-bash/lib/index.js`                         | 5, 16-30, 42-55, 150-171, 197-207, 210-233, 234-244, 354-366, 514-521, 644                                                                                    | `sandboxNotes`, denial rendering, `validateBashArgs`, escalation                                                                                                                             |
| `dsh-tool-cordis/lib/types/api-catalog.js`           | 3344-3368, 3851-3858, 4260-4262, 4472-4508, 7487-7488                                                                                                         | `approval/request` waterfall signature, `ApprovalRequestEvent`, `AskUserQuestion*` types, `TimedUserQuestionResult`                                                                          |

### Package READMEs (corroborating; NOT used as primary evidence)

- `dsh-sandbox/README.md:86, 160-171` — fail-closed contract; _"File effects are the whole policy vocabulary"_; stderr-dialect and in-band-diagnostic limitations
- `dsh-sandbox-policy/README.md:140-149` — one root per session; file-effects only
- `dsh-sandbox-windows-acl/README.md:98, 141, 208` — `WRITE_RESTRICTED` + Low integrity + `FILE_DELETE_CHILD` deny; fail-closed by construction
- `dsh-user-approval/README.md:28, 32, 82, 157` — _"Without a terminal answerer, requests resolve `unavailable` and fail closed; the service itself never prompts a human."_
- `dsh-tool-call-timeout-policy/README.md` — cooperative, cannot hard-stop

### Explicitly absent from source

- **Network, syscall, device, credential, seccomp policy** — not in the vocabulary at all.
- **Memory / CPU limits** (rlimit, cgroup, Job quota, `MemoryMax`) — zero grep hits.
- **Containers, microVMs, chroots, namespaces as a confinement tier** — explicitly out of scope (`dsh-sandbox/lib/index.js:252-256`, `dsh-sandbox/README.md:168`).
- **"Always allow" / persistent allow-lists** — the outcome vocabulary is four values and `allowed-once` is the only grant.
- **A built-in/terminal approval answerer** — the service ships none (`dsh-user-approval/README.md:157`).
- **The Landlock native launcher internals** — `@deepseek-ai/node-addon-system/landlock-run` is not among that release's published packages.
