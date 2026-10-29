#!/usr/bin/env node
/**
 * Gate: every internal link the built site emits must survive VitePress's
 * client-side router — not just exist on disk.
 *
 * Why this exists, in one story. The Status link pointed at a real file
 * (`public/status/ptc-runtime-status.html`), `check-internal-links` passed, curl
 * answered 200 — and clicking it rendered a 404 page, three times across one
 * afternoon. VitePress's router intercepts same-origin clicks whose pathname
 * "looks like a page" (`.html` or extensionless; `treatAsHtml` in
 * `node_modules/vitepress/dist/client/shared.js`) and navigates client-side
 * against its route manifest. Files in `public/` are copied into the build but
 * never enter the manifest, so the interception ends in a client-side 404 —
 * while every static signal stays green: the file exists (link gate), the server
 * answers 200 with the fallback document (sirv's SPA fallback hides 404s from
 * curl), the build is green.
 *
 * The only escapes the router honours are checked here as the "bypass" set,
 * straight from `router.js`'s click handler: a `target` attribute, a `download`
 * attribute, or an ancestor (or self) `.vp-raw` class.
 *
 * What it checks: for every `<a>` in every built HTML page, if the href is
 * same-origin and would be intercepted, then either the path must be a real
 * VitePress route (from `dist/hashmap.json` — the same manifest the router
 * navigates against) or the anchor must carry a bypass. Everything else is
 * reported. This is the check that would have caught all three Status 404s.
 *
 * Note it is intentionally a *narrower* claim than "the link works": a link to
 * a VP route whose page crashes is out of scope. This gate exists for the class
 * of bug the other four cannot see.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const DIST = join(HERE, '..', '.vitepress', 'dist');
const BASE = '/pi-ptc-subagents/';

/** VitePress's route manifest: the same set the client router resolves against. */
function routeSet() {
  const hashmap = JSON.parse(readFileSync(join(DIST, 'hashmap.json'), 'utf8'));
  const routes = new Set();
  for (const key of Object.keys(hashmap)) {
    const stem = key.replace(/\.md$/, '');
    // Keys flatten the docs directory into the key: `docs_run-one-program` is
    // the route `docs/run-one-program`. The site's own pages are `index`/`readme`.
    if (stem === 'index' || stem === 'readme') {
      routes.add('');
      continue;
    }
    const slash = stem.indexOf('_');
    routes.add(slash === -1 ? stem : stem.slice(0, slash) + '/' + stem.slice(slash + 1));
  }
  return routes;
}

/** Every built HTML file, relative paths. */
function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (entry.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/** treatAsHtml, narrowed to what a pathname can look like on this site. */
function intercepted(pathname) {
  const last = pathname.split('/').pop();
  if (last === '') return true; // directory index
  if (last.includes('.')) return last.endsWith('.html');
  return true;
}

/** The router's bypass conditions, from router.js's click handler. */
function bypassed(tag) {
  return /target=/.test(tag) || /download/.test(tag) || /vp-raw/.test(tag);
}

function main() {
  if (!existsSync(join(DIST, 'hashmap.json'))) {
    console.error(`✗ no build output at ${relative(REPO_ROOT, DIST)}\n`);
    console.error('  This check reads the built site, so it runs after `vitepress build`.');
    process.exit(1);
  }
  const routes = routeSet();
  const bad = [];

  for (const file of htmlFiles(DIST)) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)) {
      const tag = m[0];
      const href = m[1];
      if (href.startsWith('#') || href.startsWith('mailto:')) continue;
      if (!href.startsWith(BASE)) continue; // external or non-page
      let path = href.slice(BASE.length).split('#')[0].split('?')[0];
      if (!intercepted(path)) continue; // asset, not a page
      if (bypassed(tag)) continue;

      const candidates = [path];
      if (path.endsWith('.html')) candidates.push(path.slice(0, -'.html'.length));
      if (path.endsWith('/')) candidates.push(path + 'index', path.slice(0, -1));
      if (path === '') candidates.push('');
      const isRoute = candidates.some((c) => routes.has(c));
      if (!isRoute) bad.push(`${relative(DIST, file)}  ->  ${href}`);
    }
  }

  if (bad.length > 0) {
    console.error('✗ these internal links are intercepted by the VP router but resolve to no route:\n');
    for (const b of [...new Set(bad)].sort()) console.error(`   ${b}`);
    console.error(
      '\n  The click will render a client-side 404. Fix one of:\n' +
        '    - link to a real route (a projected/markdown page), or\n' +
        '    - add target="_blank" (nav items), class="vp-raw" (template links),\n' +
        '      or move the target into the route manifest.',
    );
    process.exit(1);
  }

  console.log(`✓ router links — every intercepted internal link resolves to a VP route or carries a bypass`);
}

main();
