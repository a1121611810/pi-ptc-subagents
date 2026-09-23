import { defineConfig } from "vite-plus";

/**
 * Vite+ config for `vp pack` (Phase 2 of ADR-0008).
 *
 * Mirrors `rolldown.config.ts`. The build can be produced by either:
 *   pnpm run build          # rolldown -c rolldown.config.ts  (current default)
 *   pnpm exec vp pack       # via this config                   (Phase 2 candidate)
 *
 * The `outExtensions` callback is required because tsdown (which `vp pack`
 * wraps) bypasses rolldown's `outputOptions.entryFileNames` for ESM/CJS
 * output and runs its own extension table in
 * tsdown/src/features/output.ts:resolveChunkFilename — which pins ESM →
 * `.mjs` and DTS → `.d.mts` whenever `platform: "node"` (the default in
 * this repo). `outExtensions` overrides that table on a per-format basis.
 *
 * Verified on 2026-09-22: with `outExtensions`, `vp pack` produces output
 * byte-identical to `rolldown -c rolldown.config.ts` for this repo
 * (index.js, index.js.map, index.d.ts, index.d.ts.map). See ADR-0008
 * addendum § Build, and docs/research/vp-pack-js-output.md.
 */
export default defineConfig({
  pack: {
    // ADR-0017 §7: rolldown dual-entry — `dist/index.js` is the pi extension
    // entry, `dist/worker.js` is what the host loads for `new Worker(...)`.
    // The worker file lets V8's code cache and Node's module cache survive
    // across warm-reuse spawns (the previous `data:text/javascript,…`
    // bootstrap paid a fresh parse every time). tsdown accepts multiple
    // entries via the `{name: input}` record shape; the per-file output
    // extension is forced to `.js` by the `outExtensions` callback below.
    entry: {
      index: "./src/index.ts",
      worker: "./src/runtime/worker-entry.ts",
    },
    format: ["esm"],
    platform: "node",
    dts: { sourcemap: true },
    sourcemap: true,
    clean: true,
    minify: true,
    // `external` is deprecated in current tsdown — use `deps.neverBundle`.
    //
    // Every `@earendil-works/*` package is provided by the pi runtime, not by this package: pi's
    // extension loader maps the specifier onto its own copy (Node mode: `core/extensions/loader.js`
    // jiti aliases; bundled/compiled mode: `virtual-modules.js` → `VIRTUAL_MODULES`). tsdown already
    // externalises `peerDependencies`, but the list is explicit so a future entry moving to
    // `devDependencies` cannot silently re-inline it.
    //
    // `@earendil-works/pi-tui` was missing from this list until 2026-09-22 (it was a devDependency
    // only, so it was inlined): the build shipped a second copy of the renderer the host was already
    // running, at whatever version this repo pinned, plus pi-tui's own `marked` and
    // `get-east-asian-width` — 184.81 kB → 102.69 kB once externalised. tsdown's "Detected
    // dependencies in bundle" hint is what surfaced it. See ADR-0008's addendum.
    deps: {
      neverBundle: [
        /^node:/,
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-tui",
        "typebox",
      ],
    },
    outExtensions: ({ format }) => (format === "es" ? { js: ".js", dts: ".ts" } : undefined),
  },
});
