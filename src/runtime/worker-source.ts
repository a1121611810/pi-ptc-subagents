/**
 * Worker source location.
 *
 * The previous bootstrap assembled a `data:text/javascript,…` URL from
 * `Function.prototype.toString()` of `workerMain` plus a protocol literal —
 * a single self-contained file but with no V8 code-cache reuse across spawns
 * (ADR-0017 §7). The rolldown dual-entry build now emits `dist/worker.js`
 * alongside `dist/index.js`; the host loads that file directly, which lets
 * V8's code cache and Node's module cache survive across warm-reuse spawns.
 *
 * The two candidates the resolver tries:
 *
 * 1. `dist/worker.js` — the rolldown output, sibling of `dist/index.js`. The
 *    production path used by `pi install npm:pi-ptc-subagents`.
 * 2. `src/runtime/worker-entry.ts` — the source, used by `vitest` runs
 *    (vitest's transformer handles `.ts` and the worker is launched in-process
 *    so the relative path resolves).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Resolve the worker entry's `file://` URL.
 *
 * The function takes no arguments: the protocol tables now travel through the
 * worker file itself (rolldown bundles `./protocol.ts` into `dist/worker.js`),
 * so the host has nothing to compose at URL-build time.
 */
export function buildWorkerUrl(): URL {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Production: rolldown outputs `dist/worker.js` next to `dist/index.js`,
    // which is what the host's `import.meta.url` resolves to when it loaded
    // `dist/index.js`.
    resolve(here, "worker.js"),
    // Fallback: the source file in the same directory. Vitest loads
    // `src/runtime/dispatcher.ts` directly (no `dist/` involved), so the
    // worker entry is `src/runtime/worker-entry.ts` and lives beside the
    // host file.
    resolve(here, "worker-entry.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate);
  }
  throw new Error(`worker entry not found; tried: ${candidates.join(", ")}`);
}
