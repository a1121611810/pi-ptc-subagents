#!/usr/bin/env node
/**
 * Project the repository's documentation onto the site.
 *
 * The documents this publishes are read from the repository at build time
 * and written into the site's source tree, which is gitignored. There is no
 * committed copy and nothing to keep in sync: the only way to change what the
 * site says about a dispatch door is to edit its booklet under
 * `packages/routes/docs/routes/` (the model-facing prose single source,
 * ADR-0013), or `docs/pi-version-matrix.md` for the version matrix.
 *
 * Two living status panoramas (`docs/prototypes/ptc-runtime-status.html` and
 * `dispatch-engine-status.html`) are copied verbatim into `public/status/`,
 * also gitignored, for the same reason: the repository holds the only copy.
 *
 * A copy that someone edits is the failure this replaces. Two documents that
 * say almost the same thing do not stay almost the same thing.
 *
 * Three rewrites happen on the way through, and they are different rewrites:
 *
 *   ../adr/NNNN-x.md      →  an absolute URL into the repository. The ADRs are
 *                             decision records for contributors, not usage
 *                             documentation, and several carry a withdrawn
 *                             status — publishing them would let a reader take
 *                             a retired decision for a current design.
 *   ../../GLOSSARY.md      →  same, for the glossary.
 *   ./sibling.md          →  a site-internal route, because both documents are
 *                             projected and the reader should stay on the site.
 *
 * Anything else that is still relative after those passes is left alone on
 * purpose. VitePress fails the build on a dead internal link, so a shape this
 * script does not understand becomes a red build rather than a silent 404.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const OUT_DIR = join(HERE, '..', 'docs');
const PUBLIC_STATUS = join(HERE, '..', 'public', 'status');

const REPO_URL = 'https://github.com/a1121611810/pi-ptc-subagents';
const BLOB = `${REPO_URL}/blob/main`;

/** source path (repo-relative) → { slug, title, blurb, order } */
const DOCUMENTS = [
  {
    source: 'packages/routes/docs/routes/run-one-program.md',
    slug: 'run-one-program',
    title: 'Run one program',
    blurb: 'One `ptc_run_code` program, many tool calls: the binding table and what comes back.',
    order: 1,
  },
  {
    source: 'packages/routes/docs/routes/run-a-phased-workflow.md',
    slug: 'run-a-phased-workflow',
    title: 'Run a phased workflow',
    blurb: '`ptc_workflow`: `workflow.log` / `phase` / `parallel` / `pipeline` for staged batch work.',
    order: 2,
  },
  {
    source: 'packages/routes/docs/routes/create-a-task.md',
    slug: 'create-a-task',
    title: 'Create a task',
    blurb: 'The two dispatch doors — `pi_task_ptc` in a program, `pi_task_codemode` in a codemode script.',
    order: 3,
  },
  {
    source: 'packages/routes/docs/routes/manage-a-task.md',
    slug: 'manage-a-task',
    title: 'Manage a task',
    blurb: 'List, read and stop: `ptc_task_list` / `ptc_task_output` / `ptc_task_stop`.',
    order: 4,
  },
  {
    source: 'packages/routes/docs/routes/report-what-you-did.md',
    slug: 'report-what-you-did',
    title: 'Report what you did',
    blurb: "The child's report contract: summary, findings, files touched, usage.",
    order: 5,
  },
  {
    source: 'packages/routes/docs/routes/use-the-built-in-tools.md',
    slug: 'use-the-built-in-tools',
    title: 'Use the built-in tools',
    blurb: 'When not to write a program — direct calls, and the opt-in `bash` binding.',
    order: 6,
  },
  {
    source: 'packages/routes/docs/routes/reach-the-web.md',
    slug: 'reach-the-web',
    title: 'Reach the web',
    blurb: '`web_ds_search` inside dispatched children: search, open, find, and the quota.',
    order: 7,
  },
  {
    source: 'docs/pi-version-matrix.md',
    slug: 'pi-version-matrix',
    title: 'pi version matrix',
    blurb: 'Measured pi compatibility: the 0.99.0 watershed, floor 0.86.0, and the 16-version smoke.',
    order: 8,
  },
];

