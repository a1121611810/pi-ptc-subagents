# Third-Party Notices

`pi-ptc-subagents` is licensed under [Apache-2.0](./LICENSE). It depends on the third-party
software listed below. Each project remains under its own license; nothing in this file changes
those terms.

## What is actually derived from what

This project implements DSH's **PTC** (Programmable Tool Calling) mode as a `pi` extension. It is
a clean-room implementation: see [ADR-0002](docs/adr/0002-source-strategy.md). What the code
_derives_ from DeepSeek Harness is the **behavioural contract** — the tool surface, the
`run_code` semantics, the numeric limits — and the **research notes under `docs/research/` cite
it, line by line, from the public source.** Those notes reproduce substantial portions of DSH's
source, which is why the attribution below is a licence obligation rather than a courtesy.

| Project                                                                                                            | Licence | Role                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)                                  | MIT     | Behavioural reference and citation target for the PTC contract. Read at tag **`dsh-v0.2.0-rc.2`**. |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`) | MIT     | The host this extension loads into. Peer dependency, not vendored.                                 |

## DeepSeek Harness

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Citations in `docs/research/upstream-20260930/` name paths inside that repository, pinned to
`dsh-v0.2.0-rc.2`. Upstream also carries its own `THIRD_PARTY_NOTICES.md` for its dependency
closure; that closure is upstream's concern, and this package depends on the harness only through
reading it, not through importing it.

## Runtime dependency

| Package                                            | Licence       |
| -------------------------------------------------- | ------------- |
| [`minimatch`](https://github.com/isaacs/minimatch) | BlueOak-1.0.0 |

`minimatch` is the only runtime (`dependencies`) entry; everything else is a `devDependency` or a
`peerDependency` on the host.
