import { defineConfig } from "vitepress";

/**
 * The site is a GitHub **project** site, so it is served from
 * `<owner>.github.io/pi-ptc-subagents/` — not from the domain root. `base`
 * must carry the repository name or every asset URL resolves one level too
 * high and the page renders unstyled with a 404 on each script.
 *
 * `BASE` is duplicated in `scripts/check-internal-links.mjs`, which resolves
 * emitted hrefs against the built route set. If you change one, change both —
 * a stale copy reports every internal link as dead, which is a loud failure
 * rather than a silent one, but it is still a failure you did not cause.
 */
export default defineConfig({
  title: "pi-ptc-subagents",
  description:
    "Programmable tool calling (PTC) and subagent fan-out for pi — the model writes JS/TS programs that call pi's tools, or fans out to a fresh pi subprocess per subagent task.",
  base: "/pi-ptc-subagents/",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "Documentation", link: "/docs/" },
      { text: "Source", link: "https://github.com/a1121611810/pi-ptc-subagents" },
    ],
    sidebar: {
      "/docs/": [
        {
          text: "Documentation",
          items: [
            { text: "Install", link: "/docs/install" },
            { text: "Surface detection", link: "/docs/surface" },
            { text: "Background dispatch", link: "/docs/background-dispatch" },
            { text: "Structured results", link: "/docs/structured-results" },
          ],
        },
      ],
    },
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/a1121611810/pi-ptc-subagents" },
      { icon: "npm", link: "https://www.npmjs.com/package/pi-ptc-subagents" },
    ],
    editLink: {
      pattern: "https://github.com/a1121611810/pi-ptc-subagents/edit/main/docs/:path",
      text: "Edit this document in the repository",
    },
    footer: {
      message:
        "Apache-2.0. Every page under Documentation is projected from a file in the repository.",
      copyright: "",
    },
  },
});
