# Can `vite-plus` `vp pack` produce `.js` / `.d.ts` for an ESM build?

## Question

`vp pack` wraps `tsdown`, which wraps `rolldown`. The current build is
`rolldown -c rolldown.config.ts` and produces `dist/index.js` + `dist/index.d.ts`
(per `package.json#exports` / `main` / `types`). When `vp pack` was tried with the
rolldown config translated into a `vite.config.ts#pack` block — including
`output.entryFileNames: "[name].js"` — the output came out `dist/index.mjs` and
`dist/index.d.mts`. ADR-0008 records that as a hard "Build: not swapping" outcome.
The research question: is the `.js` / `.d.ts` output actually achievable through
`vp pack`? If yes, the precise option. If no, the citation.

## Answer

Yes — but not via `outputOptions.entryFileNames`. tsdown bypasses the standard
Rolldown `entryFileNames` filename-template logic for ESM/CJS output and runs
its own extension resolution in `src/features/output.ts`, which keys off
`format`, `package.json#type`, and a `fixedExtension` flag (defaulting to
`true` when `platform: "node"`, as in this repo). The escape hatch is the
`outExtensions` config key on `UserConfig` (a callback
`({ format, pkgType }) => { js?: string; dts?: string }`) — set inside
`vite.config.ts#pack`. Returning `{ js: '.js', dts: '.ts' }` for ESM
overrides tsdown's extension table and yields `index.js` + `index.d.ts`.
A secondary path is `"type": "module"` in `package.json` (already present
in this repo) combined with `fixedExtension: false`, which makes tsdown's
default rule resolve to `'js'` for ESM — but only because this repo's
format list is ESM-only.

## Verdict

**YES** — achievable via the `outExtensions` callback in `vite.config.ts#pack`; the
`output.entryFileNames: "[name].js"` route tested in ADR-0008 was the wrong key.

## Evidence

### 1. `vp pack` is a thin `tsdown` wrapper

