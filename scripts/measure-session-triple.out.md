# Recorded output: measure-session-triple

Run: `node scripts/measure-session-triple.mjs`
pi: 0.99.1 at ~/.bun/bin/pi
Date: 2026-09-30T15:31:02Z

```
PASS one file per child: 1 file(s): ["2026-09-30T15-31-02-474Z_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl"]
PASS retry with the same id adds no file: 1 file(s) after retry: ["2026-09-30T15-31-02-474Z_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl"]
PASS retry appends rather than truncating: 7 -> 10 entries
PASS a different id gets its own file: 2 file(s): ["2026-09-30T15-31-02-474Z_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl","2026-09-30T15-31-08-415Z_01BRZ3NDEKTSV4RRFFQ69G5FAV.jsonl"]
PASS --no-session child writes nothing to a session dir: a --no-session child wrote 0 jsonl into its cwd; it was given no session dir to write to

5/5 claims hold
```

The entry counts are model-dependent in detail (a different model writes a different number of
turns), so treat `7 -> 10` as the shape, not a constant. The claims are the three file-count
facts, which are not model-dependent.
