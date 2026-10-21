# Web search (DeepSeek)

The DeepSeek search module gives a dispatched child two things it cannot otherwise reach: a
way to search the live web, and a way to pull one page's text. It is **off by default**, and it
**only exists inside a dispatched child** — a parent session does not have it at all
([ADR-0049](../adr/0049-the-search-lives-in-the-child.md)).

## Where it lives

| session                    | what it has                                                                       |
| -------------------------- | --------------------------------------------------------------------------------- |
| a parent session           | **nothing** — the tool is not registered, and no credential is read               |
| a dispatched child         | the tool `web_ds_search`, model-facing: the child's own model calls it            |
| a child, switch off        | nothing                                                                           |
| a child, switch on, no key | the tool, marked unavailable; a call fails with a sentence naming what is missing |

The gate is two conditions, both required: the **switch** (`webDsSearch.enabled`) and **being a
dispatched child** (the process carries `PI_PTC_DEPTH`). A parent's only route to the web is to
dispatch a child that can search.

**How a parent reaches the web.** It dispatches a child: the parent's own surface has no web tool
(and, in PTC mode, no `bash` either), so a program that calls `tools["pi.dispatch"]` is the only
route — and the child does the searching. The `pi.dispatch` binding's `agent` name is **optional**:
omit it and the child is a fresh generalist pi with pi's own prompt and toolset; name one and the
dispatch is refused unless a definition with that name exists.

**An agent's own `tools:` list has the last word.** pi reads `--tools` as an allowlist, so an
agent definition that declares `tools:` narrows its child to exactly those tools — and the search
tool is filtered out with them. Name `web_ds_search` in that list if that child should search.

**A read-only child still searches.** `readOnly: "strict"` narrows the child's tools to the ones
that **cannot write** — and the search tool only reads the web, so it stays
([ADR-0041](../adr/0041-read-only-is-a-call-site-tier.md)). Measured 2026-10-20: before that, a
parent that asked for a read-only child got one with **no web tool at all**, and the child said so
and gave up rather than failing loudly. The tier's promise — the child cannot write — is intact
either way.

## Turning it on

Everything lives in one key of the agent-dir config file, `~/.pi/agent/ptc.json`:

```json
{
  "webDsSearch": {
    "enabled": true,
    "maxCallsPerSession": 30
  }
}
```

| key                  | default | meaning                                                     |
| -------------------- | ------- | ----------------------------------------------------------- |
| `enabled`            | `false` | Whether the module is available at all.                     |
| `maxCallsPerSession` | `30`    | Successful requests allowed per child. `0` means unlimited. |

**Both keys are read once, when the extension loads.** Change them and restart pi; a running
session keeps the surface it started with.

**A broken value fails in the safe direction.** A malformed `enabled` leaves the module
**off**; a malformed `maxCallsPerSession` falls back to the default. A `ptc.json` that is not
valid JSON at all is reported once at startup, by the reader that owns the file.

**The credential is pi's own.** The module reuses the DeepSeek key your pi already has —
`auth.json`'s `deepseek` entry, or `models.json`'s `providers.deepseek.apiKey`, or
`DEEPSEEK_API_KEY` in the environment — resolved with pi's own semantics, so a `!command` or
`$VAR` form works exactly as it does everywhere else in pi. Nothing new to configure, and no
second copy of a secret.

## Using it

The child's model calls the tool directly. **Three actions, one at a time:**

| action   | arguments              | what comes back                                                                                                       |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `search` | `query` (+ count, …)   | an **overview**: one entry per result — title, url, authority, rerank_score, date, and DeepSeek's own short `snippet` |
| `open`   | `open: "<url>"`        | that page's **full text** (`summary`, plus its body when the search asked for it)                                     |
| `find`   | `find: {url, pattern}` | the **line numbers** where `pattern` appears inside that page                                                         |

The search arguments:

| argument       | type    | meaning                                                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `query`        | string  | What to search for. 1–128 characters. Supports `site:`, `-site:`, `"quoted phrases"`, `lang:`, `after:`, `before:`. |
| `count`        | number  | How many results, 1–50. Defaults to 10.                                                                             |
| `ori_question` | string  | The original question behind the search; helps the engine read the intent.                                          |
| `localization` | string  | An IP address used to prefer localised results.                                                                     |
| `need_content` | boolean | Ask for each result's whole body as well.                                                                           |

Give exactly one action. `count` must be an integer in 1–50, and `query` must be 1–128 Unicode
characters and not blank — both are **checked locally, before the request goes out**: a value
outside those bounds is refused with a sentence that names the range, with no request, no bill and
no quota spent. The length counts Unicode characters, so a query made of emoji is measured the way
you would count them by hand.