/**
 * Living status panoramas, copied verbatim (they are complete HTML documents with
 * their own styles) into `public/status/`. Copied, not projected: projection is for
 * markdown sources; these two are already pages. The pair cross-links by relative
 * filename, which keeps working because both land in the same directory.
 */
const STATUS_PAGES = [
  'docs/prototypes/ptc-runtime-status.html',
  'docs/prototypes/dispatch-engine-status.html',
];

/**
 * Projected-document basename (no extension) → its route slug.
 *
 * Keyed by basename because that is all a sibling link carries: from
 * `docs/usage/bgdispatch.md`, `[…](./structured-results.md)` names a file in
 * the same directory, and the two live in different directories in the
 * repository. An earlier version keyed by path and produced `usage/usage/…`
 * entries that matched nothing, so one sibling link shipped unrewritten.
 */
const slugByBasename = new Map(
  DOCUMENTS.map((d) => [basename(d.source), d.slug])
);

function basename(path) {
  return path.split('/').pop().replace(/\.md$/, '');
}

/** Strip YAML frontmatter if a source document grows one. */
function splitFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: '', body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

function titleFrom(body, fallback) {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : fallback;
}

/**
 * Rewrite one markdown link target found in `fromRel`, a repo-relative path.
 *
 * Returns the replacement, or `null` to leave the link exactly as written —
 * which is how an unrecognised relative shape reaches VitePress's dead-link
 * check instead of being silently dropped here.
 *
 * Rewriting a relative target into an absolute repository URL **removes it from
 * VitePress's dead-link check**, because that check only resolves links inside
 * the site. A decision-reference link pointing at a file that does not exist
 * would therefore ship silently. So every target this function turns absolute is
 * resolved against the repository first, and a missing one fails the build here.
 *
 * The target is resolved with real path arithmetic rather than by stripping
 * `../` and guessing a prefix. `bgdispatch.md` links an ADR as `../adr/X.md`,
 * which lands in `docs/`, and the glossary as `../../GLOSSARY.md`, which lands at
 * the repository root — the same string operation put the second one at
 * `docs/GLOSSARY.md`, which does not exist, and failed the build on correct
 * source content.
 */
function rewriteTarget(target, fromRel) {
  // In-page anchor: nothing to resolve.
  if (target.startsWith('#')) return null;
  if (/^https?:\/\//.test(target)) return null;

  const isRepoRelative = /^(\.\.\/)+/.test(target);

  // A sibling projected document: a route on this site.
  if (target.startsWith('./')) {
    const sibling = /^\.\/([^/]+)\.md(?:#(.*))?$/.exec(target);
    if (sibling) {
      const slug = slugByBasename.get(sibling[1]);
      if (slug) return `/docs/${slug}${sibling[2] ? `#${sibling[2]}` : ''}`;
    }
    return null;
  }

  // Anything else that climbs out of its directory points into the repository.
  if (isRepoRelative) {
    // The fragment is split off before resolving. `resolve()` keeps it in the string, so
    // `../../README.md#trust-posture-read-me` became a path ending in `#trust-posture-read-me`,
    // and existsSync() is false for it no matter what is on disk -- which is how one correct
    // link in docs/usage/structured-results.md took the website build down on 2026-10-14. The
    // sibling branch above already separates the fragment; this one has to as well.
    const [pathPart, fragment] = target.split('#');
    const resolved = resolve(REPO_ROOT, dirname(fromRel), pathPart);
    const relToRepo = relative(REPO_ROOT, resolved);
    if (!existsSync(resolved) || relToRepo.startsWith('..')) {
      throw new Error(
        `dead repository link in a projected document: ${target}\n` +
          `  in ${fromRel} it resolves to ${relToRepo}, which does not exist.\n` +
          `  Rewriting it to an absolute URL would hide it from VitePress's\n` +
          `  dead-link check, so the build stops here instead.`
      );
    }
    return `${BLOB}/${relToRepo}${fragment ? `#${fragment}` : ''}`;
  }

  return null;
}

function rewriteLinks(markdown, fromRel) {
  let rewrites = 0;
  const out = markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    const replacement = rewriteTarget(target, fromRel);
    if (replacement === null) return whole;
    rewrites++;
    return `](${replacement})`;
  });
  return { markdown: out, rewrites };
}

