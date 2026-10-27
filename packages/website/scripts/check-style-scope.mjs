#!/usr/bin/env node
/**
 * Gate: the landing page's own stylesheet must not restyle the documentation pages.
 *
 * The failure this prevents already shipped. `landing.css` is imported from the theme entry, so
 * it is bundled into the single stylesheet every page loads. For a while it carried unscoped
 * `!important` rules against VitePress's own chrome, and on the five documentation routes each
 * one did damage rather than good:
 *
 *   - `.VPNav, .VPFooter { display: none !important }` removed the nav bar and the footer from
 *     every documentation page.
 *   - `.VPContent { padding: 0 !important }` removed the `padding-left` that reserves room for the
 *     fixed `.VPSidebar`, so the prose slid underneath the sidebar and lost its first characters —
 *     "Documentation" rendered as "ocumentation".
 *
 * Nothing that exists can see this. The build is green, every route answers 200, the DOM is
 * complete, the internal-link check passes, and the CSS is doing exactly what it was written to
 * do. It is also the second time this repository's site has needed a screenshot to find a defect:
 * the comment above the same rules records that hiding `.VPContent` blanked the landing page while
 * every automated signal stayed green. So this gate exists, and it asserts the shape rather than
 * the pixels — the shape is what a rule file can get wrong silently.
 *
 * It checks two independent things.
 *
 * 1. **No unscoped chrome override.** Any selector in `landing.css` that names one of VitePress's
 *    chrome classes must sit inside the landing scope. The scope is written `:has()` on the
 *    landing page's own root element, because every ancestor that needs neutralizing (`.Layout`,
 *    `.VPContent`, `.VPDoc`) is *above* that element — a descendant class cannot reach them, and
 *    VitePress 1.6.4 has no `bodyClass` frontmatter to hang a class off `<body>` instead.
 *
 * 2. **The scope anchor is real.** This is the check for a guard that guards nothing. The same file
 *    also used to carry `.VPDocSider`, a class VitePress 1.6.4 does not have — the right-hand
 *    aside is `.VPDocAside` — so a `display: none` written to hide the aside was hiding nothing, on
 *    any page, and read as protection the whole time. A selector that matches no element is
 *    indistinguishable from one that works, so the anchor this file scopes by is extracted from
 *    the file itself and then checked against the **built** pages: it must be on the landing page
 *    and absent from the documentation pages. A scope that stops matching stops protecting anyone,
 *    and a scope that accidentally matches everything has the bug this gate was written for.
 *
 * Exit code is 1 on any failure, and every failure names what to change.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE = join(HERE, '..');
const REPO_ROOT = join(SITE, '..', '..');
const STYLESHEET = join(SITE, '.vitepress', 'theme', 'landing.css');
const DIST = join(SITE, '.vitepress', 'dist');

/** The landing page's only root element class. Read from the file, never assumed. */
const SCOPE_MARKER = '.lp';

/**
 * VitePress's chrome. A selector naming any of these is reaching into the shell the theme owns,
 * which is exactly what a page-specific stylesheet must do only from inside its scope.
 */
const CHROME = /\.(VP[A-Z][A-Za-z]*)\b/g;

/**
 * Whether a class attribute carries this class **as a token**.
 *
 * A substring test is wrong here and was wrong here first: the projected documentation pages carry
 * `class="lp-generated"`, which shares the `lp` prefix and made a naive `class="lp` search report
 * the scope as site-wide. `lp-generated` is a different class from `lp` and never matched the
 * `:has(.lp)` scope. Splitting the attribute value on whitespace is what makes the check ask the
 * question it means to ask.
 */
function hasClass(html, cls) {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    if (m[1].split(/\s+/).includes(cls)) return true;
  }
  return false;
}

/**
 * Every built HTML file, by path relative to the build output.
 *
 * Recursive on purpose. A shallow read of the build root sees `index.html` and `404.html` and
 * nothing else, because the documentation pages live in a `docs/` subdirectory — so a check that
 * listed "the other pages" shallowly would report one page checked and pass while the five routes
 * that actually carry the chrome went unexamined. The landing page is identified by being the
 * build root's own `index.html`; every other built page, including `404.html`, is a page the
 * scope must not match.
 */
function htmlFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, base, acc);
    else if (entry.name.endsWith('.html')) acc.push(relative(base, full));
  }
  return acc;
}

/**
 * Collect every rule's selector list, including rules nested in `@media`.
 *
 * A hand-rolled walk rather than a CSS parser because the dependency would be heavier than the
 * thing being checked. Quoted strings are skipped so a `content: "}"` cannot end a rule early;
 * that is the only construct in a stylesheet that can unbalance the braces, and this file has none.
 */
