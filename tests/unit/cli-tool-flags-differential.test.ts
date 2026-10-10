/**
 * `cliToolFlags` measured against pi's own argument parser, over a corpus wide enough to have
 * caught every divergence it ever had.
 *
 * This file exists because of how the reader came to be wrong four separate times, and because no
 * gate in this repo can see that class of defect on its own. The reader mirrors a hand-maintained
 * list of pi flags that consume a value; each mistake was invisible to the suite, because every
 * hand-written case asserted the reader's own (wrong) answer:
 *
 *   - `--model` was dropped from the list entirely. `pi --model -t codemode` is a real allowlist
 *     and this reader missed it — the dangerous direction, the one that hands the model an
 *     orchestration tool codemode cannot reach.
 *   - `-a` and `-f`/`-x` were listed but are not value-consuming (`-a` is a boolean branch, `-f`
 *     and `-x` are not pi flags at all), so a real allowlist behind them was hidden.
 *   - `--mode`, `--use-theme` and `--list-models` consume only when the value does not start with
 *     `-`, and were treated as unconditional.
 *   - `-p` has a third rule entirely (not `@file`, and not `-` unless it is `---`).
 *
 * The repo already learned this lesson once, in a different corner: `codemode-switch-differential`
 * re-measures a copy of pi's glob resolver so a future pi turns that file red. This is the same
 * move applied to the CLI surface, and for the same reason — a mirror that is only ever checked
 * against itself is a mirror of nothing.
 *
 * **What is compared.** The three fields the reader derives (`allowlist`, `denylist`, `noTools`)
 * against `parseArgs`'s `tools` / `excludeTools` / `noTools` / `noBuiltinTools`. The activation
 * *answer* is deliberately not compared here: it also reads settings files, and that half is
 * covered by `cli-tool-flags.test.ts` with hand-written rows whose expected values are literals.
 *
 * **Version.** pi 1.0.0 from `node_modules`, which is the version this repo compiles against. The
 * parser's shape is stable across 1.0.0 / 1.1.0 for every flag named here (checked by hand on both),
 * but if this file ever goes red on a version bump, check whether pi's parser changed before
 * assuming the reader did.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { cliToolFlags } from "../../src/mode/ptc-mode.ts";

const CODEMODE = "codemode";

/**
 * `dist/cli/args.js` inside the installed pi, or `undefined` when it is not there.
 *
 * Walked up from this file rather than resolved through the package's `exports` map, the same
 * reason `codemode-switch-differential.test.ts` does it: the map does not expose this internal
 * module. pi parses argv with a hand-written loop, and mirroring a hand-written loop is exactly
 * the thing that needs the hand-written loop in front of it.
 */
