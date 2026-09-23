# Build pipeline: enable minification + exclude source maps from npm tarball

Two changes land together because they share a single concern — the shape of the npm tarball — and reversing one without the other would re-introduce the leak. They are deliberately narrow: every public export keeps its original name, every sourcemap stays on disk for local stack traces, and the build pipeline otherwise runs as ADR-0008 left it (`vp pack` driving `vite.config.ts#pack`, with the `outExtensions` callback that pins `.js` / `.ts`).

The user-visible trigger was a report that `pnpm run build` "didn't compress". The build _was_ compressing in the loose sense — `vp pack` had aliased the import bindings to single letters — but it never ran a minifier over function bodies, so the `dist/*.js` files looked like the source with renamed imports. `dist/index.js` was 3047 lines / 128 kB at v0.1.2; the function bodies kept JSDoc, source-section comments, and readable variable names. The npm tarball then shipped ~324 kB of source maps on top of that — ~60% of the unpacked payload (548.6 kB) — that no npm consumer can use.

Status: accepted (2026-09-23). Driver: tarball hygiene; downstream (`pi install npm:pi-ptc-subagents`) sees no API change.

## Decision

**1. §1 · `vite.config.ts#pack.minify` is set to `true`.** This is the boolean form of rolldown's `output.minify` (`boolean | "dce-only" | MinifyOptions`), and tsdown forwards it verbatim (`minify: !cjsDts && minify` in `@voidzero-dev/vite-plus-core/dist/tsdown/build-*.js`). The default in tsdown is `?? false` — the current state of the repo, hence the half-minified output. With `minify: true`, rolldown's built-in oxc-based minifier runs. **No new dependency** is required; rolldown 1.2.9 (already a transitive devDependency through vite-plus) ships the minifier. `MinifyOptions` is not needed — none of the codebase uses `mangleProps`, prebuilt CommonJS, or other patterns that would justify fine-tuning.

Concretely on this repo:

| file                 | before                 | after               | Δ           |
| -------------------- | ---------------------- | ------------------- | ----------- |
| `dist/index.js`      | 3047 lines / 127,886 B | 30 lines / 43,834 B | −99% / −66% |
| `dist/worker.js`     | 714 lines / 28,698 B   | 3 lines / 7,653 B   | −99% / −73% |
| `dist/protocol-*.js` | 106 lines / 4,719 B    | 1 line / 2,472 B    | −99% / −48% |
| `*.js` total         | 161,303 B              | 53,959 B            | −66.5%      |

The numbers above are ungzipped raw bytes; gzip (which npm publishes with) is roughly ⅓ of those on each side — the percentage is what matters.

All 39 public exports retain their original names. Verified by `Object.keys(await import("./dist/index.js"))` — the set is identical before and after. No downstream consumer (pi runtime, dispatch callers, the test surface that loads `dist/` under a real `pi`) is affected.

**2. §2 · `package.json#files` is a whitelist, not the previous `["dist", …]`.** Specifically:

```json
"files": [
  "dist/**/*.js",
  "dist/**/*.d.ts",
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
]
```

This filters the publication step only — `pnpm run build` still produces every `dist/*` file, and `dist/*.js.map` + `dist/*.d.ts.map` continue to land on disk for local stack-trace resolution. What changes is that `npm pack` no longer carries them.

Concretely:

|                                                   | packed      | unpacked     | files |
| ------------------------------------------------- | ----------- | ------------ | ----- |
| v0.1.2 baseline (no minify, `files: ["dist", …]`) | 168.7 kB    | 548.6 kB     | 13    |
| after §1 + §2                                     | **40.5 kB** | **113.6 kB** | **9** |
| Δ                                                 | **−76%**    | **−79%**     | −4    |

`npm pack --dry-run` on the committed state lists exactly 9 entries: 6 `dist/*.{js,d.ts}` + README + LICENSE + CHANGELOG + `package.json`. **Zero `*.map` files** in the npm payload. The build-side sourcemap settings (`dts.sourcemap: true`, `sourcemap: true` on `vite.config.ts#pack`) stay unchanged.

**3. §3 · Sourcemap semantics split.** The previous state conflated two meanings:

- "Build emits sourcemaps for the dist" — _true_, and still true. Required by every developer who runs the extension against a real `pi` and reads a stack trace.
- "npm tarball carries sourcemaps" — _true_, and useless. An `npm install` consumer cannot resolve a stack trace against a sourcemap that lives in their `node_modules`, because pi loads `dist/index.js` directly and Node's stack is in the minified symbols regardless.

`vite.config.ts` now carries a 3-line comment cross-linking the `minify: true` line and the `package.json#files` whitelist to this ADR, so the two halves of the change stay discoverable together. The map's bundle-hash naming (`dist/protocol-<hash>.js`) is unchanged by minification — rolldown's chunk hashing is independent of the minifier pass.

