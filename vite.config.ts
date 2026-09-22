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
    entry: ["./src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: { sourcemap: true },
    sourcemap: true,
    clean: true,
    // `external` is deprecated in current tsdown — use `deps.neverBundle`.
    deps: {
      neverBundle: [
        /^node:/,
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-ai",
        "typebox",
      ],
    },
    outExtensions: ({ format }) => (format === "es" ? { js: ".js", dts: ".ts" } : undefined),
  },
});