function ruleSelectors(css) {
  const out = [];
  const stack = [];
  let buf = '';
  let quote = null;

  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const prelude = stack.pop() ?? '';
      if (prelude && !prelude.startsWith('@')) out.push(prelude);
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/** Remove comments, so prose naming a class cannot register as a rule. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function chromeClassesIn(selector) {
  const found = new Set();
  for (const m of selector.matchAll(CHROME)) found.add(m[1]);
  return [...found];
}

function main() {
  const css = stripComments(readFileSync(STYLESHEET, 'utf8'));
  const selectors = ruleSelectors(css);

  const scoped = [];
  const leaking = [];

  for (const list of selectors) {
    for (const selector of list.split(',')) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const classes = chromeClassesIn(trimmed);
      if (classes.length === 0) continue;
      if (trimmed.includes(':has(') && trimmed.includes(SCOPE_MARKER)) scoped.push(trimmed);
      else leaking.push({ selector: trimmed, classes });
    }
  }

  if (leaking.length > 0) {
    console.error('✗ the landing stylesheet restyles VitePress chrome outside its own scope:\n');
    for (const { selector, classes } of leaking) {
      console.error(`   ${selector}`);
      console.error(`       reaches ${classes.join(', ')} — which every page loads\n`);
    }
    console.error(
      '  These rules reach the shell above the landing page, so the documentation pages get them\n' +
        `  too. Scope each one to \`.Layout:has(${SCOPE_MARKER})\`, the landing page's own root\n` +
        '  element — it is the only ancestor a page-specific stylesheet can key on, because\n' +
        '  VitePress 1.6.4 has no `bodyClass` frontmatter.',
    );
    process.exit(1);
  }

  if (scoped.length === 0) {
    console.error(
      '✗ the landing stylesheet contains no scoped chrome rule at all.\n\n' +
        '  Either the landing page no longer needs to neutralise the docs shell, or the\n' +
        '  overrides were deleted along with the scope and the landing page now inherits the\n' +
        '  documentation measure it exists to escape. Confirm which, rather than letting an\n' +
        '  empty check pass.',
    );
    process.exit(1);
  }

  // Direction 2: the scope must match something, and only the landing page.
  const anchors = new Set();
  for (const selector of scoped) {
    for (const m of selector.matchAll(/:has\(\s*\.([A-Za-z0-9_-]+)/g)) anchors.add(m[1]);
  }

  // A missing build output is a gate message, never a stack trace. `readdirSync` on an absent
  // directory throws ENOENT with a raw node stack, which names neither this check nor what to do —
  // the one failure shape a gate must never produce, and already recorded once in this repository
  // (`docs/reviews/2026-10-11-website-gap-closure-code-review.md`, R-w3). Four of the five checks
  // fail on a fresh clone that has not been built, so this path is reached by anyone who follows
  // the README's local-run instructions in order and runs `check` before `build`.
  // Read every built page, and treat every way that can fail as a gate message.
  //
  // `existsSync` alone is not enough, and round 2 of the review measured the two states it misses:
  // `dist/` present but **empty** (VitePress empties the output directory at the start of a build,
  // so an interrupted build leaves exactly that) and `dist` present as a **file**. Both threw raw
  // node stacks — `ENOENT … open '…/dist/index.html'` and `ENOTDIR … scandir '…/dist'` — which is
  // the shape this file's own header forbids. The sibling gate already handles the identical class
  // by wrapping the read; this now does the same, and treats "no pages at all" as a failure rather
  // than as a pass.
  let pages;
  try {
    pages = htmlFiles(DIST);
  } catch (error) {
    console.error(
      `✗ no build output at ${relative(REPO_ROOT, DIST)}\n\n` +
        `  Reading it failed: ${error.code ?? error.message}\n` +
        '  This check reads the built pages, so it runs after `pnpm --filter website run build`.\n' +
        '  Same for the tool-name check and the internal-link check.',
    );
    process.exit(1);
  }

  const landing = 'index.html';
  const docs = pages.filter((f) => f !== landing);

  // A build output with no documentation pages would make "the anchor is on none of them" true
  // against zero pages, which is a pass for the wrong reason. VitePress always emits five.
  const DOC_PAGE_FLOOR = 5;
  if (!pages.includes(landing)) {
    console.error(
      `✗ the landing page is not in the build output at ${relative(REPO_ROOT, join(DIST, landing))}\n\n` +
        '  Without it there is nothing to check the scope anchor against.',
    );
    process.exit(1);
  }
  if (docs.length < DOC_PAGE_FLOOR) {
    console.error(
      `✗ the build output holds ${docs.length} documentation page(s), expected at least ${DOC_PAGE_FLOOR}\n\n` +
        '  Checking that the scope anchor is absent from documentation pages against a page set this\n' +
        '  small would pass for the wrong reason. Re-run `pnpm --filter website run build`.',
    );
    process.exit(1);
  }

  let landingHtml;
  try {
    landingHtml = readFileSync(join(DIST, landing), 'utf8');
  } catch (error) {
    console.error(
      `✗ could not read the built landing page: ${error.code ?? error.message}\n\n` +
        '  Run `pnpm --filter website run build` first.',
    );
    process.exit(1);
  }
  const missing = [...anchors].filter((a) => !hasClass(landingHtml, a));
  if (missing.length > 0) {
    console.error('✗ the scope anchor matches nothing in the built landing page:\n');
    for (const a of missing) console.error(`   .${a}`);
    console.error(
      '\n  A scope that matches no element protects nothing. If the root element was\n' +
        '  renamed, the scope in this file has to change with it — otherwise the override\n' +
        '  never applied in the first place.',
    );
    process.exit(1);
  }

  const leaked = docs.filter((f) => {
    const html = readFileSync(join(DIST, f), 'utf8');
    return [...anchors].some((a) => hasClass(html, a));
  });

  if (leaked.length > 0) {
    console.error('✗ the scope anchor is on documentation pages, so the scope is not a scope:\n');
    for (const f of leaked) console.error(`   ${f}`);
    console.error(
      '\n  Every rule scoped by it now applies site-wide, which is the bug this gate exists for.',
    );
    process.exit(1);
  }

  console.log(
    `✓ landing style scope — ${scoped.length} chrome rule(s) scoped to :has(${SCOPE_MARKER}); ` +
      `${anchors.size} anchor(s), on the landing page and on none of the ${docs.length} doc page(s)`,
  );
  for (const selector of scoped) console.log(`    ${selector}`);
}

main();