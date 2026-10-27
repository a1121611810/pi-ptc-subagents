---
layout: landing
---

<script setup>
import { computed, ref } from 'vue'

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
const lang = ref(stored === 'zh' ? 'zh' : 'en')
function setLang(next) {
  lang.value = next
  if (typeof localStorage !== 'undefined') localStorage.setItem('lp-lang', next)
}

const M = {
  en: {
    hero: {
      tag: 'pi calls tools one at a time. This package lets the model write a program that calls them in one go &mdash; and lets that program spawn pi subagents.',
      sub: 'Programmable tool calling and subagent dispatch for <a href="https://pi.dev">pi</a>. Two capabilities, one package, two session surfaces &mdash; detected from the session, never a setting.',
      installNote: 'pi reads the <code>pi.extensions</code> manifest &mdash; installed and on for the next startup. No postinstall hook, no extra setup.',
    },
    cards: [
      {
        num: '01',
        title: 'Programmable tool calling',
        body: '<code>ptc_run_code</code> / <code>ptc_workflow</code> run a TypeScript program in a worker. It reaches the session&rsquo;s tools as <code>tools.&lt;name&gt;(args)</code> &mdash; loops, branches and <code>Promise.all</code> fan-out live in JavaScript, not in a second tool protocol. Only the program&rsquo;s return value and its logs come back to the model.',
      },
      {
        num: '02',
        title: 'Subagent fan-out',
        body: '<code>pi_task_ptc</code> (inside a program) or <code>pi_task_codemode</code> (inside a codemode script) queues a task; the dispatch engine runs it in a fresh <code>pi</code> process with its own context. Busy means wait, not reject. The task face &mdash; <code>ptc_task_list</code> / <code>ptc_task_output</code> / <code>ptc_task_stop</code>, family <code>ptc_task_*</code> &mdash; appears when there is a task record to look at.',
      },
    ],
    surfaces: {
      eyebrow: 'Two surfaces, detected not set',
      h2: 'The same shape on both surfaces.',
      lede: 'On a <code>full_ptc</code> session the PTC tools are registered and the model writes programs directly. On a <code>codemode_ptc</code> session pi&rsquo;s own codemode runs the script, and this package supplies the task door underneath it &mdash; one face, one orchestrator per surface.',
      foot: 'Program-writing (<code>ptc_run_code</code> / <code>ptc_workflow</code>) is the <code>full_ptc</code> face; a codemode session composes with pi&rsquo;s own codemode instead of replacing it. The dispatch doors work on both.',
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
          body: 'Every task gets its own pi process and its own report &mdash; a fenced contract with summary, findings, files touched and usage. Session-level isolation without inventing a task state machine.',
        },
        {
          title: 'Search, where it belongs',
          body: '<code>web_ds_search</code> registers only inside dispatched children, off by default with per-process quota &mdash; the judgment about a source stays with the worker that read it.',
        },
      ],
    },
    trust: {
      eyebrow: 'Before you install',
      h2: 'Trust posture',
      items: [
        'Installing this package grants it the same machine access as any pi extension: <strong>PTC programs run as you, with no OS-level sandbox.</strong>',
        'Bindings mirror the session&rsquo;s <strong>enabled</strong> built-in tools. A session started with <code>--tools &hellip;</code> can only reach those tools from inside a program.',
        'Tool calls made from inside a PTC program execute directly and <strong>bypass pi&rsquo;s <code>tool_call</code> hooks</strong> &mdash; permission gates and path guards included. Do not rely on those guards while this extension is enabled.',
      ],
      foot: 'Source is open and the repository is public &mdash; <code>dist/</code> on npm is the compiled form of what you read.',
      footLink: 'Read the source',
    },
    footnav: [
      { strong: 'Documentation', span: 'seven route booklets, projected from the repository' },
      { strong: 'Status', span: 'ptc runtime &amp; dispatch engine panoramas' },
      { strong: 'Source', span: 'the whole repository' },
      { strong: 'npm', span: 'pi-ptc-subagents' },
    ],
  },
  zh: {
    hero: {
      tag: 'pi 一次只调一个工具。这个包让模型写一段程序一口气调完&mdash;&mdash;还能让这段程序派生 pi 子代理。',
      sub: '面向 <a href="https://pi.dev">pi</a> 的可编程工具调用与子代理派发。两种能力、一个包、两个会话平面&mdash;&mdash;由会话检测，从来不是设置项。',
      installNote: 'pi 读 <code>pi.extensions</code> 清单&mdash;&mdash;装好即生效，下次启动自动开启。无 postinstall 钩子，零额外配置。',
    },
    cards: [
      {
        num: '01',
        title: '可编程工具调用',
        body: '<code>ptc_run_code</code> / <code>ptc_workflow</code> 在 worker 里跑 TypeScript 程序，经 <code>tools.&lt;name&gt;(args)</code> 触达会话工具&mdash;&mdash;循环、分支、<code>Promise.all</code> 并行都写在 JavaScript 里，而不是另一套工具协议。回到模型的只有程序返回值和日志。',
      },
      {
        num: '02',
        title: '子代理派发',
        body: '<code>pi_task_ptc</code>（程序内）或 <code>pi_task_codemode</code>（codemode 脚本内）建任务；派发引擎为每个任务起一个独立的 <code>pi</code> 进程、独立的上下文。撞闸意味着排队等，不是拒绝。任务面&mdash;&mdash;<code>ptc_task_list</code> / <code>ptc_task_output</code> / <code>ptc_task_stop</code>（<code>ptc_task_*</code> 一族）&mdash;&mdash;有任务记录时才出现。',
      },
    ],
    surfaces: {
      eyebrow: '两个平面，检测而非设置',
      h2: '两个平面，同一形态。',
      lede: '<code>full_ptc</code> 会话注册 PTC 工具，模型直接写程序；<code>codemode_ptc</code> 会话由 pi 自带 codemode 跑脚本，本包在底下补上任务门&mdash;&mdash;一个平面一个编排器。',
      foot: '写程序（<code>ptc_run_code</code> / <code>ptc_workflow</code>）是 <code>full_ptc</code> 面的能力；codemode 会话与 pi 自带 codemode 是组合而非替代。派发门两个平面都可用。',
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
          body: '每个任务一个 pi 进程、一份报告&mdash;&mdash;末尾 fenced JSON 契约：summary、findings、files_touched、usage。会话级隔离，不用自造任务状态机。',
        },
        {
          title: '搜索在对的地方',
          body: '<code>web_ds_search</code> 只注册在被派出的子代理里，默认关、每进程配额&mdash;&mdash;来源靠不靠谱的判断力留在读页面的 worker 侧。',
        },
      ],
    },
    trust: {
      eyebrow: '安装之前',
      h2: '信任姿态',
      items: [
        '安装本包等于授予它与任何 pi 扩展相同的机器访问权：<strong>PTC 程序以你的身份运行，无 OS 级沙箱。</strong>',
        '绑定表镜像会话<strong>已启用</strong>的内置工具。以 <code>--tools &hellip;</code> 启动的会话，程序内也只能触达这些工具。',
        'PTC 程序内发出的工具调用直接执行，<strong>绕过 pi 的 <code>tool_call</code> 钩子</strong>&mdash;&mdash;权限门与路径守护一律不生效。启用本扩展期间不要依赖这些守护。',
      ],
      foot: '源码开放、仓库公开&mdash;&mdash;npm 上的 <code>dist/</code> 就是你读到的源码的编译产物。',
      footLink: '去读源码',
    },
    footnav: [
      { strong: '文档', span: '七篇 route 册子，构建时投影自仓库' },
      { strong: '状态', span: 'ptc 运行时与 dispatch 引擎全景' },
      { strong: '源码', span: '整个仓库' },
      { strong: 'npm', span: 'pi-ptc-subagents' },
    ],
  },
}
const m = computed(() => M[lang.value])
</script>

