---
layout: landing
---

<script setup>
// 落地页（2026-10-29 视觉重构：prototype 三选一，赢家 Variant B「Bento 控制台」；
// faces 区段同日第二轮三选一，赢家 C「分工流程」。落选候选与切换器分别在
// prototype/landing-ui-20261029 与 prototype/faces-ui-20261029 分支留档）。
import { computed, onMounted, ref } from 'vue'

// faces 分工流水线的芯片标签：将来第三个宿主接入时在这里与 providers 数组各加一项
const FACE_LABELS = { pi: 'PI', kimi: 'KIMI' }

const copied = ref('')

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard is gated on a secure context; the command is selectable either
    // way, so a failed write is not worth an error banner on a landing page.
    return
  }
  copied.value = text
  setTimeout(() => {
    if (copied.value === text) copied.value = ''
  }, 1600)
}

// 双语：默认英文，可切中文，选择存 localStorage。构建期（Node 无 localStorage）
// 恒渲染英文默认，所以站点的四道门（工具名抽取读构建产物）看到的仍是英文文案。
const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('lp-lang')
// 客户端初始值必须与 SSR 一致（EN），否则水合时 Vue 信 SSR 的 class、
// 却补 v-html 内容——刷新后正文是中文、高亮停在 EN 就是这个错配。
const lang = ref('en')
onMounted(() => {
  lang.value = stored === 'zh' ? 'zh' : 'en'
})
function setLang(next) {
  lang.value = next
  if (typeof localStorage !== 'undefined') localStorage.setItem('lp-lang', next)
}