function argsModulePath(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli",
      "args.js",
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const ARGS_PATH = argsModulePath();
type PiParseArgs = (args: readonly string[]) => {
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean | "all" | "builtin";
  noBuiltinTools?: boolean;
};
let piParseArgs: PiParseArgs | undefined =
  ARGS_PATH === undefined
    ? undefined
    : ((await import(pathToFileURL(ARGS_PATH).href)) as { parseArgs: PiParseArgs }).parseArgs;

/**
 * Leading fragments chosen to cover every way pi's parser can move its cursor: plain booleans,
 * unconditional value consumers, the `startsWith("-")` guards, `-p`'s three-way rule, the
 * unknown-long-flag branch (which eats a bare word and not a flag), and `--` itself.
 */
const PREFIXES: ReadonlyArray<readonly string[]> = [
  [],
  ["-a"],
  ["--approve"],
  ["-na"],
  ["-nt"],
  ["-nbt"],
  ["-ne"],
  ["-ns"],
  ["-np"],
  ["--no-tools"],
  ["--no-builtin-tools"],
  ["--verbose"],
  ["-e", "ext.mjs"],
  ["-e", "-t"],
  ["-e", "--tools"],
  ["--extension", "e.mjs"],
  ["--model", "x"],
  ["--model", "-t"],
  ["--model", "--exclude-tools"],
  ["--models", "a,b"],
  ["--provider", "p"],
  ["--api-key", "k"],
  ["--system-prompt", "x"],
  ["--append-system-prompt", "x"],
  ["--name", "n"],
  ["-n", "n"],
  ["-n", "-t"],
  ["--session", "s"],
  ["--session-id", "id"],
  ["--fork", "f"],
  ["--session-dir", "d"],
  ["--thinking", "high"],
  ["--export", "f.html"],
  ["--skill", "s.md"],
  ["--prompt-template", "p.md"],
  ["--theme", "t.json"],
  ["--mode", "rpc"],
  ["--mode", "-t"],
  ["--use-theme", "dark"],
  ["--use-theme", "-xt"],
  ["--list-models"],
  ["--list-models", "-t"],
  ["--list-models", "gpt"],
  ["-p", "hello"],
  ["-p", "-t"],
  ["-p", "@file"],
  ["--print", "---dash"],
  ["--unknownlong"],
  ["--unknownlong", "-t"],
  ["--unknownlong", "plain"],
  ["-f"],
  ["-x"],
  ["--tools", "read"],
  ["--exclude-tools", "bash"],
  ["-t", "read"],
  ["-xt", "bash"],
  ["--"],
];

/** The tool-flag half, including the order-sensitive include-then-exclude case. */
const TOOL_FLAGS: ReadonlyArray<readonly string[]> = [
  [],
  ["-t", CODEMODE],
  ["-xt", CODEMODE],
  ["--tools", "read"],
  ["--exclude-tools", CODEMODE],
  ["--tools", CODEMODE, "--exclude-tools", CODEMODE],
];

function cases(): ReadonlyArray<readonly string[]> {
  const out: string[][] = [];
  for (const prefix of PREFIXES) for (const tools of TOOL_FLAGS) out.push([...prefix, ...tools]);
  return out;
}

test("pi's own parser was found, or this file measures nothing", () => {
  // A differential whose oracle is missing is a differential that passes for free. Same shape as
  // the corpus-width guard below, and for the same reason: the failure mode is a green file.
  expect(piParseArgs, `dist/cli/args.js not found from ${import.meta.dirname}`).toBeDefined();
});

test("cliToolFlags agrees with pi's own parser on every argv shape in the corpus", () => {
  const parseArgs = piParseArgs;
  if (parseArgs === undefined) return;
  const mismatches: string[] = [];
  for (const argv of cases()) {
    const parsed = parseArgs(["pi", ...argv]);
    const mine = cliToolFlags(argv);
    const same =
      JSON.stringify(parsed.tools ?? null) === JSON.stringify(mine.allowlist ?? null) &&
      JSON.stringify([...(parsed.excludeTools ?? [])].sort()) ===
        JSON.stringify([...mine.denylist].sort()) &&
      (parsed.noTools === true || parsed.noBuiltinTools === true) === mine.noTools;
    if (!same) {
      mismatches.push(
        `  argv ${JSON.stringify(argv)}\n` +
          `    pi   ${JSON.stringify({
            allow: parsed.tools,
            deny: parsed.excludeTools,
            no: parsed.noTools === true || parsed.noBuiltinTools === true,
          })}\n` +
          `    mine ${JSON.stringify(mine)}`,
      );
    }
  }
  expect(
    mismatches,
    `${cases().length} 个 argv 形态中有 ${mismatches.length} 处与 pi 的解析器不一致：\n${mismatches.join("\n")}`,
  ).toEqual([]);
});

test("the corpus is wide enough for the claim above to mean something", () => {
  // A differential over three argv shapes would pass a reader that is wrong about every other
  // flag. This pins the two numbers the other test silently depends on, so a corpus that shrank
  // to something convenient fails here instead of quietly proving less.
  expect(cases().length, "PREFIXES x TOOL_FLAGS").toBe(PREFIXES.length * TOOL_FLAGS.length);
  expect(cases().length).toBeGreaterThanOrEqual(290);
  // Every consuming shape pi has must be represented, or a whole flag can go missing unnoticed.
  for (const required of ["--model", "-e", "--mode", "--use-theme", "--list-models", "-p", "-a"]) {
    expect(
      PREFIXES.some((p) => p.includes(required)),
      `corpus must exercise ${required}`,
    ).toBe(true);
  }
});