/** The visible marker that says where this page came from. */
function banner(sourcePath, title) {
  const url = `${BLOB}/${sourcePath}`;
  return (
    `\n<div class="lp-generated">\n` +
    `  <strong>Generated from <a href="${url}"><code>${sourcePath}</code></a></strong>\n` +
    `  <span>in the repository. Edit that file and this page follows — ` +
    `there is no second copy of it, and the text below is not maintained here. ` +
    `Source: <a href="${url}">${title}</a>.</span>\n` +
    `</div>\n`
  );
}

/** Insert the banner directly after the leading H1, so it reads as page head. */
function insertBanner(body, sourcePath, title) {
  const match = /^#\s+.+$/m.exec(body);
  if (!match) return `${banner(sourcePath, title)}\n${body}`;
  const at = match.index + match[0].length;
  return `${body.slice(0, at)}\n${banner(sourcePath, title)}${body.slice(at)}`;
}

function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let totalRewrites = 0;
  const emitted = [];

  for (const doc of DOCUMENTS) {
    const raw = readFileSync(join(REPO_ROOT, doc.source), 'utf8');
    const { body } = splitFrontmatter(raw);
    const title = titleFrom(body, doc.title);

    const { markdown, rewrites } = rewriteLinks(body, doc.source);
    totalRewrites += rewrites;

    const frontmatter =
      `---\n` +
      `title: ${JSON.stringify(title)}\n` +
      `description: ${JSON.stringify(doc.blurb)}\n` +
      `---\n`;

    // The file is named after the route slug, not after its source path, so that
    // moving a document inside the repository does not silently move a published
    // URL. The route is curated in DOCUMENTS above and nowhere else.
    const out = join(OUT_DIR, `${doc.slug}.md`);
    writeFileSync(out, `${frontmatter}${insertBanner(markdown, doc.source, title)}`, 'utf8');
    emitted.push({ ...doc, title, rewrites });
  }

  // The docs index, so /docs/ is a real route rather than a 404.
  const index =
    `---\n` +
    `title: "Documentation"\n` +
    `description: "Every page here is projected from a file in the repository."\n` +
    `---\n\n` +
    `# Documentation\n\n` +
    `Every page below is projected at build time from a file in the repository. ` +
    `None of them is maintained twice.\n\n` +
    emitted
      .sort((a, b) => a.order - b.order)
      .map(
        (d) =>
          `## [${d.title}](${`/docs/${d.slug}`})\n\n${d.blurb}\n\n` +
          `Source: [\`${d.source}\`](${BLOB}/${d.source})\n`
      )
      .join('\n');

  writeFileSync(join(OUT_DIR, 'index.md'), index, 'utf8');

  // A machine-readable record of what was projected, for `check-projection-coverage.mjs`.
  // That check has to know the difference between "this document is not on the site" and
  // "this document is not on the site because the list does not mention it yet" — and
  // reading a list out of another script's source would couple the two by regex.
  writeFileSync(
    join(OUT_DIR, 'projected.json'),
    `${JSON.stringify({ projected: emitted.map((d) => ({ source: d.source, slug: d.slug })) }, null, 2)}\n`,
    'utf8',
  );

  // The two living status panoramas, copied verbatim into public/status/. Same no-second-copy
  // discipline as the markdown projection: the repository holds the only source, and this
  // directory is gitignored. A missing source fails the build here rather than 404ing later.
  rmSync(PUBLIC_STATUS, { recursive: true, force: true });
  mkdirSync(PUBLIC_STATUS, { recursive: true });
  for (const page of STATUS_PAGES) {
    const from = join(REPO_ROOT, page);
    if (!existsSync(from)) {
      throw new Error(`status page source is missing: ${page}`);
    }
    copyFileSync(from, join(PUBLIC_STATUS, page.split('/').pop()));
  }

  console.log(`projected ${emitted.length} document(s), ${totalRewrites} link(s) rewritten`);
  for (const d of emitted) {
    console.log(`  ${d.source} -> /docs/${d.slug}  (${d.rewrites} rewritten)`);
  }
  for (const page of STATUS_PAGES) {
    console.log(`  ${page} -> /status/${page.split('/').pop()}`);
  }
}

main();
