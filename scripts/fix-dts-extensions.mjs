#!/usr/bin/env node
/**
 * Rewrite relative `.ts` specifiers inside the emitted declaration files to `.js`.
 *
 * Why this exists: our source uses `.ts`-extension relative imports (required by Node's
 * native type stripping, which the test runner relies on), and TypeScript 7 emits those
 * specifiers verbatim into `.d.ts` output — `rewriteRelativeImportExtensions` rewrites
 * JavaScript output only, not declarations (verified with a minimal repro on 7.0.2).
 * Consumers resolve `./x.js` to the sibling `x.d.ts` (standard TypeScript behavior), so
 * this rewrite is what makes the shipped declarations consumable.
 *
 * Runs after `tsc -p tsconfig.build.json`; fails loudly if any relative `.ts` specifier
 * survives, so a future tooling change cannot silently ship broken declarations.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

const files = readdirSync(dist, { recursive: true })
  .filter((name) => typeof name === "string" && name.endsWith(".d.ts"))
  .map((name) => join(dist, name))
  .sort();

const SPECIFIER = /(["'])(\.{1,2}\/[^"']+)\.ts\1/g;

let changed = 0;
let replacements = 0;

for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(SPECIFIER, (_match, quote, specifier) => {
    replacements += 1;
    return `${quote}${specifier}.js${quote}`;
  });
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
  }
}

const leftovers = files.filter((file) => SPECIFIER.test(readFileSync(file, "utf8")));
if (leftovers.length > 0) {
  console.error(`fix-dts-extensions: relative .ts specifiers remain in:\n  ${leftovers.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `fix-dts-extensions: ${replacements} specifier(s) rewritten across ${changed} file(s) (scanned ${files.length} declarations)`,
);
