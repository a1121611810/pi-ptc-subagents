---
layout: landing
---

<script setup>
import { ref } from 'vue'

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
</script>

<template>
  <div class="lp">
    <!-- ── hero ─────────────────────────────────────────────────────────── -->
    <header class="lp-hero">
      <h1 class="lp-mark">pi-ptc<em>-subagents</em></h1>
      <p class="lp-tag">pi ships no sub-agents. This is the package that adds them.</p>
      <p class="lp-sub">
        Programmable tool calling and subagent fan-out for <a href="https://pi.dev">pi</a>.
        The model writes a JS/TS program that composes pi's tools, or fans out to a
        fresh pi subprocess per task &mdash; one round trip instead of many.
      </p>
      <div class="lp-install">
        <code>pi install npm:pi-ptc-subagents</code>
        <button type="button" @click="copy('pi install npm:pi-ptc-subagents')">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="lp-install-note">
        pi reads the <code>pi.extensions</code> manifest &mdash; installed and on for the next
        startup. No postinstall hook, no extra setup.
      </p>
    </header>

    <!-- ── two capabilities ─────────────────────────────────────────────── -->
    <section class="lp-sec">
      <p class="lp-eyebrow">One package, two capabilities</p>
      <div class="lp-two">
        <article class="lp-card">
          <h3><span class="lp-num">01</span> Programmable tool calling</h3>
          <p>
            <code>ptc_run_code</code> / <code>ptc_workflow</code> run a JS/TS program in a worker.
            It reaches the session's tools as <code>tools.&lt;name&gt;(args)</code>. Only the
            program's return value and its logs come back to the model.
          </p>
          <pre><b>PTC</b>  Find AssistantMessageComponent instantiations
  ├─ file: "chat-viewport.ts"        <i>• 1 output line · 1.42s</i>
  ├─ instantiations: Array(3)
  │  ├─ [0] {file: "chat-viewport.ts", line: 23}
  │  ├─ [1] {file: "chat-viewport.ts", line: 47}
  │  └─ [2] {file: "chat-viewport.ts", line: 91}
  └─ totalLines: 47</pre>
        </article>
        <article class="lp-card">
          <h3><span class="lp-num">02</span> Subagent fan-out</h3>
          <p>
            The <code>pi.dispatch</code> binding spawns a fresh <code>pi</code> subprocess per call,
            so each task gets its own context. Foreground await, or background with a lifecycle you
            can list, read and stop.
          </p>
          <pre><b>ptc_task_list</b>
  ├─ t-3  audit the render path    <i>running · 41s</i>
  ├─ t-4  check the ADR links      <i>running · 12s</i>
  └─ t-2  verify-dist gate         <i>done · exit 1</i></pre>
        </article>
      </div>
    </section>

    <!-- ── what pi deliberately doesn't build ───────────────────────────── -->
    <section class="lp-sec lp-sec-alt">
      <p class="lp-eyebrow">What pi deliberately doesn't build</p>
      <h2 class="lp-h2">pi's core stays minimal. This is the package that fills the gaps.</h2>
      <p class="lp-lede">
        <a href="https://pi.dev">pi's own product page</a> lists the features it left out, and
        offers extensions or a third-party package as the alternative. Three of those gaps are what
        this package is for &mdash; the rest it composes with rather than replaces.
      </p>
      <div class="lp-gaps">
        <article class="lp-gap">
          <s>No sub-agents</s>
          <h4>&rarr; fan-out, in-process or background</h4>
          <p>
            <code>pi.dispatch</code> plus <code>ptc_task_list</code> /
            <code>ptc_task_output</code> / <code>ptc_task_stop</code>. Session-level isolation
            without inventing a task state machine.
          </p>
        </article>
        <article class="lp-gap">
          <s>No plan mode</s>
          <h4>&rarr; program the plan instead</h4>
          <p>
            Loops, branches and fan-out live in JavaScript, where the model can express them
            &mdash; not in a second tool protocol.
          </p>
        </article>
        <article class="lp-gap">
          <s>No background bash</s>
          <h4>&rarr; long-lived, inspectable</h4>
          <p>
            Background dispatch hands back a handle, not a tmux pane. List it, read it, stop it.
          </p>
        </article>
      </div>
    </section>

    <!-- ── comparison ───────────────────────────────────────────────────── -->
    <section class="lp-sec">
      <p class="lp-eyebrow">If you already run codemode</p>
      <h2 class="lp-h2">What you get, by pi</h2>
      <p class="lp-lede">
        Three configurations, three different answers. The <code>subagents</code> line exists
        because a QuickJS sandbox cannot spawn a process at all &mdash; handing the program face
        away there would delete the capability rather than hand it over.
      </p>
      <div class="lp-tablewrap">
        <table class="lp-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th class="c">pi alone</th>
              <th class="c">+ codemode</th>
              <th class="c">+ this</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Write a program that composes tools<small><code>ptc_run_code</code> / <code>ptc_workflow</code></small></td>
              <td class="c no">&mdash;</td><td class="c yes">✓</td><td class="c yes">✓</td>
            </tr>
            <tr>
              <td>A real Node runtime inside the program<small>no OS sandbox</small></td>
              <td class="c no">&mdash;</td><td class="c no">QuickJS</td><td class="c yes">✓</td>
            </tr>
            <tr>
              <td>Spawn a fresh <code>pi</code> subprocess<small><code>pi.dispatch</code></small></td>
              <td class="c no">&mdash;</td><td class="c no">&mdash;</td><td class="c yes">✓</td>
            </tr>
            <tr>
              <td>Background tasks you can list, read and stop<small><code>ptc_task_*</code></small></td>
              <td class="c no">&mdash;</td><td class="c no">&mdash;</td><td class="c yes">✓</td>
            </tr>
            <tr>
              <td>Top-level subagent call, no program needed<small><code>ptc_subagent</code></small></td>
              <td class="c no">&mdash;</td><td class="c yes">✓</td><td class="c yes">✓</td>
            </tr>
            <tr>
              <td>Value-tree TUI rendering<small>never escaped JSON</small></td>
              <td class="c no">&mdash;</td><td class="c no">&mdash;</td><td class="c yes">✓</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="lp-foot">
        Two columns reading the same: on <code>codemode</code> the pair registers underneath as an
        execution layer, so a script can reach what the sandbox cannot.
      </p>
    </section>

    <!-- ── trust posture ────────────────────────────────────────────────── -->
    <section class="lp-sec lp-sec-warn">
      <p class="lp-eyebrow">Before you install</p>
      <h2 class="lp-h2">Trust posture</h2>
      <ul class="lp-trust">
        <li>
          Installing this package grants it the same machine access as any pi extension:
          <strong>PTC programs run as you, with no OS-level sandbox.</strong>
        </li>
        <li>
          Bindings mirror the session's <strong>enabled</strong> built-in tools. A session started
          with <code>--tools …</code> can only reach those tools from inside a program.
        </li>
        <li>
          Tool calls made from inside a PTC program execute directly and <strong>bypass pi's
          <code>tool_call</code> hooks</strong> &mdash; permission gates and path guards included.
          Do not rely on those guards while this extension is enabled.
        </li>
      </ul>
      <p class="lp-foot">
        Source is open and the repository is public &mdash; <code>dist/</code> on npm is the compiled
        form of what you read.
        <a href="https://github.com/a1121611810/pi-ptc-subagents">Read the source</a>.
      </p>
    </section>

    <!-- ── docs ─────────────────────────────────────────────────────────── -->
    <footer class="lp-foot-nav">
      <a href="/pi-ptc-subagents/docs/">
        <strong>Documentation</strong><span>install, surface detection, dispatch, results</span>
      </a>
      <a href="https://github.com/a1121611810/pi-ptc-subagents">
        <strong>Source</strong><span>the whole repository</span>
      </a>
      <a href="https://www.npmjs.com/package/pi-ptc-subagents">
        <strong>npm</strong><span>pi-ptc-subagents</span>
      </a>
      <a href="https://github.com/a1121611810/pi-ptc-subagents/issues">
        <strong>Issues</strong><span>bugs and features</span>
      </a>
    </footer>
  </div>
</template>
