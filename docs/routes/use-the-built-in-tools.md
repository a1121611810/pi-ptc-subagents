# Use the built-in tools

**When to take this road:** one or two calls would do, and there is nothing to gather between them.

pi's own tools — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — are the floor of what a
model can do. This road is how you reach them on each surface.

## How to call it

| Surface        | The call                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full_ptc`     | Not directly in PTC mode: the built-in tools are hidden from you and reached from inside a program (`tools.read({ path })` inside `ptc_run_code`). |
| `codemode_ptc` | Call them from inside your `codemode` script (`tools.read({ path })`) — pi's orchestrator hands the script this session's tools.                   |

With the PTC mode off the built-in tools are called directly, and the mode's briefing is not
injected at all.

## What comes back

A program reaches only the built-ins this session has bound, and the run's actual bound
names are on the `ptcBindings` global. A binding call resolves to `{ content, details }` —
never a bare string. With the PTC mode off the built-in tools are called directly.

The text of a text result is `result.content[0].text`, and `details` is that tool's own detail
object or `null`. A `bash` call that exits non-zero rejects with `ToolCallError` instead of
resolving with its output.

## Pitfalls

- **The bound surface is narrower than the session's tool list.** A session launched with
  `--tools read` cannot be escaped from inside a program, and `bash` is opt-in (ADR-0040) — read
  `ptcBindings` rather than assuming.
- **An empty answer is a sentinel string, not an empty list.** `No matches found`,
  `No files found matching pattern`, `(empty directory)`.
- **`bash` is not bound by default.** It is a known binding that an install has to opt into.
- **A name that is not a builtin is simply not a function** — calling it throws a `TypeError`.

## Examples

One call, no program needed, with the mode off:

```
read({ path: "src/index.ts" })
```

The same thing inside a program:

```ts
const text = (await tools.read({ path: "src/index.ts" })).content[0].text;
return text.split("\n").length;
```