<template>
  <div class="lp">
    <!-- ── hero ─────────────────────────────────────────────────────────── -->
    <header class="lp-hero">
      <div class="lp-lang" role="group" aria-label="Language / 语言">
        <button type="button" :class="{ on: lang === 'en' }" :aria-pressed="lang === 'en'" @click="setLang('en')">EN</button>
        <button type="button" :class="{ on: lang === 'zh' }" :aria-pressed="lang === 'zh'" @click="setLang('zh')">中文</button>
      </div>
      <h1 class="lp-mark">pi-ptc<em>-subagents</em></h1>
      <p class="lp-tag" v-html="m.hero.tag"></p>
      <p class="lp-sub" v-html="m.hero.sub"></p>
      <div class="lp-install">
        <code>pi install npm:pi-ptc-subagents</code>
        <button type="button" @click="copy('pi install npm:pi-ptc-subagents')">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="lp-install-note" v-html="m.hero.installNote"></p>
    </header>

    <!-- ── two capabilities ─────────────────────────────────────────────── -->
    <section class="lp-sec">
      <p class="lp-eyebrow">One package, two capabilities</p>
      <div class="lp-two">
        <article class="lp-card">
          <h3><span class="lp-num">{{ m.cards[0].num }}</span> <span v-html="m.cards[0].title"></span></h3>
          <p v-html="m.cards[0].body"></p>
          <pre><b>ptc_run_code</b>  audit the render path
  ├─ grep: "AssistantMessageComponent"        <i>• 3 files</i>
  ├─ read each hit, keep line + snippet
  └─ return { files, totalLines }             <i>• 1 round trip</i></pre>
        </article>
        <article class="lp-card">
          <h3><span class="lp-num">{{ m.cards[1].num }}</span> <span v-html="m.cards[1].title"></span></h3>
          <p v-html="m.cards[1].body"></p>
          <pre><b>ptc_task_list</b>
  ├─ t-3  audit the render path    <i>running · 41s</i>
  ├─ t-4  check the ADR links      <i>running · 12s</i>
  └─ t-2  verify-dist gate         <i>done · exit 1</i></pre>
        </article>
      </div>
    </section>

    <!-- ── two surfaces ─────────────────────────────────────────────────── -->
    <section class="lp-sec lp-sec-alt">
      <p class="lp-eyebrow">{{ m.surfaces.eyebrow }}</p>
      <h2 class="lp-h2" v-html="m.surfaces.h2"></h2>
      <p class="lp-lede" v-html="m.surfaces.lede"></p>
      <div class="lp-tablewrap">
        <pre>full_ptc      model ──▶ ptc_run_code ──▶ program ──┬──▶ tools.read · grep · edit · …   (session tools)
                                                          └──▶ pi_task_ptc ──▶ pi child ──▶ report

