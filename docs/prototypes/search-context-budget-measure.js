/**
 * PROTOTYPE (throwaway) — measure what a real search actually costs a child's context.
 *
 * **The question this answers**: the search module hands the model every result's `summary`, and
 * every page's `content` when `need_content` is on. Nobody has measured how big that text really
 * is, so nobody can say what a bound should be.
 *
 * **It measures against the real API, not a fixture.** Four real searches against DeepSeek's
 * Search endpoint, recording the real field lengths. The numbers in the measurements note come
 * from here.
 *
 * **It prints a JSON blob** that the prototype HTML embeds, so the prototype runs on measured
 * data rather than on made-up sizes.
 *
 * Run: `node docs/prototypes/search-context-budget-measure.js`
 *
 * The credential is read from the operator's own pi agent dir (`auth.json`'s `deepseek` entry) and
 * is never printed. The key is sent and forgotten.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const ENDPOINT = "https://api.deepseek.com/v1/tools/search";

/** The credential: the operator's own deepseek entry, resolved by nothing but pi's own file. */
function readKey() {
  const auth = JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8"));
  const entry = auth.deepseek;
  if (entry === undefined || typeof entry.key !== "string" || entry.key.length === 0) {
    console.error("no deepseek key in " + join(AGENT_DIR, "auth.json"));
    process.exit(1);
  }
  return entry.key;
}

const KEY = readKey();

/** The calls: varied enough that the sizes are not one lucky query's. */
const CALLS = [
  {
    label: "chinese-pricing",
    query: "DeepSeek 搜索 API 计费 单价",
    count: 10,
    need_content: false,
  },
  { label: "chinese-docs", query: "DeepSeek 网页搜索与抓取 文档", count: 10, need_content: false },
  {
    label: "english-docs",
    query: "pi coding agent extension api documentation",
    count: 10,
    need_content: false,
  },
  { label: "with-content", query: "DeepSeek 搜索 API 文档 计费", count: 5, need_content: true },
];

async function search(body) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return await response.json();
}

/** The model-facing text the module builds today: every summary, every content. */
function currentTextSize(results) {
  let chars = 0;
  for (const result of results) {
    chars += result.title.length + result.url.length + 40;
    chars += result.summary.length;
    if (result.content) chars += result.content.length + 10;
  }
  return chars;
}

const measurements = [];

for (const call of CALLS) {
  const payload = await search({
    query: call.query,
    count: call.count,
    ...(call.need_content ? { need_content: true } : {}),
  });
  const results = payload.results ?? [];
  const summaries = results.map((r) => r.summary.length);
  const contents = results.map((r) => (r.content ?? "").length).filter((n) => n > 0);
  const titles = results.map((r) => r.title.length);
  const sorted = [...summaries].sort((a, b) => a - b);
  measurements.push({
    label: call.label,
    query: call.query,
    count: call.count,
    need_content: call.need_content,
    results: results.length,
    summaryChars: {
      min: sorted[0] ?? 0,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      total: summaries.reduce((a, b) => a + b, 0),
    },
    contentChars: {
      count: contents.length,
      min: contents.length > 0 ? Math.min(...contents) : 0,
      max: contents.length > 0 ? Math.max(...contents) : 0,
      total: contents.reduce((a, b) => a + b, 0),
    },
    titleChars: {
      min: titles.length > 0 ? Math.min(...titles) : 0,
      max: titles.length > 0 ? Math.max(...titles) : 0,
    },
    currentTextChars: currentTextSize(results),
    // The same call WITHOUT the page bodies: what the module costs when `need_content` is off.
    textWithoutContentChars: currentTextSize(results.map((r) => ({ ...r, content: "" }))),
    sample: results.map((r) => ({
      title: r.title,
      url: r.url,
      // `snippet` is the API's OWN short, query-related digest (100-200 chars) — the field a
      // digest-shaped result should use, rather than a cut of the long `summary`.
      snippet: r.snippet ?? "",
      summary: r.summary,
      content: r.content ?? "",
      authority: r.authority,
      rerank_score: r.rerank_score,
    })),
    snippetChars: {
      min: Math.min(...results.map((r) => (r.snippet ?? "").length)),
      max: Math.max(...results.map((r) => (r.snippet ?? "").length)),
      total: results.reduce((a, r) => a + (r.snippet ?? "").length, 0),
    },
  });
  console.log(
    `${call.label}: ${results.length} results · summary ${sorted[0] ?? 0}–${sorted[sorted.length - 1] ?? 0} chars` +
      ` · current text ${currentTextSize(results)} chars`,
  );
}

writeFileSync(
  join(import.meta.dirname, "search-context-budget-data.json"),
  JSON.stringify({ measuredAt: new Date().toISOString(), measurements }, null, 2),
  "utf8",
);
console.log("\nwrote search-context-budget-data.json");