const M = {
  en: {
    hero: {
      kicker: 'pi extension + Kimi Code plugin',
      h1: 'One call runs<br />the whole loop.',
      sub: 'pi calls tools one at a time &mdash; and so does every other host. Write one program that calls them in one go. <strong>Same pipeline, different providers:</strong> who supplies each step below is exactly where pi and Kimi diverge.',
      termComment: '// one call, fan out in bulk',
      termResult: 'intermediate output never enters context',
      installNote: 'pi installs via the <code>pi.extensions</code> manifest; Kimi installs with <code>/plugins install</code> &mdash; the bare repo URL tracks the latest GitHub Release. Neither has a postinstall hook &mdash; run <code>/reload</code> to activate.',
    },
    cards: [
      {
        title: 'Programmable tool calling',
        face: 'The pi edition, in depth &mdash; Kimi&rsquo;s slimmer shape is steps 1&ndash;2 of the pipeline below',
        body: '<code>ptc_run_code</code> / <code>ptc_workflow</code> run a TypeScript program in a worker. It reaches the session&rsquo;s tools as <code>tools.&lt;name&gt;(args)</code> &mdash; loops, branches and <code>Promise.all</code> fan-out live in JavaScript, not in a second tool protocol. Only the program&rsquo;s return value and its logs come back to the model.',
      },
    ],
    surfaces: {
      foot: 'On a <code>full_ptc</code> session the PTC tools are registered and the model writes programs directly; on a <code>codemode_ptc</code> session pi&rsquo;s own codemode runs the script and this package supplies the task door underneath. Each surface keeps its own orchestrator.',
    },
    flow: {
      title: 'Same pipeline, different providers.',
      lede: 'All four steps exist on both editions &mdash; what differs is who provides each step. (Subagents are not missing on Kimi: Kimi Code ships its own Agent tool, so this plugin doesn&rsquo;t duplicate one.)',
      steps: [
        {
          step: 'Write the program',
          providers: [
            { face: 'pi', html: '<code>ptc_run_code</code> &middot; <code>ptc_workflow</code>' },
            { face: 'kimi', html: '<code>ptc_run_code</code> (the only one)' },
          ],
        },
        {
          step: 'Inside the program',
          providers: [
            { face: 'pi', html: 'the session&rsquo;s full tool set as <code>tools.*</code> &mdash; same pipeline as a direct call' },
            { face: 'kimi', html: 'the fixed fs four: <code>read</code> / <code>grep</code> / <code>glob</code> / <code>edit</code>, realpath-confined to <code>workdir</code>' },
          ],
        },
        {
          step: 'Subagent fan-out',
          providers: [
            { face: 'pi', html: 'built into this package: <code>pi_task_ptc</code> / <code>pi_task_codemode</code>, a fresh <code>pi</code> process per task, plus the <code>ptc_task_list</code> / <code>ptc_task_output</code> / <code>ptc_task_stop</code> task face' },
            { face: 'kimi', html: 'Kimi Code&rsquo;s own Agent tool &mdash; the host already has one, so this plugin doesn&rsquo;t duplicate it' },
          ],
        },
        {
          step: 'Web search',
          providers: [
            { face: 'pi', html: '<code>web_ds_search</code> inside dispatched children, off by default' },
            { face: 'kimi', html: '<code>web_ds_search</code> called directly by the model, per-process quota' },
          ],
        },
      ],
    },
    get: {
      eyebrow: 'What you get',
      cards: [
        {
          title: 'One program, many tool calls',
          body: 'Results are filtered and reduced before they reach the model. Output over the truncation threshold is tail-noted with a path to the full text &mdash; never an escaped-JSON wall.',
        },
        {
          title: 'Real subagents',
          body: 'On pi: every task gets its own pi process and its own report &mdash; a fenced contract with summary, findings, files touched and usage. Session-level isolation without inventing a task state machine. (On Kimi, dispatch is the host&rsquo;s own Agent tool &mdash; step 3 above.)',
        },
        {
          title: 'Search, where it belongs',
          body: 'On pi: <code>web_ds_search</code> registers only inside dispatched children, off by default with per-process quota &mdash; the judgment about a source stays with the worker that read it. On Kimi: the model calls the same tool directly.',
        },
      ],
    },
    trust: {
      h2: 'Trust posture',
      items: [
        'PTC programs run in a <strong>vm cell</strong> on both editions: the only way out is <code>tools.*</code>, which goes through the <strong>same tool pipeline as a direct call</strong>. No <code>process</code>, no <code>fetch</code>, no dynamic <code>import</code> inside a program.',
        'That is an alignment of power paths, <strong>not a sandbox</strong>: whatever the bound tools can do, a program can do. On pi the bindings mirror the session&rsquo;s <strong>enabled</strong> built-ins (<code>--tools &hellip;</code> narrows them); on Kimi they are the fixed fs tool set, realpath-confined to <code>workdir</code>.',
        'A dispatched child is a full <code>pi</code> process running as you. <code>bash</code> is not in the program binding table on either edition.',
      ],
    },
    footnav: [
      { strong: 'Documentation', span: 'seven route booklets, projected from the repository' },
      { strong: 'npm', span: 'pi-ptc-subagents' },
    ],
  },
  zh: {
    hero: {
      kicker: 'pi 扩展 + Kimi Code 插件',
      h1: '一次调用，<br />跑完整个循环。',
      sub: 'pi 一次只调一个工具&mdash;&mdash;其他宿主也一样。让模型写一段程序一口气调完。<strong>同一条流水线，分工不同：</strong>下面四步由谁提供，pi 版和 Kimi 版各有答案。',
      termComment: '// 一次调用，批量扇出',
      termResult: '中间产物不进上下文',
      installNote: 'pi 走 <code>pi.extensions</code> 清单安装；Kimi 用 <code>/plugins install</code> 安装&mdash;&mdash;裸仓库 URL 跟踪最新 GitHub Release。两边都无 postinstall 钩子，装完 <code>/reload</code> 生效。',
    },
    cards: [
      {
        title: '可编程工具调用',
        face: '本卡细讲 pi 版&mdash;&mdash;Kimi 版更精简的形态见下方流水线第 1、2 步',
        body: '<code>ptc_run_code</code> / <code>ptc_workflow</code> 在 worker 里跑 TypeScript 程序，经 <code>tools.&lt;name&gt;(args)</code> 触达会话工具&mdash;&mdash;循环、分支、<code>Promise.all</code> 并行都写在 JavaScript 里，而不是另一套工具协议。回到模型的只有程序返回值和日志。',
      },
    ],
    surfaces: {
      foot: '<code>full_ptc</code> 会话注册 PTC 工具，模型直接写程序；<code>codemode_ptc</code> 会话由 pi 自带 codemode 跑脚本，本包在底下补上任务门&mdash;&mdash;一种形态一个编排器。',
    },
    flow: {
      title: '同一条流水线，分工不同。',
      lede: '四步动作两个版本都有&mdash;&mdash;差别只在每一步由谁提供。（Kimi 版不是「没有子代理」：Kimi Code 自带 Agent 工具，宿主已有，本插件不重复造。）',
      steps: [
        {
          step: '写程序',
          providers: [
            { face: 'pi', html: '<code>ptc_run_code</code> &middot; <code>ptc_workflow</code>' },
            { face: 'kimi', html: '<code>ptc_run_code</code>（仅此一个）' },
          ],
        },
        {
          step: '程序内工具',
          providers: [
            { face: 'pi', html: '会话工具全集 <code>tools.*</code>&mdash;&mdash;与直调同一条工具管线' },
            { face: 'kimi', html: '固定文件四件套 <code>read</code> / <code>grep</code> / <code>glob</code> / <code>edit</code>，realpath 囚禁在 <code>workdir</code> 内' },
          ],
        },
        {
          step: '子代理派活',
          providers: [
            { face: 'pi', html: '本包自带：<code>pi_task_ptc</code> / <code>pi_task_codemode</code>，每个任务独立 pi 进程，另有 <code>ptc_task_list</code> / <code>ptc_task_output</code> / <code>ptc_task_stop</code> 任务面' },
            { face: 'kimi', html: 'Kimi Code 自带 Agent 工具&mdash;&mdash;宿主已有，本插件不重复造' },
          ],
        },
        {
          step: '联网搜索',
          providers: [
            { face: 'pi', html: '<code>web_ds_search</code> 注册在被派出的子代理进程里，默认关' },
            { face: 'kimi', html: '<code>web_ds_search</code> 模型直调，每进程配额 30' },
          ],
        },
      ],
    },
    get: {
      eyebrow: '你得到什么',
      cards: [
        {
          title: '一段程序，多次工具调用',
          body: '结果先过滤归约再进模型上下文。超截断阈值的输出只给尾部和全文路径&mdash;&mdash;永远不是一屏转义 JSON。',
        },
        {
          title: '真子代理',
          body: 'pi 版：每个任务一个 pi 进程、一份报告&mdash;&mdash;末尾 fenced JSON 契约：summary、findings、files_touched、usage。会话级隔离，不用自造任务状态机。（Kimi 版的派活交给宿主自带 Agent 工具，见上方流水线第 3 步。）',
        },
        {
          title: '搜索在对的地方',
          body: 'pi 版：<code>web_ds_search</code> 只注册在被派出的子代理里，默认关、每进程配额&mdash;&mdash;来源靠不靠谱的判断力留在读页面的 worker 侧；Kimi 版同一工具模型直接调用。',
        },
      ],
    },
    trust: {
      h2: '信任姿态',
      items: [
        'PTC 程序（两个版本）都在 <strong>vm 运行格</strong>里执行&mdash;&mdash;唯一的出口是 <code>tools.*</code>，与直调走<strong>同一条工具管线</strong>。程序内没有 <code>process</code>、<code>fetch</code>、动态 <code>import</code>。',
        '这是权力路径对齐，<strong>不是沙箱</strong>：绑定工具能做的事，程序就能做。pi 版绑定表镜像会话<strong>已启用</strong>的内置工具（<code>--tools &hellip;</code> 随之收窄）；Kimi 版是固定的 fs 四件套（read / grep / glob / edit），realpath 囚禁在 <code>workdir</code> 内。',
        '被派出的子代理是一个以你的身份运行的完整 <code>pi</code> 进程。<code>bash</code> 不在任何一个版本的程序绑定表里。',
      ],
    },
    footnav: [
      { strong: '文档', span: '九篇册子，构建时投影自仓库' },
      { strong: 'npm', span: 'pi-ptc-subagents' },
    ],
  },
}
const m = computed(() => M[lang.value])
</script>