## Consequences

- `pi install npm:pi-ptc-subagents` behaviour is unchanged. Every exported symbol resolves to the same name. The `package.json#pi.extensions` manifest is untouched. The package's public type surface (`dist/index.d.ts`) is identical and ungzipped only slightly smaller (29.3 kB vs 27.5 kB — d.ts isn't minified and the line-count difference comes from tsdown's formatting, not semantic change).
- Local development: `pnpm run build` followed by `node --inspect-brk ./dist/index.js` still resolves stack frames back to source via `dist/*.js.map`. Verified by the existing `tests/tool-visibility.test.ts` (it loads the built dist under a real `pi`, asserts both PTC tools register, and the sourcemap resolution happens transparently through Node's source-map support).
- The tarball is now publication-shape-only — every byte in it is something an npm consumer can use. The 4 file-count drop (13 → 9) reflects the 5 map files removed.
- Future entry additions: if a future ticket adds a fourth entry beyond `index` / `worker` / `protocol-*`, the `dist/**/*.js` / `dist/**/*.d.ts` whitelist does not need to change (it is glob-shaped). If a future ticket adds a sibling artifact (e.g. a CLI shim that needs `package.json`-shape data), it has to land in the whitelist explicitly.

## Considered options

- **Disable sourcemap generation entirely (`dts.sourcemap: false`, `sourcemap: false`).** Rejected: the sourcemap is the only way to debug a dist-built extension under a real `pi`. Stack traces from `tests/tool-visibility.test.ts`-shaped probes and from end-user reports both lean on it. Excluding the map from the tarball is a stronger tool here — keep the map on disk, just don't publish it.
- **Split the build into `dist/` (published) + `dist-internal/` (maps only).** Rejected: doubles the directory count, complicates `verify:dist` and the test surface, and buys nothing the whitelist doesn't already give. The whole point is that maps stay next to the JS for the developer's convenience.
- **Switch the minifier from rolldown's built-in oxc minifier to esbuild / terser / swc.** Rejected: `minify: true` already gets us −66% / −99% lines with zero new dependency. The esbuild toolchain the rolldown binding talks to is the same one oxc reaches for; swapping would either duplicate a dep we already have transitively or trade known-good output for an unknown one.
- **Set `output.minify: "dce-only"` instead of `true`.** Considered: DCE-only preserves string literals and property names, which would keep `tool_name` strings readable in the bundle. Rejected because the surface where it matters (the `pi.dispatch` child-process protocol, where `kind: "result"` strings cross an IPC boundary) is already keyed by imported enum names that the rolldown bundler inlines as string literals either way — `dce-only` would change the file but not the wire format.
- **Introduce a tarball-size budget / CI fail-gate on `npm pack --dry-run`.** Rejected by the user during chart (wayfinder map #32, 2026-09-23): a permanent gate on a number is the kind of policy that decays, and the chart explicitly preferred "build the right thing, don't police it". Revisit if a future regression surfaces.
- **Keep the comment-only cross-link, write no ADR.** Rejected per the ADR-three-criteria test: the decision is _hard to reverse_ (the whitelist change re-introduces ~324 kB of payload silently, and reverting `minify: true` makes the next `pnpm run build` look like the v0.1.2 baseline), _surprising without context_ (a future maintainer who finds `minify: true` and a no-map `files` array without the link will assume they're independent edits), and _the result of a real trade-off_ (the chosen minifier, the chosen schema value, and the split of "build emits / npm ships" all have alternatives).

## See also

- ADR-0008 — toolchain adoption (`vite-plus` + `pnpm`); §Addendum records the `outExtensions` callback that forces `.js` / `.ts` and the `deps.neverBundle` list that keeps `@earendil-works/*` external. §Addendum was the right place for the `pi-tui` externalisation correction; this ADR is the right place for the `minify` + `files` shape because it is publication-state, not build-mechanics.
- ADR-0017 — worker pool per turn; explains why `dist/worker.js` exists as a separate entry, which is why the minify pass has to cover both `index.js` and `worker.js` (and the shared `protocol-*.js` chunk).
- ADR-0018 — release path (tag-triggered OIDC publishing); the tarball whose shape §2 fixes is the same tarball that the OIDC workflow publishes. No change to the release act itself.

## Verification

All three landed commits are reproducible from a clean checkout:

```
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit                         # 0 errors
pnpm run build                                 # 9 files, 416.48 kB total
pnpm test                                      # 22 files / 298 tests pass
node scripts/verify-dist-render.mjs           # 24/24 checks pass
npm pack --dry-run                             # 9 entries, 0 *.map files
```

Public-export invariant:

```
node -e 'import("./dist/index.js").then(m => console.log(Object.keys(m).length))'
# 39
```

The minified `dist/index.js` exposes exactly the 39 symbols `dist/index.d.ts` declares, in the same names.
