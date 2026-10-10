#!/usr/bin/env node
/**
 * Gate: every internal link the built site emits must resolve to a page that
 * was actually built.
 *
 * This exists because a claim in the landing-page commit was wrong. That commit
 * asserted "VitePress fails the build on a dead link, so a broken link cannot
 * reach a published page". That is true of markdown links VitePress parses and
 * false of an `href` written in a Vue template — which is how a link to
 * `/docs/` shipped and 404'd, on a site whose build was green throughout.
 *
 * VitePress's dead-link check is not the guard I said it was, so this is. It
 * reads the emitted HTML, takes every root-relative href, and resolves it
 * against the set of pages that exist in the build output. External links and
 * in-page anchors are out of scope: the first cannot be checked from here, the
 * second is a same-page reference.
 *
 * Exit 1 lists every unresolved href. Silence is not a pass signal — the point
 * of printing the resolved count is that a run with nothing to report is
 * distinguishable from a run that looked at nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const DIST = join(HERE, '..', '.vitepress', 'dist');

/**
 * The site's `base`, mirrored from the VitePress config.
 *
 * Emitted hrefs carry it (`/pi-ptc-subagents/docs/install`) while the build
 * output directory tree does not (`docs/install.html`). Comparing the two
 * without stripping it reports every internal link as broken — which is what
 * the first run of this gate did.
 */
const BASE = '/pi-ptc-subagents/';

/** A path ending in a file extension is an asset, not a page to navigate to. */
const ASSET = /\.[a-z0-9]{2,5}(\?|#|$)/i;

/**
 * Every built HTML file, as a route path.
 *
 * `cleanUrls` is on, so `/docs/install` is served by `docs/install.html`. Both
 * spellings are registered: a link may carry either, and a gate that only
 * understood the one the build happens to emit would report the other as dead.
 */
function builtRoutes(dir, acc = new Set()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) builtRoutes(full, acc);
    else if (entry.endsWith('.html')) {
      const raw = '/' + relative(DIST, full).split(/[\\/]/).join('/');
      const withoutIndex = raw.replace(/(^|\/)index\.html$/, '$1');
      acc.add(withoutIndex);
      acc.add(withoutIndex.replace(/\.html$/, ''));
    }
  }
  return [...acc];
}

/** All HTML files in the build, since a link may live on any page. */
function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (entry.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/**
 * Does `href` name a built page?
 *
 * `cleanUrls` is on, so `/docs/install` is served by `docs/install.html`.
 * A site may legitimately link with or without the trailing slash, so both
 * spellings resolve to the same route.
 */
function resolves(href, routes) {
  let path = href.split('#')[0].split('?')[0];
  if (path === '') return true; // bare "#anchor"
  if (ASSET.test(path)) return true; // stylesheet, script, icon, font
  if (path.startsWith(BASE)) path = '/' + path.slice(BASE.length);
  const candidates = [path, path.endsWith('/') ? path.slice(0, -1) : `${path}/`];
  return candidates.some((c) => routes.includes(c));
}

function main() {
  let files;
  try {
    files = htmlFiles(DIST);
  } catch {
    console.error(`✗ no build output at ${relative(REPO_ROOT, DIST)}`);
    console.error('  This gate reads the build output, so it runs after `vitepress build`.');
    process.exit(1);
  }

  const routes = builtRoutes(DIST);
  if (routes.length === 0) {
    console.error('✗ the build produced no pages — the route set is empty, so nothing can pass.');
    process.exit(1);
  }

  const broken = new Map();

  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const from = '/' + relative(DIST, file).split(/[\\/]/).join('/');
    for (const match of html.matchAll(/href="([^"]*)"/g)) {
      const href = match[1];
      // Skip external, protocol-relative, mailto, and bare-anchor links.
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      if (resolves(href, routes)) continue;
      if (!broken.has(href)) broken.set(href, new Set());
      broken.get(href).add(from);
    }
  }

  if (broken.size > 0) {
    console.error(`✗ ${broken.size} internal link(s) point at pages that were not built:\n`);
    for (const [href, froms] of [...broken].sort()) {
      console.error(`   ${href}`);
      console.error(`      linked from: ${[...froms].join(', ')}`);
    }
    console.error(`\n  built routes: ${routes.sort().join(', ')}`);
    process.exit(1);
  }

  console.log(
    `✓ internal links — ${files.length} page(s), ${routes.length} route(s), nothing dangling`
  );
}

main();
