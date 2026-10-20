/**
 * Resolving the DeepSeek credential this package searches with.
 *
 * ## The one question this module answers
 *
 * "Is a DeepSeek API key configured, and what is it?" — and the answer has to match what **pi**
 * would use, because the key this module returns is spent against the same account as the model
 * the user is already paying for.
 *
 * ## Why `ModelRuntime.getAuth()` and not `readStoredCredential()`
 *
 * pi exports two ways to look at `auth.json`, and they do not agree:
 *
 * - `readStoredCredential(providerId)` returns the **raw entry**: it reads `auth.json`, parses the
 *   JSON and hands back `data[providerId]` without resolving anything
 *   (`node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:424-432`).
 * - `ModelRuntime.getAuth(providerId)` returns the **resolved** key: pi's own
 *   `AuthStorage.read()` runs `resolveConfigValue` over the stored value first
 *   (`.../auth-storage.js:376-384`), which executes a `!command` and interpolates a `$VAR`.
 *
 * The gap between them is the whole reason this module exists. A stored credential can be a
 * literal key, a `$VAR` template, or a `!command`; `readStoredCredential` returns the template or
 * the command string as if it were the key. Judging "is it configured?" by "does an entry
 * exist?" therefore reports a configured provider for a credential that cannot produce a key, and
 * reports an unconfigured provider for one that can — both measured, with the six shapes compared
 * side by side in `docs/research/pi-credential-surface-20261020.md` §2.2 and §4.2. `getAuth` is the
 * only public path that hands back the key pi would actually send, and this module uses it.
 *
 * ## The priority, and where this module sits in it
 *
 * pi resolves a provider's key in this order (measured in the same note, §1.3):
 *
 *   1. `auth.json` — a stored credential **owns** the provider;
 *   2. `models.json` — the provider's own `apiKey` configuration;
 *   3. the environment — `DEEPSEEK_API_KEY`.
 *
 * `getAuth()` walks exactly that chain, so this module does not re-implement it and does not get
 * to pick a different order. The `env` option is the **environment level** and nothing else: it
 * is the seam the tests inject through, it never outranks a stored credential, and it is only
 * consulted when pi found nothing at all. Merging it into `process.env` for the duration of the
 * call was rejected — that mutates process state that other extensions read.
 *
 * ## Why this function never throws
 *
 * A corrupt `auth.json` makes pi's credential store reject with a `ModelsError` (measured), and
 * this function is called while an extension is deciding whether to register a tool at all. A
 * throw there would take the whole extension down over one unreadable file. So a failure is
 * reported — a warning, and an explicit "not configured" — and the environment level is still
 * tried, because it does not depend on pi's store.
 *
 * The warning deliberately does NOT quote the upstream error message: pi's own resolution errors
 * can carry the raw text of a `!command` line, and that text is a key-leak surface
 * (`docs/research/pi-credential-surface-20261020.md` §5.2). Only the error's name is logged.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { DEEPSEEK_PROVIDER_ID } from "./contract.ts";

/** The environment variable pi's built-in deepseek provider reads. */
const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

export interface DeepSeekCredential {
  /** The resolved key; `undefined` when nothing is configured. */
  key: string | undefined;
  /** Whether a usable key was found — the key is a non-empty string. */
  configured: boolean;
  /** pi's own label for where the key came from ("stored credential" / "DEEPSEEK_API_KEY" / …). */
  source: string | undefined;
}

/**
 * Resolve the DeepSeek credential out of a pi agent directory.
 *
 * `agentDir` is the directory that holds `auth.json` and `models.json` — the caller passes it
 * rather than this module guessing `~/.pi/agent`, because pi's agent directory is movable
 * (`PI_CODING_AGENT_DIR`) and hard-coding it is a bug that only shows up on someone else's
 * machine (`docs/research/pi-credential-surface-20261020.md` §3.3).
 */
export async function resolveDeepSeekCredential(options: {
  agentDir: string;
  /** The environment level, injectable for tests. Only `DEEPSEEK_API_KEY` is read from it. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where a failed resolution is reported.
   *
   * **Injectable because the caller owns the notice channel.** This package's failures are
   * announced through `ctx.ui.notify(..., "warning")` (the same channel as every other notice
   * here), and a `console.warn` from inside a module would reach the terminal instead of the
   * TUI — where a user running pi would not see it. The default is `console.warn` so a direct
   * library caller still gets told.
   */
  onWarn?: (message: string) => void;
}): Promise<DeepSeekCredential> {
  const envLevel = readEnvLevel(options.env);

  let resolved: { auth: { apiKey?: string | undefined }; source?: string | undefined } | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
      // No catalog refresh: this module reads credentials, and a refresh would turn a local read
      // into a network round trip on the extension's startup path.
      refreshOnCreate: false,
    });
    resolved = await runtime.getAuth(DEEPSEEK_PROVIDER_ID);
  } catch (error) {
    warnCredentialFailure(error, options.onWarn);
  }

  if (resolved) {
    const key = resolved.auth?.apiKey;
    if (typeof key === "string" && key.length > 0) {
      return { key, configured: true, source: resolved.source };
    }
    // pi resolved the provider but produced no usable key. The environment level is NOT tried
    // here: a stored credential owns the provider, and pi's rule is that there is no silent env
    // fallback once something is stored (docs/research/pi-credential-surface-20261020.md §1.3).
    return { key: undefined, configured: false, source: resolved.source };
  }

  if (envLevel !== undefined) {
    // The same label pi gives its own ambient lookup, so a source read here means the same
    // thing as a source read from `getAuth`.
    return { key: envLevel, configured: true, source: DEEPSEEK_API_KEY_ENV };
  }
  return { key: undefined, configured: false, source: undefined };
}

/** The environment level: the injected value first, then the process's own. */
function readEnvLevel(env: NodeJS.ProcessEnv | undefined): string | undefined {
  const injected = env?.[DEEPSEEK_API_KEY_ENV];
  if (typeof injected === "string" && injected.length > 0) return injected;
  const ambient = process.env[DEEPSEEK_API_KEY_ENV];
  return typeof ambient === "string" && ambient.length > 0 ? ambient : undefined;
}

/** Report a failed resolution without quoting the upstream message. See the module header. */
function warnCredentialFailure(error: unknown, onWarn?: (message: string) => void): void {
  const name = error instanceof Error ? error.name : typeof error;
  const message =
    `[pi-ptc] 解析 DeepSeek 凭据失败（${name}），按「未配置」处理；` +
    "未写入错误详情：pi 的解析错误可能带出 !command 的命令行原文。";
  if (onWarn !== undefined) {
    onWarn(message);
    return;
  }
  console.warn(message);
}