<template>
  <div class="lpb lp">
    <nav class="lpb-nav">
      <span class="lpb-logo">pi-ptc<em>-subagents</em></span>
      <span class="lpb-navright">
        <span class="lpb-lang" role="group" aria-label="Language / 语言">
          <button type="button" :class="{ on: lang === 'en' }" :aria-pressed="lang === 'en'" @click="setLang('en')">EN</button>
          <button type="button" :class="{ on: lang === 'zh' }" :aria-pressed="lang === 'zh'" @click="setLang('zh')">中文</button>
        </span>
        <span class="lpb-links">
          <a href="/pi-ptc-subagents/docs/">Docs</a>
          <a href="https://github.com/a1121611810/pi-ptc-subagents">GitHub</a>
          <a href="https://www.npmjs.com/package/pi-ptc-subagents">npm</a>
        </span>
      </span>
    </nav>

    <header class="lpb-hero">
      <div class="lpb-heroL">
        <p class="lpb-kicker">{{ m.hero.kicker }}</p>
        <h1 v-html="m.hero.h1"></h1>
        <p class="lpb-lede" v-html="m.hero.sub"></p>
        <div class="lpb-chips">
          <button type="button" class="lpb-chip" @click="copy('pi install npm:pi-ptc-subagents')">
            <span class="lpb-chip-label">pi</span>
            <code>pi install npm:pi-ptc-subagents</code>
            <span class="lpb-chip-copy">{{ copied === 'pi install npm:pi-ptc-subagents' ? '✓' : 'copy' }}</span>
          </button>
          <button type="button" class="lpb-chip" @click="copy('/plugins install https://github.com/a1121611810/pi-ptc-subagents')">
            <span class="lpb-chip-label">kimi</span>
            <code>/plugins install github.com/a1121611810/pi-ptc-subagents</code>
            <span class="lpb-chip-copy">{{ copied.startsWith('/plugins') ? '✓' : 'copy' }}</span>
          </button>
        </div>
        <p class="lpb-note" v-html="m.hero.installNote"></p>
      </div>

      <div class="lpb-term" aria-hidden="true">
        <div class="lpb-term-bar">
          <i></i><i></i><i></i>
          <span>ptc_run_code</span>
        </div>
        <pre>{{ m.hero.termComment }}