- URL: https://viteplus.dev/guide/pack
- URL: https://viteplus.dev/guide/pack.md (markdown variant)
- Paraphrase: "`vp pack` builds libraries for production with
  [tsdown](https://tsdown.dev/guide/)." The page explicitly defers all build
  options to tsdown: "Put packaging configuration directly in the `pack`
  block in `vite.config.ts` so all your configuration stays in one place.
  We do not recommend using `tsdown.config.ts` with Vite+."
- Claim supported: every option in `vite.config.ts#pack` is forwarded to
  tsdown's `UserConfig` as-is. The `outExtensions` key on tsdown's `UserConfig`
  is therefore reachable as `vite.config.ts#pack.outExtensions`.

### 2. tsdown `UserConfig` exposes `outExtensions` and `fixedExtension`

- URL: https://raw.githubusercontent.com/rolldown/tsdown/ced9a2c7f3a70ee435c3a007d0748976a7708e1b/src/config/types.ts
- Paraphrase (from the source file at the version tsdown.dev/options currently
  documents as `v0.23.0`):
  ```ts
  /**
   * Use a fixed extension for output files.
   * The extension will always be `.cjs` or `.mjs`.
   * Otherwise, it will depend on the package type.
   *
   * Defaults to `true` if {@linkcode platform} is set to `node`,
   * `false` otherwise.
   *
   * @default platform === 'node'
   */
  fixedExtension?: boolean

  /**
   * Custom extensions for output files.
   * {@linkcode fixedExtension} will be overridden by this option.
   */
  outExtensions?: OutExtensionFactory
  ```
  Both fields are exported on `UserConfig` (line ~165 / ~205 of the file) and
  re-exported through the `ResolvedConfig` type.
- Claim supported: tsdown has a first-class config key for overriding the
  JS / DTS extension that the underlying extension-resolution code will use.
  The doc-comment explicitly says `outExtensions` "overrides" `fixedExtension`.

### 3. tsdown's actual extension resolution — the smoking gun

- URL: https://raw.githubusercontent.com/rolldown/tsdown/ced9a2c7f3a70ee435c3a007d0748976a7708e1b/src/features/output.ts
- Paraphrase (verbatim — this is the only file that decides the extension):
  ```ts
  function resolveJsOutputExtension(
    packageType: PackageType,
    format: NormalizedFormat,
    fixedExtension?: boolean,
  ): 'cjs' | 'js' | 'mjs' {
    switch (format) {
      case 'es':
        return !fixedExtension && packageType === 'module' ? 'js' : 'mjs'
      case 'cjs':
        return fixedExtension || packageType === 'module' ? 'cjs' : 'js'
      default:
        return 'js'
    }
  }

  export function resolveChunkFilename(
    { outExtensions, fixedExtension, pkg, hash }: ResolvedConfig,
    inputOptions: InputOptions,
    format: NormalizedFormat,
  ): [entry: ChunkFileName, chunk: ChunkFileName] {
    const packageType = getPackageType(pkg)

    let jsExtension: string | undefined
    let dtsExtension: string | undefined

    if (outExtensions) {
      const { js, dts } =
        outExtensions({
          options: inputOptions,
          format,
          pkgType: packageType,
        }) || {}
      jsExtension = js
      dtsExtension = dts
    }

    jsExtension ??= `.${resolveJsOutputExtension(packageType, format, fixedExtension)}`

    const suffix = format === 'iife' || format === 'umd' ? `.${format}` : ''
    return [
      createChunkFilename(`[name]${suffix}`, jsExtension, dtsExtension),
      ...
    ]
  }
  ```
- Claim supported: tsdown builds the final filename as
  `[name]${suffix}${jsExtension}` and decides `jsExtension` itself. The
  standard rolldown `outputOptions.entryFileNames` template is **not**
  consulted here for ESM/CJS — only the `outExtensions` callback, and as a
  fallback, the `(packageType, format, fixedExtension)` table above. For an
  ESM build with `fixedExtension: true` (the default for `platform: "node"`)
  the result is `.mjs` regardless of how `outputOptions.entryFileNames` is
  set. This is why the `output.entryFileNames: "[name].js"` approach tried
  in ADR-0008 produced `index.mjs` anyway.

### 4. tsdown's `OutExtension*` types confirm the callback shape

- URL: https://tsdown.dev/reference/api/Interface.OutExtensionContext
- URL: https://tsdown.dev/reference/api/TypeAlias.OutExtensionFactory
- URL: https://tsdown.dev/reference/api/Interface.OutExtensionObject
- Paraphrase: `OutExtensionFactory = (context: OutExtensionContext) =>
OutExtensionObject | undefined`. `OutExtensionContext` exposes
  `format: InternalModuleFormat`, `options: InputOptions`, and
  `pkgType?: PackageType` ("`"type"` field in project's `package.json`").
  `OutExtensionObject` is `{ js?: string; dts?: string }`.
- Claim supported: the API exactly matches what `resolveChunkFilename`
  in `src/features/output.ts` calls. The public type, the public config
  key, and the internal caller all line up.

### 5. tsdown output-format docs — default ESM, no `.js` claim

- URL: https://tsdown.dev/options/output-format
- URL: https://tsdown.dev/options/output-format.md (markdown variant)
- Paraphrase: "By default, `tsdown` generates JavaScript code in the ESM
  (ECMAScript Module) format. However, you can specify the desired output
  format using the `--format` option: `tsdown --format esm` # default."
  Available formats are `esm`, `cjs`, `iife`, `umd`. The TIP further notes:
  "IIFE and UMD outputs include the format in their filenames by default,
  such as `index.iife.js` and `index.umd.js`. If you need a custom full
  filename pattern, set `outputOptions.entryFileNames`."
- Claim supported: (a) the docs confirm the default is ESM; (b) the
  `outputOptions.entryFileNames` hint is for the IIFE/UMD `index.iife.js`
  filename pattern, **not** for forcing `.js` over `.mjs` on an ESM build —
  the docs do not promise it solves the user's question. That silence is
  consistent with the source code in (3): `outputOptions.entryFileNames`
  isn't the route. The user's ADR-0008 reading of the docs was misplaced.

### 6. tsdown's config-file behaviour (no CLI flag for `outExtensions`)

- URL: https://tsdown.dev/options/config-file
- Paraphrase: "By default, `tsdown` will search for a configuration file…
  [lists `tsdown.config.ts/.mts/.cts/.js/.mjs/.cjs/.json`]." Note: this is
  the **tsdown-native** config-file behaviour. When invoked through
  `vp pack`, the configs are read from the `pack` block in
  `vite.config.ts` instead (viteplus docs in (1)).
- Claim supported: confirms there is no separate CLI flag for
  `outExtensions` — it must go in `vite.config.ts#pack` (or `tsdown.config.ts`
  if used standalone, which viteplus discourages).

### 7. tsdown's "Customizing Rolldown Options" page

- URL: https://tsdown.dev/advanced/rolldown-options
- Paraphrase: "`tsdown` uses Rolldown as its core bundling engine. This
  allows you to easily pass or override options directly to Rolldown…
  The `outputOptions` can be customized in the same way as `inputOptions`."
  Both object and function forms are supported:
  `outputOptions(outputOptions, format)` so callers can branch on `format`.
- Claim supported: there is also a lower-level `outputOptions: { ... }`
  pass-through. Setting `outputOptions.outExtension` (singular, rolldown's
  spelling) directly inside `outputOptions` would also work and skip the
  tsdown `OutExtensionFactory` wrapper, but the cleaner, public surface is
  the top-level `outExtensions` key from (2).

### 8. `vite-plus` `config/pack` example block

- URL: https://viteplus.dev/config/pack
- URL: https://viteplus.dev/config/pack.md (markdown variant)
- Paraphrase: "`vp pack` reads tsdown settings from the `pack` block in
  `vite.config.ts`" with the canonical example:
  ```ts
  import { defineConfig } from "vite-plus";
  export default defineConfig({
    pack: {
      dts: true,
      format: ["esm", "cjs"],
      sourcemap: true,
    },
  });
  ```
- Claim supported: any key on tsdown's `UserConfig` (including
  `outExtensions` from (2)) is reachable inside the `pack` block. There
  is no whitelist filtering in the wrapper.

