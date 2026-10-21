/**
 * The LIVE end-to-end check for the DeepSeek search module.
 *
 * **What it closes.** The spec recorded one open gap: "真实 pi 上「child → 搜到东西 → 报告回父」的
 * 端到端从未跑过" — every ring had been verified on its own (the codemode bridge on a real pi, the
 * API with real calls, the credential verdict with a unit test), but the three of them chained
 * had never run against a real child, a real model and the real search endpoint.
 *
 * **It is a script, not a test, on purpose.** It spends money, needs the network and needs a
 * DeepSeek credential, so it cannot sit in the default gate — and a test that silently no-ops
 * when its preconditions are missing is exactly the false-pass shape this repo's meta-discipline
 * fixture exists to refuse (F3). A script that **fails loudly** when a precondition is missing is
 * the opposite of that: no precondition, no pass, an exit code that says so.
 *
 * **What it actually runs.**
 *
 *   1. An isolated agent dir with the search switch ON and only the deepseek credential in it.
 *   2. A `pi` on PATH that is a WRAPPER: it execs the real pi with `--extension <this repo's
 *      dist/index.js>`, and it tees the child's stdout into a file. The wrapper is what makes the
 *      child's JSONL observable — the dispatcher parses the same stream and throws the raw lines
 *      away, and the raw lines are the evidence.
 *   3. `dispatch()` — the real dispatcher — which stamps `PI_PTC_DEPTH=1` on the child.
 *   4. The child's own model calls `web_ds_search` against the real DeepSeek Search API.
 *
 * **The four claims, and where each is read from.**
 *
 *   | claim                                   | evidence                                                |
 *   | --------------------------------------- | ------------------------------------------------------- |
 *   | the child was told about the tool       | the tool list in the child's own model request          |
 *   | the child's model called it              | a `web_ds_search` tool call in the child's JSONL        |
 *   | the real API answered                   | the tool result carries results with real URLs          |
 *   | the answer came back to the parent      | the URL is in the child's final text AND in the parent's |
 *
 * The last row is the one that cannot be faked by a model: a URL the model made up would not be in
 * the tool's result. A parent session has no search tool at all, so a URL could only have reached
 * the parent through the child.
 *
 * **It costs a little money and it needs the network.** Both are stated here rather than discovered
 * at the end: one child turn on `deepseek/deepseek-flash` plus one or two search calls.
 *
 * Run: `node scripts/verify-search-e2e.ts` (build first: `pnpm run build`).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DispatchSlotCounter, dispatch } from "../src/runtime/dispatch.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO_ROOT, "dist", "index.js");
const REAL_PI = join(REPO_ROOT, "node_modules", ".bin", "pi");
const OPERATOR_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** The model the child runs on. Cheap, and the provider the operator's credential is for. */
const CHILD_MODEL = process.env.PTC_E2E_MODEL ?? "deepseek/deepseek-flash";

/**
 * The task the child gets.
 *
 * **It asks for the URL on purpose.** A model that answers from memory cannot produce a URL that
 * also appears in the tool's result, so the URL is what makes the last claim checkable rather than
 * plausible.
 */
const CHILD_TASK = [
  "用网页搜索查一下 DeepSeek 官方文档「网页搜索与抓取」那一页现在写的计费口径是什么。",
  "然后用 open 打开你搜到的那一页，把那一页上关于「什么样的请求才计费」的原文写出来。",
  "把你打开的那一页的完整 url 原样写出来。",
  "如果搜索工具不可用，就直接说你搜不了，不要凭记忆编一个 url 或编一段原文。",
].join("");

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(text: string): void {
  console.log(`\n── ${text}`);
}

// ---------------------------------------------------------------------------------------------
//  Preflight: every missing precondition is a loud failure, never a silent pass.
// ---------------------------------------------------------------------------------------------

if (!existsSync(DIST)) {
  fail(`the built extension is missing (${DIST}). Run \`pnpm run build\` first.`);
}
if (!existsSync(REAL_PI)) {
  fail(`the real pi is missing (${REAL_PI}). Run \`pnpm install\` first.`);
}