const hits = await tools.grep({
  pattern: <span class="lpb-s">"AssistantMessageComponent"</span> })
const files = await Promise.all(
  hits.map(h =&gt; tools.read({ path: h.path })))
return { files: files.length,
         totalLines: hits.length }

<span class="lpb-ok">✓ 3 files · 41 lines · 1 round trip</span>
<span class="lpb-dim">— {{ m.hero.termResult }}</span></pre>
      </div>
    </header>

    <main class="lpb-bento">
      <article class="lpb-b lpb-b-wide">
        <p class="lpb-beyebrow">01</p>
        <h3 v-html="m.cards[0].title"></h3>
        <span class="lpb-badge" v-html="m.cards[0].face"></span>
        <p v-html="m.cards[0].body"></p>
        <pre>full_ptc      model ──▶ ptc_run_code ──▶ program ──┬──▶ tools.read · grep · edit · …   (session tools)
                                                          └──▶ pi_task_ptc ──▶ pi child ──▶ report

codemode_ptc  model ──▶ codemode script ───────────┬──▶ tools.read · grep · edit · …   (session tools)
                                                   └──▶ pi_task_codemode ──▶ pi child ──▶ report

                                        one call in, one result back — never the calls in between.</pre>
        <p class="lpb-bfoot" v-html="m.surfaces.foot"></p>
      </article>

      <article class="lpb-b lpb-b-wide">
        <h3 v-html="m.flow.title"></h3>
        <p class="lpb-flowlede" v-html="m.flow.lede"></p>
        <ol class="lpb-steps">
          <li v-for="(s, i) in m.flow.steps" :key="s.step">
            <span class="lpb-stepnum">{{ i + 1 }}</span>
            <h4 v-html="s.step"></h4>
            <div class="lpb-fchips">
              <div v-for="p in s.providers" :key="p.face" class="lpb-fchip" :class="p.face">
                <b>{{ FACE_LABELS[p.face] }}</b>
                <span v-html="p.html"></span>
              </div>
            </div>
          </li>
        </ol>
      </article>

      <article class="lpb-b">
        <h3 v-html="m.get.eyebrow"></h3>
        <ul class="lpb-gaps">
          <li v-for="(g, i) in m.get.cards" :key="i">
            <b v-html="g.title"></b>
            <span v-html="g.body"></span>
          </li>
        </ul>
      </article>

      <article class="lpb-b lpb-b-warn">
        <h3 v-html="m.trust.h2"></h3>
        <ul class="lpb-trust">
          <li v-for="(item, i) in m.trust.items" :key="i" v-html="item"></li>
        </ul>
      </article>
    </main>

    <footer class="lpb-foot">
      <span>Apache-2.0</span>
      <span class="lpb-footlinks">
        <a href="/pi-ptc-subagents/docs/">
          <strong v-html="m.footnav[0].strong"></strong><span v-html="m.footnav[0].span"></span>
        </a>
        <a href="https://www.npmjs.com/package/pi-ptc-subagents">
          <strong v-html="m.footnav[1].strong"></strong><span v-html="m.footnav[1].span"></span>
        </a>
      </span>
    </footer>
  </div>
