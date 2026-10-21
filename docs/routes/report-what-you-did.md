# Report what you did

**When to take this road:** you are a child agent finishing a run.

You are the child here. This road is how your run's result gets back to the host — and it is the
road that makes your work legible to whoever asked for it.

## How to call it

| Surface        | The call                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `full_ptc`     | call `ptc_child_report` once, at the end — it is your tool in a child session, and it is not active in a parent session |
| `codemode_ptc` | call `ptc_child_report` once, at the end — it is your tool in a child session, and it is not active in a parent session |

## What comes back

The report carries your summary, your findings, the evidence behind them and the files you
touched. Your prose answer is kept alongside it and is never replaced by it.

So there are two things to hand over, and the host reads both: the report (structured) and your
answer (prose). The report is what a host can read without parsing English.

## Pitfalls

- **Call it once, at the end** — even when the answer is "I changed nothing". A child that
  reports an empty result and a child that never reported are different things, and only the
  first one says so.
- **Evidence is the point of a finding.** Put in the independent thing you read, ran or checked.
  The claim restated is not evidence, and a finding with none is worse than no finding.
- **`files_touched` lists only paths you actually created or modified.** Leave it empty rather
  than guessing.
- **Do not report usage or token counts.** They are measured by the host, and anything you send
  under them is discarded.
- **The tool may be unavailable to you.** Your instructions say what to do in that case: answer in
  prose, and the host keeps that.

## Examples

```ts
await tools.ptc_child_report({
  summary: "The failing test also fails on main; it is not caused by this branch.",
  findings: [
    {
      claim: "The failure predates this change",
      evidence: "Ran the same test on main at 04f21c8 and it failed with the same assertion.",
      files_touched: [],
    },
  ],
  files_touched: [],
});
```
