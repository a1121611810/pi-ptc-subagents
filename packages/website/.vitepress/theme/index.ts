import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Landing from './Landing.vue'
import './landing.css'

/**
 * `landing` is the layout name `index.md` asks for in its frontmatter. The
 * kebab-case name is deliberate: VitePress resolves `layout:` against the
 * registered component name, so these two strings have to agree.
 */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('landing', Landing)
  },
} satisfies Theme