</template>

<style scoped>
.lpb {
  --bg: #0a0a14;
  --fg: #eef0ff;
  --dim: #a0a4c4;
  --line: rgba(255, 255, 255, 0.09);
  --acc1: #7c8cff;
  --acc2: #c86bff;
  min-height: 100vh;
  background:
    radial-gradient(1000px 500px at 15% -5%, rgba(124, 140, 255, 0.18), transparent 55%),
    radial-gradient(800px 500px at 90% 0%, rgba(200, 107, 255, 0.14), transparent 55%),
    var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif;
}
.lpb-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line);
}
.lpb-logo {
  font-weight: 800;
  letter-spacing: -0.02em;
}
.lpb-logo em {
  font-style: normal;
  background: linear-gradient(90deg, var(--acc1), var(--acc2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lpb-navright {
  display: flex;
  align-items: center;
  gap: 20px;
}
.lpb-lang {
  display: inline-flex;
  gap: 4px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
  font-size: 12px;
}
.lpb-lang button {
  border: none;
  background: transparent;
  color: var(--dim);
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
  font-family: inherit;
}
.lpb-lang button.on {
  background: var(--fg);
  color: var(--bg);
  font-weight: 700;
}
.lpb-links {
  display: flex;
  gap: 18px;
}
.lpb-links a {
  color: var(--dim);
  text-decoration: none;
  font-size: 13.5px;
}
.lpb-links a:hover {
  color: var(--fg);
}
.lpb-hero {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  gap: 44px;
  align-items: center;
  max-width: 1120px;
  margin: 0 auto;
  padding: 64px 24px 48px;
}
.lpb-kicker {
  color: var(--acc1);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.1em;
  margin: 0 0 14px;
}
.lpb-hero h1 {
  font-size: clamp(34px, 5vw, 54px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0 0 18px;
}
.lpb-lede {
  color: var(--dim);
  line-height: 1.9;
  font-size: 15px;
  margin: 0 0 26px;
}
.lpb-lede a {
  color: var(--fg);
}
.lpb-lede code,
.lpb-note code {
  background: rgba(255, 255, 255, 0.07);
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--fg);
  font-size: 0.9em;
}
.lpb-chips {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.lpb-chip {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--fg);
  font-family: inherit;
  transition: border-color 0.2s;
}
.lpb-chip:hover {
  border-color: rgba(124, 140, 255, 0.55);
}
.lpb-chip-label {
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: linear-gradient(90deg, var(--acc1), var(--acc2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  width: 34px;
  text-align: right;
}
.lpb-chip code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.lpb-chip-copy {
  color: var(--dim);
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
}
.lpb-note {
  color: var(--dim);
  font-size: 13px;
  margin-top: 18px;
  line-height: 1.8;
  max-width: 560px;
}
.lpb-term {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(8, 8, 18, 0.75);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.lpb-term-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
  font-size: 12px;
}
.lpb-term-bar i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
}
.lpb-term-bar i:first-child {
  background: #ff5f57;
}
.lpb-term-bar i:nth-child(2) {
  background: #febc2e;
}
.lpb-term-bar i:nth-child(3) {
  background: #28c840;
}
.lpb-term-bar span {
  margin-left: 8px;
}
.lpb-term pre {
  margin: 0;
  padding: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.8px;
  line-height: 1.75;
  overflow-x: auto;
}
.lpb-s {
  color: #8ee08e;
}
.lpb-ok {
  color: #8ee08e;
}
.lpb-dim {
  color: var(--dim);
}
.lpb-bento {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 18px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 8px 24px 64px;
}
.lpb-b {
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 24px;
  background: linear-gradient(150deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.015));
  backdrop-filter: blur(6px);
}
.lpb-b-wide {
  grid-column: span 2;
}
.lpb-b h3 {
  margin: 0 0 10px;
  font-size: 17px;
}
.lpb-beyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  background: linear-gradient(90deg, var(--acc1), var(--acc2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lpb-b > p {
  color: var(--dim);
  line-height: 1.8;
  font-size: 14px;
  margin: 0 0 14px;
}
.lpb-b code {
  color: var(--fg);
  font-size: 0.92em;
}
.lpb-b pre {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.7;
  margin: 0;
}
.lpb-b pre i {
  color: var(--dim);
}
.lpb-bfoot {
  color: var(--dim);
  font-size: 13px;
  margin-top: 14px !important;
}
.lpb-gaps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 16px;
}
.lpb-gaps b {
  display: block;
  color: var(--fg);
  margin-bottom: 4px;
  font-size: 14.5px;
}
.lpb-gaps span {
  color: var(--dim);
  line-height: 1.75;
  font-size: 13.5px;
}
.lpb-b-warn {
  border-color: rgba(255, 95, 87, 0.35);
}
.lpb-trust {
  margin: 0;
  padding-left: 18px;
  color: var(--dim);
  font-size: 14px;
  line-height: 1.9;
  display: grid;
  gap: 10px;
}
.lpb-trust strong {
  color: var(--fg);
}
.lpb-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px;
  border-top: 1px solid var(--line);
  color: var(--dim);
  font-size: 13px;
}
.lpb-footlinks {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}
.lpb-footlinks a {
  color: var(--dim);
  text-decoration: none;
}
.lpb-footlinks a:hover {
  color: var(--fg);
}
.lpb-footlinks strong {
  color: var(--fg);
  margin-right: 6px;
}
.lpb-badge {
  display: inline-block;
  margin: 0 0 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(124, 140, 255, 0.5);
  color: var(--acc1);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.lpb-flowlede {
  color: var(--dim);
  font-size: 13.5px;
  margin: 0 0 18px;
}
.lpb-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.lpb-steps li {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(8, 8, 18, 0.55);
  padding: 14px;
  position: relative;
}
.lpb-stepnum {
  position: absolute;
  top: 10px;
  right: 12px;
  color: rgba(255, 255, 255, 0.18);
  font: 800 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.lpb-steps h4 {
  margin: 0 0 10px;
  font-size: 14.5px;
}
.lpb-fchips {
  display: grid;
  gap: 8px;
}
.lpb-fchip {
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 8px;
  align-items: baseline;
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12.3px;
  line-height: 1.55;
}
.lpb-fchip b {
  font-size: 10.5px;
  letter-spacing: 0.08em;
}
.lpb-fchip.pi {
  background: rgba(124, 140, 255, 0.1);
}
.lpb-fchip.pi b {
  color: var(--acc1);
}
.lpb-fchip.kimi {
  background: rgba(255, 84, 112, 0.09);
}
.lpb-fchip.kimi b {
  color: #ff5470;
}
.lpb-fchip span {
  color: var(--fg);
}
@media (max-width: 960px) {
  .lpb-steps {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 860px) {
  .lpb-hero {
    grid-template-columns: 1fr;
    padding-top: 44px;
  }
  .lpb-bento {
    grid-template-columns: 1fr;
  }
  .lpb-b-wide {
    grid-column: span 1;
  }
}
</style>