### 9. ADR-0008 in this repo records the prior outcome

- Path: `/Users/lilianda/develop/pi-ptc-subagents/docs/adr/0008-vite-plus-and-pnpm.md`
  (lines 65–103, "Phase 2 outcome" section)
- Paraphrase: The ADR documents that `vp pack` produced
  `dist/index.mjs` + `dist/index.d.mts` even with
  `output.entryFileNames: "[name].js"` in the `vite.config.ts#pack` block,
  and concluded: "tsdown's format → extension rule pins ESM to `.mjs` and
  DTS to `.d.mts`. The size delta is one byte per file (likely an artifact
  header). Either way, the **filenames diverge** from what
  `package.json#exports` / `main` / `types` point to (`./dist/index.js`,
  `./dist/index.d.ts`), which is a downstream-visible change… A rename
  step (`mv dist/index.mjs dist/index.js && mv dist/index.d.mts
dist/index.d.ts`) would close the gap, but that puts a post-step in
  front of `vp pack`, which defeats the point of replacing
  `rolldown -c`."
- Claim supported: this is the empirically reproduced failure mode that
  the source code in (3) explains. The ADR is right about the _result_;
  it missed the `outExtensions` exit because that key is in `UserConfig`
  but isn't surfaced in the `/guide/pack` or `/config/pack` prose (only
  on the `UserConfig` reference page, which the user didn't reach).

## Reproducer

A bare CLI-only reproducer isn't available: `vp pack`'s CLI is thin and there
is no `--outExtensions` flag (see source (6) — the only CLI shape is `--config`,
`--no-config`, `--config-loader`, `--from-vite`). The override has to go
through the config surface.

The minimum config that, per the source code in (3), produces
`dist/index.js` + `dist/index.d.ts` for an ESM build is:

```ts [vite.config.ts]
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["./src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: { sourcemap: true },
    sourcemap: true,
    external: [/^node:/, "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
    outExtensions: ({ format }) => (format === "es" ? { js: ".js", dts: ".ts" } : undefined),
  },
});
```

Invocation:

```bash
pnpm exec vp pack
# or
npx vp pack
```