**Why the overview is an overview.** A search hands the model a **short digest per result**, not
each page's full text. Measured against the real API, a `count=10` search carries 1,505–4,452
characters that way, against 8,078–33,692 for the full text of every result — and the full text of
every result fills a 128k context after 16–19 searches. DeepSeek's own `snippet` is the right field
for it: the engine's short, query-related digest, and the thing that actually tells the model
whether a page is worth opening.

**The depth is one action away, and it is free.** `open` hands over a page's full `summary` out of
the searches you have done — no request, no bill, no quota spent, because the API already computed
that text and already charged for it. Give `open` a url that was never searched and it fetches the
page instead (that one costs a request, and the fetched body is truncated at 8192 characters).
`find` narrows a long page down to the lines you want.

**The memory reaches back over the last few searches, and it forgives a url written slightly
differently.** A model that refines its query across three searches and then opens a page it
found in the first one is not doing anything strange — so the depth is still free, and a url with
a trailing slash, a `#1` fragment or a tracking query still finds the page you meant.

**Where the result is.** The payload arrives as the tool result's `details` and
`structuredContent` — `results` for a search, `page` for an opened page, `matches` for a find.
Each result carries DeepSeek's own ten fields (`title`, `url`, `snippet`, `summary`, `content`,
`authority`, `rerank_score`, `date`, `site_name`, `site_icon`), unchanged: `authority >= 3` and
`rerank_score >= 1.5` are the thresholds worth filtering on.

**`url` is the only source identifier in a result.** There is no citation id and no reference
marker; build your own citations from it.

**A fetched page's body may carry backslash escapes before punctuation** (`\|`, `\-`, `\.`).
That is DeepSeek's own formatting of a fetched page, not corruption; a page's `content` from a
_search_ result (`need_content: true`) is not escaped, and that is why the search path is the
better way to get a page's text.

**Counting.** `count` does not change the price — a request is billed per call, not per
result — so one request with `count: 50` is cheaper than five requests with `count: 10`. The
quota counts successful requests the same way, so a child that wants many results should ask once.

## When it is not usable

| situation                       | what happens                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| the switch is off               | the tool is not registered at all                                                   |
| the session is a parent         | the tool is not registered at all, and no credential is read                        |
| the switch is on, no credential | the tool is there and says so; a call fails with a sentence naming the missing key  |
| the child's quota is spent      | a call returns a notice, and the child should finish with what it already has       |
| the API rejects the request     | a call fails with a sentence saying whether to retry, change the source or recharge |
| the API matched nothing         | not an error: `results` is empty and the notice says so                             |

**Failures come back as sentences, not status codes**, because the model reading one has to
decide something: retry, change the source, recharge, or stop. The wording is fixed, and the
same sentence appears in the tool's description and in the failure itself.

## The quota is per child

A dispatched child is a separate pi process, so it has its own counter and its own
`maxCallsPerSession` budget — **30 by default, and the number is sized for the CONTEXT, not for
the money**: 30 requests at the overview's measured size is roughly a 128k context's worth of search
results, and 30 requests is 0.15 CNY. **A parent's total spend therefore scales with the number of
children it dispatches**: N children can make up to N × `maxCallsPerSession` successful
requests between them.

**What that costs.** DeepSeek bills Search and Fetch at 5 CNY per 1,000 successful requests
each — 0.005 CNY per call — and only a request that returns HTTP 200 **with results** is
billed. So the default 100-call budget is **at most 0.5 CNY per child**, and a parent that
dispatches five children is looking at **at most 2.5 CNY**.

In practice it is lower twice over: an empty-result search is not billed (and the local
counter is stricter than the bill, so a spent budget means you spent _less_ than the cap),
and a child's context fills up long before it reaches 100 searches — each search returns ten
summaries of 600–800 characters.

**Only successful requests consume the budget.** A failed call, a timeout and a 429 give the
slot back, so a transient error does not eat the child's budget.

## What it costs

DeepSeek bills the search API per successful request: 5 CNY per 1,000 calls, the same for
search and fetch. Only a request that returns HTTP 200 **and produces results** is billed —
a request that matched nothing, failed, or timed out is not. From 2026-11-01 the server-side
search path is billed the same way, so a harness that reaches DeepSeek's search through its
own tools is not free either.

**This module does not fetch `api-docs` for you, and it does not follow links.** Fetch one
page at a time, and read it before you trust it.

## See also

- [ADR-0049](../adr/0049-the-search-lives-in-the-child.md) — why the capability lives in the
  child and the child's model calls it.
- [ADR-0048](../adr/0048-deepseek-search-gate.md) — the switch, the credential verdict and the
  per-child quota.
- [`docs/specs/0044-deepseek-search-module.md`](../specs/0044-deepseek-search-module.md) —
  the full specification.
- [`docs/research/deepseek-search-api-20261020.md`](../research/deepseek-search-api-20261020.md)
  — the API itself, verified with live calls.
- [DeepSeek's own guide](https://api-docs.deepseek.com/zh-cn/guides/search) — the endpoints,
  the field sizes and the pricing this page quotes.