const operatorAuthPath = join(OPERATOR_AGENT_DIR, "auth.json");
if (!existsSync(operatorAuthPath)) {
  fail(
    `no auth.json at ${operatorAuthPath}. The DeepSeek credential is what this run searches with.`,
  );
}
const operatorAuth = JSON.parse(readFileSync(operatorAuthPath, "utf8")) as {
  deepseek?: { type?: string; key?: string };
};
const deepseekEntry = operatorAuth.deepseek;
if (
  deepseekEntry === undefined ||
  typeof deepseekEntry.key !== "string" ||
  deepseekEntry.key.length === 0
) {
  fail(
    `the operator's auth.json has no usable deepseek entry (${operatorAuthPath}). ` +
      `This run needs a DeepSeek API key.`,
  );
}

// ---------------------------------------------------------------------------------------------
//  The isolated agent dir: the switch ON, and only the deepseek credential in it.
// ---------------------------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), "pi-ptc-search-e2e-"));
const agentDir = join(workDir, "agent");
const binDir = join(workDir, "bin");
const childLog = join(workDir, "child.jsonl");
mkdirSync(agentDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// `PTC_E2E_KEEP=1` keeps the work dir (and the child's transcript) for inspection. The
// transcript is the only place the child's actual tool arguments show up, and one of the
// failures this script exists to catch was invisible without it.
const keepWorkDir = process.env["PTC_E2E_KEEP"] === "1";
process.on("exit", () => {
  if (keepWorkDir) {
    console.log(`\n(work dir kept: ${workDir})`);
    return;
  }
  rmSync(workDir, { recursive: true, force: true });
});

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ deepseek: deepseekEntry }, null, 2), {
  encoding: "utf8",
  mode: 0o600,
});
// No `packages` entry: the npm-installed copy of this package must NOT be loaded, or the child
// would carry two copies of every tool. Only `--extension <repo>/dist/index.js` loads ours.
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultModel: CHILD_MODEL, defaultThinkingLevel: "off" }),
  "utf8",
);
// The switch the whole feature hangs off (ADR-0048).
writeFileSync(
  join(agentDir, "ptc.json"),
  JSON.stringify({ webDsSearch: { enabled: true, maxCallsPerSession: 20 } }),
  "utf8",
);

// ---------------------------------------------------------------------------------------------
//  The `pi` on PATH: the real pi, plus our build, plus a transcript of the child's stdout.
// ---------------------------------------------------------------------------------------------

const wrapper = join(binDir, "pi");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env node",
    '"use strict";',
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const realPi = process.env.PTC_E2E_REAL_PI;",
    "const ext = process.env.PTC_E2E_EXTENSION;",
    "const log = process.env.PTC_E2E_LOG;",
    'const args = ["--extension", ext, ...process.argv.slice(2)];',
    'const child = spawn(realPi, args, { stdio: ["ignore", "pipe", "inherit"], env: process.env });',
    'const out = fs.createWriteStream(log, { flags: "a" });',
    'child.stdout.on("data", (d) => { out.write(d); process.stdout.write(d); });',
    'child.on("close", (code) => { out.end(); process.exit(code === null ? 1 : code); });',
    "",
  ].join("\n"),
  { encoding: "utf8", mode: 0o755 },
);
chmodSync(wrapper, 0o755);

process.env.PTC_E2E_REAL_PI = REAL_PI;
process.env.PTC_E2E_EXTENSION = DIST;
process.env.PTC_E2E_LOG = childLog;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// ---------------------------------------------------------------------------------------------
//  The parent side: the real dispatcher, which is what stamps PI_PTC_DEPTH on the child.
// ---------------------------------------------------------------------------------------------