codemode_ptc  model ──▶ codemode script ───────────┬──▶ tools.read · grep · edit · …   (session tools)
                                                   └──▶ pi_task_codemode ──▶ pi child ──▶ report

                                        one call in, one result back — never the calls in between.</pre>
      </div>
      <p class="lp-foot" v-html="m.surfaces.foot"></p>
    </section>

    <!-- ── what you get ─────────────────────────────────────────────────── -->
    <section class="lp-sec">
      <p class="lp-eyebrow">{{ m.get.eyebrow }}</p>
      <div class="lp-gaps">
        <article class="lp-gap">
          <h4 v-html="m.get.cards[0].title"></h4>
          <p v-html="m.get.cards[0].body"></p>
        </article>
        <article class="lp-gap">
          <h4 v-html="m.get.cards[1].title"></h4>
          <p v-html="m.get.cards[1].body"></p>
        </article>
        <article class="lp-gap">
          <h4 v-html="m.get.cards[2].title"></h4>
          <p v-html="m.get.cards[2].body"></p>
        </article>
      </div>
    </section>

    <!-- ── trust posture ────────────────────────────────────────────────── -->
    <section class="lp-sec lp-sec-warn">
      <p class="lp-eyebrow">{{ m.trust.eyebrow }}</p>
      <h2 class="lp-h2" v-html="m.trust.h2"></h2>
      <ul class="lp-trust">
        <li v-for="(item, i) in m.trust.items" :key="i" v-html="item"></li>
      </ul>
      <p class="lp-foot">
        <span v-html="m.trust.foot"></span>
        <a href="https://github.com/a1121611810/pi-ptc-subagents">{{ m.trust.footLink }}</a>.
      </p>
    </section>

    <!-- ── docs ─────────────────────────────────────────────────────────── -->
    <footer class="lp-foot-nav">
      <a href="/pi-ptc-subagents/docs/">
        <strong v-html="m.footnav[0].strong"></strong><span v-html="m.footnav[0].span"></span>
      </a>
      <a href="/pi-ptc-subagents/status/ptc-runtime-status.html">
        <strong v-html="m.footnav[1].strong"></strong><span v-html="m.footnav[1].span"></span>
      </a>
      <a href="https://github.com/a1121611810/pi-ptc-subagents">
        <strong v-html="m.footnav[2].strong"></strong><span v-html="m.footnav[2].span"></span>
      </a>
      <a href="https://www.npmjs.com/package/pi-ptc-subagents">
        <strong v-html="m.footnav[3].strong"></strong><span v-html="m.footnav[3].span"></span>
      </a>
    </footer>
  </div>
</template>
