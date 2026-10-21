# Run a phased workflow

**When to take this road:** the work has named phases and the user benefits from seeing progress
narration.

A workflow is a program with a name and an ordered list of phases. It reports as it goes, so a
person watching the run sees which phase it is in rather than a single silent wait.

## How to call it

| Surface        | The call                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `full_ptc`     | Call `ptc_workflow` with the script body and a `meta` — the same program, plus `log`, `phase`, `parallel` and `pipeline`. |
| `codemode_ptc` | Not a tool you call yourself here: `codemode` orchestrates, and your script is the program.                               |

`meta` names the run (`{ name, description, phases? }`, where `phases` is the ordered plan), and
optional `args` is plain JSON bound to the script's `args` global.

## What comes back

What comes back is the script's return value, its `log` and `phase` narration and its
`console.log` output. A phase title outside `meta.phases` is reported as a warning, not
an error.

The helpers, and what each is for:

| Helper                       | What it does                                                     |
| ---------------------------- | ---------------------------------------------------------------- |
| `log(message)`               | Narrates progress.                                               |
| `phase(title)`               | Frames the workflow; a title outside `meta.phases` is a warning. |
| `parallel(thunks)`           | Runs thunks concurrently; a failed item becomes `null`.          |
| `pipeline(items, ...stages)` | Chains stages per item; the same per-item `null` on failure.     |

There is no `agent()` helper: a child is created through the task door, not through a helper.

## Pitfalls

- **A failed item becomes `null`, it does not throw.** With `parallel` and `pipeline` one failure
  does not cancel the others — but the `null` is yours to notice.
- **A phase outside `meta.phases` is a warning, not an error.** The run still succeeds.
- **The workflow is still a program:** the same binding rules, the same `{ content, details }`
  result shape, the same strict mode.

## Examples

```ts
const meta = {
  name: "migrate-config",
  description: "Migrate the config file and report what moved",
  phases: ["read", "rewrite", "verify"],
};

phase("read");
const current = (await tools.read({ path: "config.json" })).content[0].text;

phase("rewrite");
await tools.write({ path: "config.json", content: migrate(current) });

phase("verify");
const after = (await tools.read({ path: "config.json" })).content[0].text;
log(after === current ? "unchanged" : "migrated");
return { changed: after !== current };
```