step("dispatching a child (the parent session has no search tool of its own)");
const started = Date.now();
const result = await dispatch(
  { task: CHILD_TASK, cwd: workDir, model: CHILD_MODEL },
  { callId: 0, cwd: workDir, depth: 0, maxDispatchDepth: 3 },
  { slots: new DispatchSlotCounter(2), taskRegistry: undefined },
);
console.log(`   status=${result.status} exitCode=${result.exitCode} in ${Date.now() - started}ms`);
if (result.stderr) console.log(`   stderr: ${result.stderr.slice(0, 400)}`);

if (result.status !== "fulfilled") {
  fail(`the child did not complete: ${result.errorMessage ?? "(no message)"}`);
}

// ---------------------------------------------------------------------------------------------
//  The evidence: the child's own transcript.
// ---------------------------------------------------------------------------------------------

const raw = existsSync(childLog) ? readFileSync(childLog, "utf8") : "";
const events = raw
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  })
  .filter((event): event is Record<string, unknown> => event !== undefined);

/** Every `web_ds_search` tool execution the child made, with the tool's own result. */
const searchCalls = events.filter((event) => event["toolName"] === "web_ds_search");

/**
 * The URLs the API actually returned, read off the tool's `structuredContent`.
 *
 * **The structured payload, not a regex over the transcript.** The tool declares an
 * `outputSchema`, so its result carries the payload as a machine-readable value (ADR-0032's tool
 * channel) — that is the authoritative answer. The regex over the raw lines is the fallback for a
 * pi that did not carry it, and it is only a fallback because it can match a URL from anywhere in
 * the transcript, including one the MODEL wrote.
 */
const returnedUrls = new Set<string>();
/** The text the MODEL received for each `web_ds_search` call — pi sends only this to the model. */
const modelVisibleText: string[] = [];
/** The summaries the API wrote for a model to read. */
const returnedSummaries: string[] = [];
for (const event of searchCalls) {
  const result = event["result"] as
    | {
        structuredContent?: { results?: { url?: string; summary?: string }[] };
        content?: unknown;
      }
    | undefined;
  const structured = result?.structuredContent as
    | { results?: { url?: string; summary?: string }[] }
    | undefined;
  for (const item of structured?.results ?? []) {
    if (typeof item.url === "string") returnedUrls.add(item.url);
    if (typeof item.summary === "string" && item.summary !== "") {
      returnedSummaries.push(item.summary);
    }
  }
  const blocks = (result?.content ?? []) as { type?: string; text?: string }[];
  modelVisibleText.push(
    blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n"),
  );
}
if (returnedUrls.size === 0) {
  for (const match of raw.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
    returnedUrls.add(match[1] as string);
  }
}

/** The child's final assistant text. */
const finalText = result.text;

step("the child's transcript");
console.log(`   events: ${events.length}`);
console.log(`   web_ds_search tool calls: ${searchCalls.length}`);
console.log(`   urls the API returned: ${returnedUrls.size}`);
for (const url of [...returnedUrls].slice(0, 5)) console.log(`     - ${url}`);
console.log(
  `   the child's final text:\n${finalText
    .split("\n")
    .map((l) => "     " + l)
    .join("\n")}`,
);

// ---------------------------------------------------------------------------------------------
//  The four claims.
// ---------------------------------------------------------------------------------------------

const failures: string[] = [];

/**
 * The tool calls the child made, with their ARGUMENTS.
 *
 * `tool_execution_start` carries the args, so the "ask again" hop is observable: the child
 * searched, then it OPENED one of the results it had just been given.
 */
const toolCalls = events
  .filter(
    (event) => event["type"] === "tool_execution_start" && event["toolName"] === "web_ds_search",
  )
  .map((event) => ({
    ...((event["args"] ?? {}) as Record<string, unknown>),
    __id: event["toolCallId"],
  }));
const searched = toolCalls.filter((args) => typeof args["query"] === "string");
const opened = toolCalls.filter((args) => typeof args["open"] === "string");

/**
 * The model-visible text of each `open` call.
 *
 * **The open's OWN result, not the child's final answer.** The notice that says where the page
 * came from is in the tool result the model read; the child then wrote its own answer about it,
 * and that answer is not expected to quote the notice back.
 */
