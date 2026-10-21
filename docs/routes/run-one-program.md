# Run one program

**When to take this road:** a task needs several tool calls whose intermediate output you do not
need to see — gather it inside the program and return only the final value.

## How to call it

| Surface        | The call                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------- |
| `full_ptc`     | Call `ptc_run_code` with the program body — one program, one call.                          |
| `codemode_ptc` | Not a tool you call yourself here: `codemode` orchestrates, and your script is the program. |

On `codemode_ptc` the program is the `codemode` script itself, so a PTC program is only worth
writing when you specifically want the PTC layer (its helpers, or a program inside a program).

## What comes back

Batch a task's steps into ONE program instead of issuing many tool calls. The run's
actual bound names are on the `ptcBindings` global, so a program never has to guess what
is bound, and only the program's return value and its `console.log` output come back.

Two things never come back, because they are not yours to return:

- **Image data.** Image-bearing tool results are attached to you after the run, so the value you
  return must never be base64 image data.
- **The intermediate output.** That is the point of the program: it gathered it, you did not.

## Pitfalls

- **A program may only reach this session's bound tools.** The run's actual bound names are on the
  `ptcBindings` global — read it rather than guessing.
- **A binding call resolves to `{ content, details }`,** never a bare string. The text is
  `result.content[0].text`.
- **A failing call rejects** with `ToolCallError`, so wrap the call in `try`/`catch` (or
  `Promise.allSettled`) — one failing call does not have to eat its siblings' results.
- **The program runs in strict mode** (ADR-0060): an undeclared name is a `ReferenceError`, and a
  repeated parameter is a compile-time `SyntaxError`.

## Examples

Gather two answers and return one:

```ts
const pkg = JSON.parse((await tools.read({ path: "package.json" })).content[0].text);
const version = pkg.version;
const changelog = (await tools.read({ path: "CHANGELOG.md" })).content[0].text;
return { version, mentions: changelog.includes(version) };
```

Fan out to children under one program, and keep the successful ones:

```ts
const results = await Promise.allSettled([
  tools.pi_task_ptc({ task: "List the public API of module A.", wait: true }),
  tools.pi_task_ptc({ task: "List the public API of module B.", wait: true }),
]);
return results.map((r) => (r.status === "fulfilled" ? r.value.text : null));
```
