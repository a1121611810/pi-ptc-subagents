/**
 * The command-line switches that can take `codemode` away, read the way pi reads them.
 *
 *
 * **On the `file:line` references in this file:** they are measured against **pi 1.0.0** in
 * `node_modules`, the version this repo compiles and typechecks against. pi 1.1.0 moves them
 * -- `--no-tools` 104 → 108, `--tools` 110 → 114, the unknown-flag branch 227 → 243 -- so a
 * reader with a different install open will find these addresses point elsewhere. The
 * behaviour they name is the same in both; only the addresses move.
 *
 * `cli-tool-flags-differential.test.ts` is the check that does not depend on any of them: it
 * imports pi's own parser and compares behaviour across ~300 argv shapes. Everything here is
 * about the *shape* of the resolution; everything there is about it matching the host.
 * The reader used to look at `--tools` only, which was complete for as long as `--tools` was the
 * only flag that could remove a tool. It is not, and every flag that was missed removes:
 * `--exclude-tools` filters the registry (`agent-session.js:1099-1100`), `--no-tools` empties the
 * allowlist (`sdk.js:145`), and `--no-builtin-tools` empties the INITIAL ACTIVE LIST while leaving
 * the allowlist alone -- so `codemode` ends up registered and inactive, a state no flag name
 * suggests. `tests/unit/codemode-activation.test.ts` covers the settings half of the same probe;
 * this file covers the command line and the interaction between the lists, which is the part the
 * old reader got wrong.
 *
 * Every expectation below is a literal, justified against pi's own parser and session builder in
 * `node_modules/@earendil-works/pi-coding-agent/dist/`:
 *
 * | flag                             | `cli/args.js` | `main.js` | `core/sdk.js` |
 * | -------------------------------- | ------------- | --------- | ------------- |
 * | `--no-tools` / `-nt` (no value)  | :104          | :427      | :145, :148    |
 * | `--no-builtin-tools` / `-nbt`    | :107          | :430      | :148          |
 * | `--tools` / `-t <list>`          | :110          | :432      | :148          |
 * | `--exclude-tools` / `-xt <list>` | :116          | :433      | :147-148      |
 *
 * ## The cursor, not just the flags
 *
 * A table of flags is not a parser. pi writes its valued branches `args[++i]`, which advances the
 * cursor PAST the value, so a value that happens to spell a flag is never re-read as one; it also
 * ends flag parsing at `--` (`args.js:23`, `break` at `:32`) and, in the unknown-flag branch
 * (`args.js:227`), swallows a following token that starts with neither `-` nor `@`
 * (`args.js:235-239`). Reading a tool flag without advancing therefore reports flags pi never saw:
 * `pi --exclude-tools --tools codemode` makes `--tools` the DENYLIST's value, so pi sets
 * `excludeTools: ["--tools"]`, never sets `tools`, and decides the loadout from `defaultTools`.
 * This file's cursor cases are what keep that route from being answered out of order.
 *
 * ## Why `-nbt` belongs in the same bucket as `-nt`
 *
 * `main.js:430` maps `-nbt` to `options.noTools = "builtin"`, which is not `"all"`, and
 * `sdk.js:145` (`options.tools ?? (options.noTools === "all" ? [] : undefined)`) does compare
 * against `"all"`. Reading those two lines is what makes `-nbt` look inert, and it is wrong: the
 * line that decides the initial active list is `sdk.js:148`, which tests `options.noTools` for
 * TRUTH --
 *
 * ```js
 * (options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? DEFAULT_TOOL_NAMES)))
 * ```
 *
 * -- so `"builtin"` empties that list exactly as `"all"` does, and `defaultTools` is never reached.
 * Measured on pi 1.1.0 with this package's own `dist/index.js` and `defaultTools: ["+codemode"]`:
 * under `-nbt`, `codemode` is REGISTERED (`allowedToolNames` stays undefined, so
 * `_isAllowedTool` admits it) and INACTIVE (`initialActiveToolNames` is `[]`). Reading `sdk.js:145`
 * alone cannot see that, which is why the case is pinned here rather than argued in a comment.
 */