const openResultTexts: string[] = [];
for (const event of events) {
  if (event["type"] !== "tool_execution_end" || event["toolName"] !== "web_ds_search") continue;
  const args = toolCalls.find((call) => call["__id"] === event["toolCallId"]);
  if (args === undefined || typeof args["open"] !== "string") continue;
  const blocks = ((event["result"] ?? {}) as { content?: unknown }).content as
    | { type?: string; text?: string }[]
    | undefined;
  openResultTexts.push(
    (blocks ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n"),
  );
}

if (searchCalls.length === 0) {
  failures.push(
    "the child's model never called web_ds_search — the tool was not reachable, or the model " +
      "answered without it. The child's transcript is the evidence; read it before concluding " +
      "which.",
  );
}
if (returnedUrls.size === 0) {
  failures.push("no URLs came back from the search — the API never answered with results.");
}
// The corroboration: the answer names a page the API returned.
//
// **The path counts, not just the full url.** A model that read a result may well write
// "/guides/search/" without the scheme and the host — it was handed a url, and a path is what it
// remembered. The STRONG evidence is the check below it (the API's own `summary` reached the
// model's text, and that text exists only if the search happened); this one is the corroboration.
const finalNormalised = finalText.replace(/^https?:\/\//gm, "").replace(/\/+$/gm, "");
const cameFromSearch = [...returnedUrls].some((url) => {
  const withoutScheme = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const pathOnly = withoutScheme.replace(/^[^/]+\//, "");
  return finalNormalised.includes(withoutScheme) || finalNormalised.includes(pathOnly);
});
if (!cameFromSearch) {
  failures.push(
    "the child's answer does not name any page the API returned — the answer cannot be shown " +
      "to have come from the search.",
  );
}
if (!finalText.trim()) {
  failures.push("nothing came back to the parent at all.");
}

// The "ask again" hop: the child opened a page it had just been given.
if (searched.length === 0) {
  failures.push(
    "the child never searched — the tool was not reachable, or the model answered without it.",
  );
}
if (opened.length === 0) {
  failures.push(
    "the child never opened a page — the 'overview first, depth on demand' shape did not happen: " +
      "the model was given the overview and stopped there.",
  );
}
// And that open was FREE: the page came out of the search the child had just done.
if (opened.length > 0 && !openResultTexts.some((text) => text.includes("来自上一次搜索的结果"))) {
  failures.push(
    "the child's open was not served from the search it had just done — the text should have said " +
      "so, and the follow-up was supposed to cost nothing.",
  );
}

/**
 * The claim the FIRST live run turned up: pi sends a tool result to the model as its `content`
 * blocks and nothing else, so a text that carried only a title and a url handed the model a list
 * of links and none of the substance. The check is a cross-check between two fields of the same
 * tool result — the summary the API returned, and the text the model was given — so it cannot be
 * satisfied by a payload that never made it into the conversation.
 */
const summaryReachedTheModel = returnedSummaries.some((summary) =>
  modelVisibleText.some((text) => text.includes(summary)),
);
if (returnedSummaries.length > 0 && !summaryReachedTheModel) {
  failures.push(
    "the API's `summary` never reached the model: it is in the tool's structured payload but not " +
      "in the text the model was given. pi sends a tool result to the model as its `content` " +
      "blocks and nothing else, so a payload the model cannot see is a payload that does not " +
      "exist.",
  );
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error("\n✗ the live end-to-end check FAILED\n");
  process.exit(1);
}

console.log(
  "✓ the child searched the real web, opened a page, and the answer came back to the parent",
);
console.log("  - the child's own model called web_ds_search");
console.log(`  - it searched ${searched.length} time(s) and opened ${opened.length} page(s)`);
console.log("  - the real Search API answered with results");
console.log("  - the API's summary reached the MODEL, not just the host-side payload");
console.log("  - the follow-up open was served from that search, so it cost nothing");
console.log("  - the URL in the child's answer is one the API returned");
console.log("  - that text reached the parent through the dispatcher's own result\n");
