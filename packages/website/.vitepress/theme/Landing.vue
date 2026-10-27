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
      <p class="lp-tag">pi calls tools one at a time. This package lets the model write a program that calls them in one go &mdash; and lets that program spawn pi subagents.</p>
      <p class="lp-sub">
        Programmable tool calling and subagent dispatch for <a href="https://pi.dev">pi</a>.
        Two capabilities, one package, two session surfaces &mdash; detected from the session,
        never a setting.
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
            <code>ptc_run_code</code> / <code>ptc_workflow</code> run a TypeScript program in a
            worker. It reaches the session's tools as <code>tools.&lt;name&gt;(args)</code> &mdash;
            loops, branches and <code>Promise.all</code> fan-out live in JavaScript, not in a
            second tool protocol. Only the program's return value and its logs come back to the
            model.
          </p>
          <pre><b>ptc_run_code</b>  audit the render path
  ├─ grep: "AssistantMessageComponent"        <i>• 3 files</i>
  ├─ read each hit, keep line + snippet
  └─ return { files, totalLines }             <i>• 1 round trip</i></pre>
        </article>
        <article class="lp-card">
          <h3><span class="lp-num">02</span> Subagent fan-out</h3>
          <p>
            <code>pi_task_ptc</code> (inside a program) or <code>pi_task_codemode</code> (inside a
            codemode script) queues a task; the dispatch engine runs it in a fresh
            <code>pi</code> process with its own context. Busy means wait, not reject. The task
            face &mdash; <code>ptc_task_list</code> / <code>ptc_task_output</code> /
            <code>ptc_task_stop</code>, family <code>ptc_task_*</code> &mdash; appears when there
            is a task record to look at.
          </p>
          <pre><b>ptc_task_list</b>
  ├─ t-3  audit the render path    <i>running · 41s</i>
  ├─ t-4  check the ADR links      <i>running · 12s</i>
  └─ t-2  verify-dist gate         <i>done · exit 1</i></pre>
        </article>
      </div>
    </section>

    <!-- ── two surfaces ─────────────────────────────────────────────────── -->
    <section class="lp-sec lp-sec-alt">
      <p class="lp-eyebrow">Two surfaces, detected not set</p>
      <h2 class="lp-h2">The same shape on both surfaces.</h2>
      <p class="lp-lede">
        On a <code>full_ptc</code> session the PTC tools are registered and the model writes
        programs directly. On a <code>codemode_ptc</code> session pi's own codemode runs the
        script, and this package supplies the task door underneath it &mdash; one face, one
        orchestrator per surface.
      </p>
      <div class="lp-tablewrap">
        <pre>full_ptc      model ──▶ ptc_run_code ──▶ program ──┬──▶ tools.read · grep · edit · …   (session tools)
                                                          └──▶ pi_task_ptc ──▶ pi child ──▶ report

codemode_ptc  model ──▶ codemode script ───────────┬──▶ tools.read · grep · edit · …   (session tools)
                                                   └──▶ pi_task_codemode ──▶ pi child ──▶ report

                                        one call in, one result back — never the calls in between.</pre>
      </div>
      <p class="lp-foot">
        Program-writing (<code>ptc_run_code</code> / <code>ptc_workflow</code>) is the
        <code>full_ptc</code> face; a codemode session composes with pi's own codemode instead of
        replacing it. The dispatch doors work on both.
      </p>
    </section>

    <!-- ── what you get ─────────────────────────────────────────────────── -->
    <section class="lp-sec">
      <p class="lp-eyebrow">What you get</p>
      <div class="lp-gaps">
        <article class="lp-gap">
          <h4>One program, many tool calls</h4>
          <p>
            Results are filtered and reduced before they reach the model. Output over the
            truncation threshold is tail-noted with a path to the full text &mdash; never an
            escaped-JSON wall.
          </p>
        </article>
        <article class="lp-gap">
          <h4>Real subagents</h4>
          <p>
            Every task gets its own pi process and its own report &mdash; a fenced contract with
            summary, findings, files touched and usage. Session-level isolation without inventing
            a task state machine.
          </p>
        </article>
        <article class="lp-gap">
          <h4>Search, where it belongs</h4>
          <p>
            <code>web_ds_search</code> registers only inside dispatched children, off by default
            with per-process quota &mdash; the judgment about a source stays with the worker that
            read it.
          </p>
        </article>
      </div>
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
        <strong>Documentation</strong><span>seven route booklets, projected from the repository</span>
      </a>
      <a href="/pi-ptc-subagents/status/ptc-runtime-status.html">
        <strong>Status</strong><span>ptc runtime &amp; dispatch engine panoramas</span>
      </a>
      <a href="https://github.com/a1121611810/pi-ptc-subagents">
        <strong>Source</strong><span>the whole repository</span>
      </a>
      <a href="https://www.npmjs.com/package/pi-ptc-subagents">
        <strong>npm</strong><span>pi-ptc-subagents</span>
      </a>
    </footer>
  </div>
</template>
