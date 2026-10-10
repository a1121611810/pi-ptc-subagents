#!/usr/bin/env node
/**
 * Gate: what npm actually published is what the manifest said it would.
 *
 * `npm publish` exiting 0 means a tarball was accepted. It does not mean the registry now serves
 * the fields the manifest promised — npm normalises manifests on the way in, and the published
 * copy is what the package page renders. For the `homepage` field that distinction is not
 * academic: #149 repointed `package.json` at the site, and the published `2.0.2` still carries the
 * old `#readme` value, because **the registry serves the published manifest, not the working
 * tree**. The change is real and correct in `main`; it simply has not shipped yet.
 *
 * This reads the published manifest back and compares it field by field, so the release that
 * finally carries a change verifies itself instead of being assumed to have.
 *
 * ## It reports drift honestly rather than passing
 *
 * Run today it reports a difference, because there is one. A check that went green by comparing
 * the working tree to itself would hide exactly what this exists to surface, so the current state
 * is drifted on purpose and the exit code says so.
 *
 * ## Why the workflow step does not fail the publish
 *
 * The publish has already succeeded by the time this runs, and it is irreversible. A red
 * `Publish` run on `main` would read as "the release failed" when it did not. So the step is
 * `continue-on-error` and this script still exits non-zero on drift: the release log carries the
 * signal, and nothing pretends the artifact was verified when it was not.
 *
 * No token is needed — the registry's read endpoints are public.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..");

/**
 * Fields worth comparing.
 *
 * `keywords` and `files` are compared as sets: npm preserves them, but a future normaliser could
 * reorder, and reordering is not drift. Everything else is compared exactly.
 */
const EXACT_FIELDS = ["version", "description", "homepage", "license", "repository"];
const SET_FIELDS = ["keywords"];

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function render(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Structural equality that ignores object key order.
 *
 * A plain `JSON.stringify` comparison reported a false positive on the first run: npm serves
 * `repository` as `{"url":…,"type":…}` while the manifest has the same two keys in the other
 * order. The values are identical and the difference is not drift — npm normalises manifests on
 * the way in, and a normaliser that reorders keys is doing its job, not introducing a defect.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(byName);
  const kb = Object.keys(b).sort(byName);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValue(a[k], b[k]));
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const name = manifest.name;
  if (!name) {
    console.error("✗ package.json has no `name` — there is nothing to look up.");
    process.exit(1);
  }

  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
    headers: { accept: "application/json", "user-agent": "pi-ptc-subagents-check-published" },
  });

  if (!response.ok) {
    console.error(
      `✗ could not read the published manifest: registry answered ${response.status} ${response.statusText}`,
    );
    console.error("  Unverified is not verified — the distinction is the point of this script.");
    process.exit(1);
  }

  const published = await response.json();
  const drifts = [];

  for (const field of EXACT_FIELDS) {
    const a = published[field];
    const b = manifest[field];
    if (!sameValue(a, b)) {
      drifts.push({ field, kind: "differs", published: a, manifest: b });
    }
  }

  for (const field of SET_FIELDS) {
    const a = new Set(published[field] ?? []);
    const b = new Set(manifest[field] ?? []);
    const onlyPublished = [...a].filter((v) => !b.has(v)).sort(byName);
    const onlyManifest = [...b].filter((v) => !a.has(v)).sort(byName);
    if (onlyPublished.length > 0 || onlyManifest.length > 0) {
      drifts.push({ field, kind: "sets differ", onlyPublished, onlyManifest });
    }
  }

  console.log(`  registry: ${name}@${published.version}`);
  console.log(`  manifest: ${name}@${manifest.version} (this checkout)`);

  if (drifts.length > 0) {
    console.error(
      `\n✗ ${drifts.length} field(s) differ between the manifest and what npm serves:\n`,
    );
    for (const d of drifts) {
      if (d.kind === "differs") {
        console.error(`   ${d.field}`);
        console.error(`      published: ${render(d.published)}`);
        console.error(`      manifest:  ${render(d.manifest)}`);
      } else {
        console.error(`   ${d.field}`);
        if (d.onlyPublished.length)
          console.error(`      only published: ${d.onlyPublished.join(", ")}`);
        if (d.onlyManifest.length)
          console.error(`      only manifest:  ${d.onlyManifest.join(", ")}`);
      }
    }
    console.error(
      "\n  The registry serves the *published* manifest, so a change lands there when a version\n" +
        "  carrying it is published — not when it is merged. This is expected between releases;\n" +
        "  it is unexpected immediately after one.",
    );
    process.exit(1);
  }

  console.log(
    `\n✓ published manifest agrees — ${EXACT_FIELDS.length + SET_FIELDS.length} field(s) compared`,
  );
}

main().catch((error) => {
  console.error(`✗ could not verify the published manifest: ${error.message}`);
  process.exit(1);
});