import { describe, expect, test } from "vitest";
import {
  type CliToolFlags,
  type CodemodeActivationResolution,
  cliToolFlags,
  resolveCodemodeActivation,
} from "../../src/mode/ptc-mode.ts";
import { ACTIVE_CODEMODE_SETTINGS } from "../helpers/ptc.ts";

/** The orchestrator's registered name (`dist/extensions/codemode/index.js:26`, `:tool.d.ts`). */
const CODEMODE = "codemode";

describe("cliToolFlags: which flags pi recognises, and with what value", () => {
  test("no tool flag at all is an absent allowlist rather than an empty one", () => {
    // The distinction is load-bearing downstream and is NOT a style choice. `undefined` means
    // "pi decides the list from settings"; `[]` means "pi allows nothing". Reading absence as `[]`
    // would make every unconfigured session resolve through the allowlist branch and report
    // `source: "cli"` for a command line that said nothing about tools.
    // `toStrictEqual` rather than `toEqual` so `allowlist: undefined` must be an own property:
    // a mirror returning `null`, or omitting the key, is a different contract and is caught here.
    expect(cliToolFlags([])).toStrictEqual({ allowlist: undefined, denylist: [], noTools: false });
    // Non-tool arguments are simply not flags; a positional prompt must not be read as a value.
    expect(cliToolFlags(["--print", "explain src/mode/ptc-mode.ts"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: false,
    });
  });

  test("both spellings of --tools read the argument that follows", () => {
    // `args.js:110`: `else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length)`.
    // The two spellings are one branch, so each is asserted against the same expected list --
    // a mirror that recognised only the long form fails the second.
    const expected: CliToolFlags = { allowlist: [CODEMODE], denylist: [], noTools: false };
    expect(cliToolFlags(["--tools", CODEMODE])).toStrictEqual(expected);
    expect(cliToolFlags(["-t", CODEMODE])).toStrictEqual(expected);
  });

  test("both spellings of --exclude-tools read the argument that follows", () => {
    // `args.js:116`: the same `i + 1 < args.length` guard, the same `result.excludeTools`.
    const expected: CliToolFlags = { allowlist: undefined, denylist: [CODEMODE], noTools: false };
    expect(cliToolFlags(["--exclude-tools", CODEMODE])).toStrictEqual(expected);
    expect(cliToolFlags(["-xt", CODEMODE])).toStrictEqual(expected);
  });

  test("--no-tools and -nt are recognised, and neither takes a value", () => {
    // `args.js:104` has no `i + 1` condition and no `args[++i]`: the branch sets a boolean and
    // moves on. The value-taking shape of the other two flags is asserted below, which is what
    // rules out a reader that consumed one.
    expect(cliToolFlags(["--no-tools"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: true,
    });
    expect(cliToolFlags(["-nt"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: true,
    });
  });

  test("--no-builtin-tools and -nbt are recognised as emptying the active list, as -nt is", () => {
    // The case that was written the other way round and was wrong: the original reasoning was
    // that `main.js:430` sets `noTools: "builtin"` rather than `"all"`, so `sdk.js:145` leaves
    // `allowedToolNames` undefined and the flag looks inert. `sdk.js:148` tests `options.noTools`
    // for truth and empties `initialActiveToolNames` either way, so `-nbt` is as effective as
    // `-nt` for the question this probe asks -- the difference is only in WHICH list it empties,
    // and that difference shows up as "registered but not active" rather than "not registered".
    // Both spellings are asserted because `args.js:107` is one branch for both.
    expect(cliToolFlags(["--no-builtin-tools"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: true,
    });
    expect(cliToolFlags(["-nbt"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: true,
    });
  });

  test("a trailing --tools is not that flag at all, because pi guards it on a following argument", () => {
    // `args.js:110` and `:116` are `(arg === "--tools" || arg === "-t") && i + 1 < args.length`.
    // A trailing `--tools` fails the guard and falls through to pi's unknown-flag branch, so
    // there is no list to read. Reading it as one -- even as an empty one -- is a claim pi does
    // not make, and it would resolve as `source: "cli"` on a command line pi rejected.
    expect(cliToolFlags(["--tools"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: false,
    });
    // Same for the denylist, where the absent-list value is `[]` rather than `undefined`.
    expect(cliToolFlags(["--exclude-tools"])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: false,
    });
  });

  test("finding a flag does not end the scan, so a later flag is still read", () => {
    // The anti-requirement, stated on the one flag that provably consumes nothing: `-nt` sets a
    // boolean and leaves the cursor alone (`args.js:104`, no `args[++i]`), so the `--tools` behind
    // it is still a flag with a value. A reader that returned at the first match, or that skipped a
    // token per flag it saw, answers `allowlist: undefined` here.
    //
    // This is the SAME requirement the next test checks from the other side — one flag that
    // consumes nothing must not stop the scan, one flag that consumes a value must not let the
    // value be read — and they are separate tests because a reader can get one right and the
    // other wrong, and a single combined case would go green for the wrong reason.
    expect(cliToolFlags(["--no-tools", "--tools", CODEMODE])).toStrictEqual({
      allowlist: [CODEMODE],
      denylist: [],
      noTools: true,
    });
  });

  test("a tool list is split on commas, trimmed, and stripped of blanks", () => {
    // `args.js:110-114`, verbatim in shape: `args[++i].split(",").map((s) => s.trim())
    // .filter((name) => name.length > 0)`. A mirror that split without trimming would keep
    // `" codemode"`, and one that dropped the filter would keep the trailing empty string --
    // either of which changes whether the name is found, so both are checked.
    expect(cliToolFlags(["--tools", " read , codemode , "])).toStrictEqual({
      allowlist: ["read", CODEMODE],
      denylist: [],
      noTools: false,
    });
    // The same syntax on the other flag, including a value that is nothing but separators.
    expect(cliToolFlags(["-xt", " , , "])).toStrictEqual({
      allowlist: undefined,
      denylist: [],
      noTools: false,
    });
  });

  test("the valueless flags do not consume the argument after them", () => {
    // The case that separates "recognised" from "consumed": `-nt` sets a boolean and leaves the
    // cursor alone (`args.js:104`), so `--tools codemode` behind it is still a tool flag with a
    // value. A reader that skipped a token per flag it saw would lose the allowlist here. All
    // four valueless spellings are in the table, because the two `-nbt` spellings reached the
    // same branch by a later change and a reader could consume a token for only some of them.
    const withAllowlist: readonly string[][] = [
      ["-nt", "--tools", CODEMODE],
      ["--no-tools", "--tools", CODEMODE],
      ["-nbt", "--tools", CODEMODE],
      ["--no-builtin-tools", "--tools", CODEMODE],
    ];
    for (const args of withAllowlist) {
      expect(cliToolFlags(args), args.join(" ")).toStrictEqual({
        allowlist: [CODEMODE],
        denylist: [],
        noTools: true,
      });
    }
  });
});

describe("cliToolFlags: the cursor, not just the flags", () => {
  test("a value that spells a tool flag is the value, and is never read as a flag", () => {
    // The defect this block exists for. pi writes its valued branches `args[++i]`
    // (`args.js:110,116`), so the cursor moves past the value; a reader that reads `args[index + 1]`
    // and stays put sees the same token twice and reports a flag pi never acted on.
    //
    // Both orders are asserted because they fail in OPPOSITE directions, and only one of them is
    // the safe one. `--tools --exclude-tools codemode`: without the advance this reader also
    // reported `denylist: ["codemode"]`, which under-reports activation and costs delegation.
    // `--exclude-tools --tools codemode`: without the advance it reported `allowlist: ["codemode"]`
    // and therefore `active` from `cli`, while pi sets `excludeTools: ["--tools"]`, never sets
    // `tools`, and decides from `defaultTools` -- over-reporting activation, which hands the model
    // an orchestrator that is not there. The second row is the one the fix had to close.
    expect(cliToolFlags(["--tools", "--exclude-tools", CODEMODE])).toStrictEqual({
      allowlist: ["--exclude-tools"],
      denylist: [],
      noTools: false,
    });
    expect(cliToolFlags(["--exclude-tools", "--tools", CODEMODE])).toStrictEqual({
      allowlist: undefined,
      denylist: ["--tools"],
      noTools: false,
    });
    // The same pair of flags with ordinary values is unaffected: two independent flags, each with
    // its own value, are read as two flags. A reader that over-advanced would lose one of them.
    expect(cliToolFlags(["-t", CODEMODE, "-xt", CODEMODE])).toStrictEqual({
      allowlist: [CODEMODE],
      denylist: [CODEMODE],
      noTools: false,
    });
  });

  test("the previously-unsafe route now resolves the way pi routes it", () => {
    // The behavioural consequence of the row above, stated at the level the user sees. pi never
    // sets `tools` on `pi --exclude-tools --tools codemode`, so the answer comes from
    // `defaultTools` and SAYS SO; the previous reader answered `active` from `cli`, which is both
    // the wrong route and, with a settings file that did not name `codemode`, the wrong answer.
    // The source is the assertion that catches a reader which lands on the right value for the
    // wrong reason.
    expect(
      resolveCodemodeActivation(
        ["pi", "--exclude-tools", "--tools", CODEMODE],
        undefined,
        ACTIVE_CODEMODE_SETTINGS,
      ),
    ).toStrictEqual({ activation: "active", source: "user" });
    // And the contrast that shows the route is load-bearing: the same argv with `codemode` NOT in
    // the settings is pi's own default, not a command-line answer.
    expect(
      resolveCodemodeActivation(["pi", "--exclude-tools", "--tools", CODEMODE], undefined, {
        defaultTools: ["read"],
      }),
    ).toStrictEqual({ activation: "inactive", source: "user" });
  });

  test("a value-consuming flag swallows the token after it, whatever that token spells", () => {
    // These flags are written `args[++i]` in pi — `-e`/`--extension` at `args.js:147`, `--model`
    // at `:66`, `--name`/`-n` at `:80` — so a tool flag sitting in a value position belongs
    // to whichever flag is in front of it. Each row is one of those, and each would report a
    // tool flag pi swallowed. (An earlier `args.js:96-140` range was wrong twice over: it cut
    // through boolean branches such as `-nt`, and it is not the span of those assignments.)
    const swallowed: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["-e", ["-e", "-t", CODEMODE]],
      ["--model", ["--model", "-t", CODEMODE]],
      ["--name", ["--name", "-xt", CODEMODE]],
    ];
    for (const [label, args] of swallowed) {
      expect(cliToolFlags(args), label).toStrictEqual({
        allowlist: undefined,
        denylist: [],
        noTools: false,
      });
    }
  });

  test("flags pi treats as boolean are NOT swallowed, and flags pi does not have are not either", () => {
    // The first cut of `PI_VALUE_CONSUMING_FLAGS` over-approximated on purpose, on the reasoning
    // that skipping one argument too many can only hide a tool flag and so pushes the answer
    // toward `inactive`. Three names in that list did not deserve the excuse:
    //
    //   - `-a` is `--approve` (`args.js:215`), a boolean branch with no `args[++i]`. pi leaves the
    //     cursor alone, so listing it hid a real allowlist.
    //   - `--mode` / `--use-theme` / `--list-models` guard on `startsWith("-")` and skip the
    //     advance when it holds, so a `-t` directly behind one of them is pi's own flag.
    //   - `-f` and `-x` are not pi flags at all; they were invented here.
    //
    // The set is now a transcription rather than a super-set, and the property that made the
    // over-approximation acceptable — that its errors point one way — is kept as a note rather
    // than as a list entry. `tests/unit/cli-tool-flags-differential.test.ts` holds it to pi's own
    // parser across 294 argv shapes, so a future pi adding a value-consuming flag turns this file
    // red instead of quietly widening the gap.
    for (const [label, args] of [
      ["-a", ["-a", "-t", CODEMODE]],
      ["--approve", ["--approve", "-t", CODEMODE]],
      ["-f", ["-f", "-t", CODEMODE]],
      ["-x", ["-x", "-t", CODEMODE]],
      ["-na", ["-na", "-t", CODEMODE]],
    ] as const) {
      expect(
        cliToolFlags(args),
        `${label} is valueless, so the -t behind it is real`,
      ).toStrictEqual({
        allowlist: [CODEMODE],
        denylist: [],
        noTools: false,
      });
    }
  });

  test("-- ends flag parsing, and nothing after it is a flag", () => {
    // `args.js:23` handles `--` by draining the remainder into `fileArgs` / `messages` and
    // `break`ing (`:32`), so a later `-xt` is a positional argument pi never treats as a flag.
    // Reading past it would deny a tool pi is still allowing.
    expect(cliToolFlags(["--tools", CODEMODE, "--", "-xt", CODEMODE])).toStrictEqual({
      allowlist: [CODEMODE],
      denylist: [],
      noTools: false,
    });
    // And `--` on its own leaves the flags before it alone: it is a terminator, not a value, so it
    // is not in the consuming set and does not swallow the token behind it either.
    expect(cliToolFlags(["--tools", CODEMODE, "--", "--tools", CODEMODE])).toStrictEqual({
      allowlist: [CODEMODE],
      denylist: [],
      noTools: false,
    });
  });

  test("an unknown long flag swallows a plain token but not a flag-shaped one", () => {
    // `args.js:227-243`: the unknown-flag branch stores `--name` with the value behind it when the
    // next token starts with neither `-` nor `@` (`args.js:235-239`), and otherwise stores `true`.
    //
    // Which of the two rows discriminates is measured, not assumed. The SECOND row is the one: `-t`
    // starts with `-`, so it is not swallowed and must still be read as the tool flag it is —
    // dropping the leading-dash guard from `piUnknownLongFlagEatsNext` turns it red. The FIRST row
    // does NOT discriminate: removing the swallow outright leaves it green, because no branch in
    // this reader matches a token that does not start with `-`, so a swallowed plain token is
    // indistinguishable from one that was merely ignored. It is kept because it is what pi
    // produces and because the day a branch matches a bare token the swallow becomes load-bearing
    // — but the honest reading of this row today is "no test here would notice", and that is why
    // the comment says so rather than letting the assertion imply coverage.
    expect(cliToolFlags(["--whatever", CODEMODE, "-xt", CODEMODE])).toStrictEqual({
      allowlist: undefined,
      denylist: [CODEMODE],
      noTools: false,
    });
    expect(cliToolFlags(["--whatever", "-t", CODEMODE])).toStrictEqual({
      allowlist: [CODEMODE],
      denylist: [],
      noTools: false,
    });
  });
});

describe("resolveCodemodeActivation over the command line", () => {
  test("the whole precedence table, each row asserted on its own", () => {
    // The rows are `[label, argv, projectSettings, userSettings, expected]`. The expected column
    // is a literal list written out again below -- not a projection of these rows -- so a wrong
    // cell fails on its own line and names itself in the diff.
    const rows: ReadonlyArray<readonly [string, readonly string[], unknown, unknown]> = [
      ["-t names codemode", ["pi", "-t", CODEMODE], undefined, undefined],
      ["-t names something else", ["pi", "--tools", "read"], undefined, undefined],
      [
        "-t names codemode and -xt takes it back",
        ["pi", "--tools", CODEMODE, "--exclude-tools", CODEMODE],
        undefined,
        undefined,
      ],
      [
        "-xt takes it back out of defaultTools",
        ["pi", "--exclude-tools", CODEMODE],
        undefined,
        ACTIVE_CODEMODE_SETTINGS,
      ],
      ["-nt beats defaultTools", ["pi", "--no-tools"], undefined, ACTIVE_CODEMODE_SETTINGS],
      ["-t beats -nt", ["pi", "--no-tools", "--tools", CODEMODE], undefined, undefined],
      [
        "-nbt beats defaultTools",
        ["pi", "--no-builtin-tools"],
        undefined,
        ACTIVE_CODEMODE_SETTINGS,
      ],
      ["-t beats -nbt", ["pi", "--no-builtin-tools", "--tools", CODEMODE], undefined, undefined],
      ["defaultTools alone", ["pi"], undefined, ACTIVE_CODEMODE_SETTINGS],
      ["nothing anywhere", ["pi"], undefined, undefined],
    ];
    const actual = rows.map(([label, argv, project, user]) => {
      const resolution: CodemodeActivationResolution = resolveCodemodeActivation(
        argv,
        project,
        user,
      );
      return `${label}: ${resolution.activation}/${resolution.source}`;
    });
    expect(actual).toEqual([
      "-t names codemode: active/cli",
      "-t names something else: inactive/cli",
      "-t names codemode and -xt takes it back: inactive/cli",
      "-xt takes it back out of defaultTools: inactive/user",
      "-nt beats defaultTools: inactive/cli",
      "-t beats -nt: active/cli",
      "-nbt beats defaultTools: inactive/cli",
      "-t beats -nbt: active/cli",
      "defaultTools alone: active/user",
      "nothing anywhere: inactive/default",
    ]);
  });

  test("the settings fixture behind the table is the ADR-0029 literal, not an arbitrary shape", () => {
    // A shared fixture that silently changed would make every row that uses it assert something
    // else, so its content is pinned to the literal ADR-0029 and `settings-manager.js:55` describe:
    // a list of only modifiers, which starts from `DEFAULT_TOOL_NAMES` and ADDS `codemode` rather
    // than replacing the four. A fixture that became `["-codemode"]` would still be "a
    // defaultTools" and would quietly invert the rows that depend on it.
    expect(ACTIVE_CODEMODE_SETTINGS).toStrictEqual({ defaultTools: ["+codemode"] });
  });

  test("the denylist is applied to the list that names codemode, not merely recorded beside it", () => {
    // The repair this file exists for. pi builds the initial active set as
    // `(options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ??
    // DEFAULT_TOOL_NAMES))).filter((name) => !excludedToolNameSet?.has(name))` (`sdk.js:148`):
    // the filter is applied TO the winning list, so `-t codemode -xt codemode` leaves nothing
    // active, and `_isAllowedTool` refuses the name outright (`agent-session.js:1099-1100`). An
    // `allowlist.includes(codemode)` check cannot see either.
    //
    // Both halves are one test because the second is only meaningful as a difference: a reader
    // that ignored the denylist would answer `active` for both, and a reader that ignored the
    // allowlist would answer `inactive` for both.
    expect(
      resolveCodemodeActivation(["pi", "--tools", CODEMODE], undefined, undefined),
    ).toStrictEqual({ activation: "active", source: "cli" });
    expect(
      resolveCodemodeActivation(
        ["pi", "--tools", CODEMODE, "--exclude-tools", CODEMODE],
        undefined,
        undefined,
      ),
    ).toStrictEqual({ activation: "inactive", source: "cli" });
  });

  test("the same filter vetoes a codemode that came from settings, not only one from the command line", () => {
    // `sdk.js:147-148` builds `excludedToolNameSet` from `options.excludeTools` and filters the
    // CONFIGURED list with it, so the veto is not a property of where the name came from. Without
    // this the exclusion would only work for argv, and a user with `defaultTools: ["+codemode"]`
    // in `settings.json` who also passed `-xt codemode` would still be told `active`.
    expect(resolveCodemodeActivation(["pi"], undefined, ACTIVE_CODEMODE_SETTINGS)).toStrictEqual({
      activation: "active",
      source: "user",
    });
    expect(
      resolveCodemodeActivation(
        ["pi", "--exclude-tools", CODEMODE],
        undefined,
        ACTIVE_CODEMODE_SETTINGS,
      ),
    ).toStrictEqual({ activation: "inactive", source: "user" });
  });

  test("both no-tools spellings override defaultTools, and --tools overrides both", () => {
    // `sdk.js:148` is the whole precedence, and it is an EXPRESSION rather than a flag order:
    // `options.tools ?? (options.noTools ? [] : ...)` -- nullish coalescing, so a present `tools`
    // array wins over `noTools` in either spelling of `noTools` and in either argv order. A
    // reader that resolved by the order the flags appeared would answer differently for the two
    // reversed rows below, which is why both orders are asserted.
    //
    // The `source` is `cli` for the `-nbt` case rather than `user`: the command line is what
    // decided, and the settings file that asked for `codemode` is exactly what lost.
    for (const flag of ["--no-tools", "-nt", "--no-builtin-tools", "-nbt"]) {
      expect(
        resolveCodemodeActivation(["pi", flag], undefined, ACTIVE_CODEMODE_SETTINGS),
        flag,
      ).toStrictEqual({ activation: "inactive", source: "cli" });
      expect(
        resolveCodemodeActivation(["pi", flag, "--tools", CODEMODE], undefined, undefined),
        `${flag} then -t`,
      ).toStrictEqual({ activation: "active", source: "cli" });
      expect(
        resolveCodemodeActivation(["pi", "--tools", CODEMODE, flag], undefined, undefined),
        `-t then ${flag}`,
      ).toStrictEqual({ activation: "active", source: "cli" });
    }
  });

  test("an empty -t is an allowlist that activates nothing, which is not the same as -nt", () => {
    // The reason `noTools` is its own field rather than an allowlist of `[]`. `-t ""` still SETS
    // `options.tools`, and `sdk.js:148` therefore takes the left side of the `??`: the list is
    // empty, so nothing is active -- but `allowedToolNames` is `[]` rather than undefined
    // (`sdk.js:145`), so pi reached the state by a different route and a later `-nt` would not
    // change it. Both are `inactive` here; conflating them would cost that distinction, so the
    // reader's output is asserted as well as the resolver's answer.
    expect(
      resolveCodemodeActivation(["pi", "--tools", ""], undefined, ACTIVE_CODEMODE_SETTINGS),
    ).toStrictEqual({ activation: "inactive", source: "cli" });
    expect(cliToolFlags(["--tools", ""])).toStrictEqual({
      allowlist: [],
      denylist: [],
      noTools: false,
    });
  });

  test("a dangling flag is the absence of a flag, not an empty list", () => {
    // Stated through the resolver as well as the reader, because the consequence is a different
    // `source`: pi's `i + 1 < args.length` guard means a trailing `--tools` never becomes a flag,
    // so the answer comes from settings (or from pi's default) and says so. A reader that read
    // the dangling flag as an empty allowlist would answer `inactive/cli` for the first row.
    expect(
      resolveCodemodeActivation(["pi", "--tools"], undefined, ACTIVE_CODEMODE_SETTINGS),
    ).toStrictEqual({ activation: "active", source: "user" });
    expect(resolveCodemodeActivation(["pi", "--tools"], undefined, undefined)).toStrictEqual({
      activation: "inactive",
      source: "default",
    });
  });

  test("a command line with no tool switch does not claim the answer, and pi's default is inactive", () => {
    // pi's default active names are `["read","bash","edit","write"]` (`settings-manager.js:35`)
    // and `codemode` registers with `defaultActive: false`
    // (`dist/extensions/codemode/index.js:26`), so "nobody configured anything" resolves to
    // inactive. The `source` matters as much as the answer: a probe reporting `source: "cli"`
    // for a bare `pi` would claim evidence it does not have, and `session_start` prints that
    // source into the notice a user reads.
    expect(resolveCodemodeActivation(["pi"], undefined, undefined)).toStrictEqual({
      activation: "inactive",
      source: "default",
    });
    // A project-scope list is still the project's answer when there is one.
    expect(
      resolveCodemodeActivation(["pi"], { defaultTools: [CODEMODE] }, undefined),
    ).toStrictEqual({ activation: "active", source: "project" });
  });
});
