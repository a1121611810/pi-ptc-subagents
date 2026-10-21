# Reach the web

**When to take this road:** the task needs the web — a fact you cannot know, or a page you have to
find.

This package gives you no web tool of your own. A child has one: the child's own model calls it
directly. So the route to the web is a task.

## How to call it

| Surface        | The call                               |
| -------------- | -------------------------------------- |
| `full_ptc`     | create a task and let the child search |
| `codemode_ptc` | create a task and let the child search |

There is no difference between the surfaces here: the door is the task door on both, and the
child is the one that searches.

## What comes back

The child's own model calls `web_ds_search` directly — one call, no program in between — and
the switch that turns the module on is read from the install's config, not from this
package.

A search returns an OVERVIEW — one entry per result: title, url, authority, rerank_score, date,
and the provider's own short snippet. It does not return each page's full text.

## Pitfalls

- **The search module is off by default.** The switch (`webDsSearch.enabled`) and a credential are
  both required, and the parent does not hold the key — the child does. A child without them
  reports that it has no web tool, and so should you.
- **A search returns an overview, not the page.** To get a page's substance, open that result's
  url; to get one passage out of a long page, find a string inside it. Both are separate calls.
- **`url` is the only source identifier in a result,** so build citations from it.
- **An agent definition's `tools:` list is an allowlist.** A child whose definition does not list
  `web_ds_search` does not get it.

## Examples

Ask a child for a fact the live web has:

```ts
const result = await tools.pi_task_ptc({
  task:
    "Find the current published version of the `minimatch` package and the date of that release. " +
    "Use your web search tool, and give me the version and the date.",
  wait: true,
});
return result;
```
