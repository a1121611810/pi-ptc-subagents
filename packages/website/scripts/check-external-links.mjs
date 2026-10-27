#!/usr/bin/env node
/**
 * Report: the status of every external link the built site emits.
 *
 * This is **not a gate**, and the header says so because the distinction is the whole design. ADR-0036
 * keeps external links outside the gates, and that is right: a CI check on `pi.dev` or npm's page
 * fails on someone else's outage and on bot protection — this machine gets **403** from npmjs.com
 * with and without a browser User-Agent. A gate the repository learns to retry past is worse than no
 * gate, because it trains people to ignore red.
 *
 * What was missing was not a check but **visibility**: nothing let a maintainer ask. This is that.
 *
 * It exits 0 under every outcome, including total network failure, and it says so when that happens —
 * a report that quietly returned nothing would be indistinguishable from a report that found
 * nothing.
 *
 * What is already gated elsewhere, and therefore skipped here:
 *   - in-page anchors (`#…`)          — a same-page reference
 *   - root-relative hrefs             — `check-internal-links.mjs`
 *   - repository-absolute hrefs       — the same script resolves them against the working tree
 *
 * Usage: `pnpm --filter website run check:external-links`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DIST = join(HERE, "..", ".vitepress", "dist");

/** This repository's own host: its links are resolved against the working tree by another gate. */
const OWN_HOST = "github.com/a1121611810/pi-ptc-subagents";

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (entry.endsWith(".html")) acc.push(full);
  }
  return acc;
}

/** Everything that is a real outbound URL: no anchors, no site-relative, not our own repository. */
function externalLinks(html) {
  const found = new Map();
  for (const match of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const href = match[1];
    if (href.includes(OWN_HOST)) continue;
    if (!found.has(href)) found.set(href, new Set());
  }
  return found;
}

/** Why a status is what it is, so the report is not just a column of numbers. */
function classify(status) {
  if (status === 0) return "unreachable";
  if (status >= 200 && status < 300) return "ok";
  if (status === 403) return "blocked (bot protection?) — not evidence the page is gone";
  if (status === 429) return "rate limited — retry later, not evidence of a dead link";
  if (status >= 400 && status < 500) return "not found or refused";
  return "server error or redirect chain";
}

async function probe(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "pi-ptc-subagents-external-link-report" },
      signal: AbortSignal.timeout(15_000),
    });
    return response.status;
  } catch {
    return 0;
  }
}

async function main() {
  let files;
  try {
    files = htmlFiles(DIST);
  } catch {
    console.log(`⚠ no build output at ${relative(REPO_ROOT, DIST)} — nothing to report.`);
    console.log("  Build the site first: `pnpm --filter website run build`.");
    process.exit(0);
  }

  const links = new Map();
  for (const file of files) {
    const from = "/" + relative(DIST, file).split(/[\\/]/).join("/");
    for (const href of externalLinks(readFileSync(file, "utf8")).keys()) {
      if (!links.has(href)) links.set(href, new Set());
      links.get(href).add(from);
    }
  }

  const sorted = [...links.keys()].sort(byName);

  if (sorted.length === 0) {
    console.log("⚠ the built site emits no external links — either the extraction broke or none exist.");
    process.exit(0);
  }

  console.log(`External links in the built site: ${sorted.length} across ${files.length} page(s)\n`);

  const unreachable = [];
  for (const href of sorted) {
    const status = await probe(href);
    if (status === 0 || status >= 400) unreachable.push(href);
    console.log(`  ${String(status).padStart(3)}  ${classify(status)}`);
    console.log(`       ${href}`);
    console.log(`       linked from: ${[...links.get(href)].sort(byName).join(", ")}`);
  }

  console.log("");
  if (unreachable.length === 0) {
    console.log(`✓ all ${sorted.length} external link(s) reachable.`);
  } else {
    console.log(`⚠ ${unreachable.length} of ${sorted.length} did not answer cleanly.`);
    console.log("  Read each status above before acting: 403 usually means bot protection rather");
    console.log("  than a dead page. This script does not decide that, and does not fail.");
  }

  // Always zero. This is a report; making it a gate is the failure mode ADR-0036 warns about.
  process.exit(0);
}

main().catch((error) => {
  console.log(`⚠ the report itself failed: ${error.message}`);
  console.log("  Still a zero exit: this is not a gate, and nothing here should block anything.");
  process.exit(0);
});
