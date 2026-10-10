import { defineConfig } from "vitepress";

/**
 * The site is a GitHub **project** site, so it is served from
 * `<owner>.github.io/pi-ptc-subagents/` — not from the domain root. `base`
 * must carry the repository name or every asset URL resolves one level too
 * high and the page renders unstyled with a 404 on each script.
 */
export default defineConfig({
  title: "pi-ptc-subagents",
  description:
    "Programmable tool calling (PTC) and subagent fan-out for pi — the model writes JS/TS programs that call pi's tools, or fans out to a fresh pi subprocess per subagent task.",
  base: "/pi-ptc-subagents/",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [],
    sidebar: [],
    socialLinks: [
      { icon: "github", link: "https://github.com/a1121611810/pi-ptc-subagents" },
    ],
    footer: {
      message: "Apache-2.0 · released under the guidance of a single maintainer.",
      copyright: "",
    },
  },
});