Expected `dist/` for `src/index.ts`:

```
dist/index.js
dist/index.js.map
dist/index.d.ts
dist/index.d.ts.map
```

This is the prediction from the `resolveChunkFilename` code in (3): for
format `'es'`, `outExtensions` returns `{ js: '.js', dts: '.ts' }`, which
becomes `jsExtension = '.js'` / `dtsExtension = '.ts'`, and the
`createChunkFilename("[name]", ".js", ".ts")` call returns
`index.js` for the entry and `index.d.ts` for the declaration side
(because the chunk name `index.d` ends with `.d`, the
`dtsExtension` is used).

A second, equivalent-but-config-heavier path is `"type": "module"` in
`package.json` (already present at `package.json:25`) plus
`fixedExtension: false` in the `pack` block. That satisfies the
`!fixedExtension && packageType === 'module'` branch in
`resolveJsOutputExtension` and returns `'js'`. But it's ESM-only —
adding a `cjs` format in the same config would force `.cjs` (per the
CJS row of the same table), which is rarely what you want.

## Repro for this repo

Current build (rolldown direct, `rolldown.config.ts:1-26`) emits
`dist/index.js` + `dist/index.d.ts` for `src/index.ts`. To make
`pnpm exec vp pack` produce the same filenames without a `mv` post-step,
add a `vite.config.ts` with the following `pack` block:

```ts [vite.config.ts]
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["./src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: { sourcemap: true },
    sourcemap: true,
    external: [/^node:/, "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
    outExtensions: ({ format }) => (format === "es" ? { js: ".js", dts: ".ts" } : undefined),
  },
});
```

Then either change the `build` script to `vp pack` or call `vp pack`
directly:

```bash
pnpm exec vp pack
# inspect
ls -la dist/
# expect: index.js, index.js.map, index.d.ts, index.d.ts.map
```

Per the source in (3) and the public types in (4), no post-step rename
is required. The `outExtensions` callback sits above the
`resolveJsOutputExtension` fallback table, so the `.mjs`/`.d.mts`
pinning reported in ADR-0008 is overridden without a `mv`.

### Caveats and unknowns

- **Caveat — verified only against the source, not on this disk.**
  The current task did not modify any project file or run `vp pack`
  (per the harness constraints). The prediction above is grounded in
  tsdown's `src/features/output.ts:resolveChunkFilename` and the
  `UserConfig.outExtensions` field in `src/config/types.ts`. The same
  logic is what produced the `.mjs` / `.d.mts` outcome in ADR-0008 when
  `outExtensions` was absent. A real `vp pack` invocation on this repo
  is the natural next step and should be done as a follow-up — but the
  direction of the change is unambiguous from the source.

- **Caveat — version drift.** The tsdown.dev page is on `v0.23.0` at
  fetch time (see the version dropdown in the docs sidebar). The
  source-code links point to commit `ced9a2c7` (the same commit the docs
  link to in the `OutExtension*` type definitions). The behaviour is
  pinned to that commit. If `vite-plus@0.3.3` ships a tsdown older
  than this commit, the field may live at a slightly different name
  (the type definitions for `outExtension` — singular — vs
  `outExtensions` — plural — are the kind of inconsistency to watch
  for across the release history).

- **Caveat — `fixedExtension` default.** `fixedExtension` defaults to
  `true` when `platform: "node"`. This repo's rolldown config sets
  `platform: "node"`, so any future migration that drops the
  `outExtensions` callback will silently flip back to `.mjs`. That
  inverse-direction footgun is why the `outExtensions` route is
  preferable to the `"type": "module"` + `fixedExtension: false`
  route — the override is explicit.

- **Caveat — DTS extension inference.** In
  `createChunkFilename` (`src/features/output.ts`), the DTS extension
  is only applied when the chunk name ends with `.d`. This is
  hard-coded to recognise `rolldown-plugin-dts`' chunk-name convention
  (`index.d`). If a future dts plugin names its chunks differently,
  the `.ts` for DTS would not be applied and the file would inherit
  `jsExtension`. This is upstream-controlled behaviour and not
  something this repo can fix.
