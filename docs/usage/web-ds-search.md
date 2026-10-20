# Web search (DeepSeek)

The DeepSeek search module gives a program two things it cannot otherwise reach: a way to
search the live web, and a way to pull one page's text. It is **off by default** and it is
**only reachable from inside a program** — the model never gets it as a tool of its own
([ADR-0047](../adr/0047-deepseek-search-is-program-internal.md)).

## Turning it on

Everything lives in one key of the agent-dir config file, `~/.pi/agent/ptc.json`:

```json
{
  "webDsSearch": {
    "enabled": true,
    "maxCallsPerSession": 100
  }
}
```

| key                  | default | meaning                                                    |
| -------------------- | ------- | ---------------------------------------------------------- |
| `enabled`            | `false` | Whether the module is available at all.                    |
| `maxCallsPerSession` | `100`   | Successful calls allowed per session. `0` means unlimited. |

**Both keys are read once, when the extension loads.** Change them and restart pi; a running
session keeps the surface it started with, so a program never sees a different table from the
one its prompt described.

**A broken value fails in the safe direction.** A malformed `enabled` leaves the module
**off**; a malformed `maxCallsPerSession` falls back to the default. A `ptc.json` that is not
valid JSON at all is reported once at startup, by the reader that owns the file.

**The credential is pi's own.** The module reuses the DeepSeek key your pi already has —
`auth.json`'s `deepseek` entry, or `models.json`'s `providers.deepseek.apiKey`, or
`DEEPSEEK_API_KEY` in the environment — resolved with pi's own semantics, so a `!command` or
`$VAR` form works exactly as it does everywhere else in pi. Nothing new to configure, and no
second copy of a secret.

## Using it from a program

The PTC binding is `web.ds.search`, called with string indexing (the dot name is a namespace,
not a property):

```js
const hits = await tools["web.ds.search"]({ query: "pi coding agent extension api" });

// `url` instead of `query` fetches one page as Markdown:
const page = await tools["web.ds.search"]({ url: "https://api-docs.deepseek.com/" });
```

| argument       | type    | meaning                                                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `query`        | string  | What to search for. 1–128 characters. Supports `site:`, `-site:`, `"quoted phrases"`, `lang:`, `after:`, `before:`. |
| `url`          | string  | Instead of searching, fetch this one page as Markdown. Up to 8192 characters, http(s), no username or password.     |
| `count`        | number  | How many results, 1–50. Defaults to 10.                                                                             |
| `ori_question` | string  | The original question behind the search; helps the engine read the intent.                                          |
| `localization` | string  | An IP address used to prefer localised results.                                                                     |
| `need_content` | boolean | Include each page's body in `content`.                                                                              |

Give exactly one of `query` and `url`.

**Where the result is.** The payload sits in `details` — `details.results` for a search,
`details.page` for a fetch — not in the text block. Each result carries DeepSeek's own ten
fields (`title`, `url`, `snippet`, `summary`, `content`, `authority`, `rerank_score`, `date`,
`site_name`, `site_icon`), unchanged: `authority >= 3` and `rerank_score >= 1.5` are the
thresholds worth filtering on, and `summary` is the field written for a model to read while
`snippet` is the one written for a UI.

**`url` is the only source identifier in a result.** There is no citation id and no reference
marker; build your own citations from it.

**Take the text you need.** The module does not trim anything: `summary` is 600–800 characters
per result and `content` is a whole page. Ask for less (`count`, `need_content: false`) or
project it yourself before returning it — the module deliberately does not decide for you.

**Counting.** `count` does not change the price — a request is billed per call, not per
result — so one request with `count: 50` is cheaper than five requests with `count: 10`. The
quota counts successful calls the same way, so a program that wants many results should ask
once.

## When it is not usable

| situation                       | what happens                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| the switch is off               | the binding is not in the table at all; `tools["web.ds.search"]` is not a function    |
| the switch is on, no credential | the binding is there and says so; a call fails with a sentence naming the missing key |
| the session's quota is spent    | a call returns a notice, and the program should finish with what it already has       |
| the API rejects the request     | a call fails with a sentence saying whether to retry, change the source or recharge   |
| the API matched nothing         | not an error: `results` is empty and the notice says so                               |

**Failures come back as sentences, not status codes**, because the program reading one has to
decide something: retry, change the source, recharge, or stop. The wording is fixed, and it is
the same on both faces.

## The two faces

The same implementation appears twice, and the difference is only how a program reaches it:

- **The PTC binding** — `tools["web.ds.search"]`, available to any program in any session that
  has the module switched on.
- **The codemode face** — a pi tool named `web_ds_search`, registered at `exposure:
  "codemode"`, so a `codemode` script can call it. The model is never told about it.

On a pi older than 0.99.0 there is no `exposure` field and no `codemode` extension at all, so
the codemode face is not registered there — registering it would put a network-egress tool
straight into the model's direct tool list. The PTC binding face works on every supported
version, because it runs in this package's own worker.

## What it costs

DeepSeek bills the search API per successful request: 5 CNY per 1,000 calls, the same for
search and fetch. A request that matched nothing, failed, or timed out is not billed. From
2026-11-01 the server-side search path is billed the same way, so a harness that reaches
DeepSeek's search through its own tools is not free either.

**This module does not fetch `api-docs` for you, and it does not follow links.** Fetch one
page at a time, and read it before you trust it.

## See also

- [ADR-0047](../adr/0047-deepseek-search-is-program-internal.md) — why the capability is
  program-internal rather than a model-facing tool.
- [ADR-0048](../adr/0048-deepseek-search-gate.md) — the switch, the credential verdict and the
  per-session quota.
- [`docs/specs/0044-deepseek-search-module.md`](../specs/0044-deepseek-search-module.md) —
  the full specification.
- [`docs/research/deepseek-search-api-20261020.md`](../research/deepseek-search-api-20261020.md)
  — the API itself, verified with live calls.
