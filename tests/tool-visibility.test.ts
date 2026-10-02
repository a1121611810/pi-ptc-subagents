/**
 * End-to-end checks against the **built** `dist/index.js`, driven by real pi with a canned provider.
 *
 * Unit tests drive the extension through a stub, which cannot catch the failures that appear only
 * when pi really loads the bundle: a missing runtime import (`@earendil-works/pi-tui` is a
 * transitive dependency, not a declared one), a broken ESM shape, or a `promptSnippet` that never
 * reaches the request. `tests/fixtures/fake-provider-probe.ts` supplies an offline provider that
 * reports what pi assembled, so these run without network or credentials.
 *
 * PTC mode's narrowing cannot be exercised here — it is TUI-only and a test process has no TTY — so
 * these cover the print-mode half (the session is left exactly as launched) plus the mechanism the
 * mode relies on (`setActiveTools` really does change what the provider is offered). The mode's own
 * logic is covered by `tests/ptc-mode.test.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { RegistryRecord } from "./fixtures/codemode-registry-probe.ts";
import { makeTempDir, removeTempDir } from "./helpers/ptc.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(repoRoot, "dist", "index.js");
const PROBE = join(repoRoot, "tests", "fixtures", "fake-provider-probe.ts");
const REGISTRY_PROBE = join(repoRoot, "tests", "fixtures", "codemode-registry-probe.ts");
/** pi's own `codemode`, asked for by name: the only way to register it without discovery. */
const BUILTIN_CODEMODE = "builtin:codemode";

/**
 * The pi the detection test measures, if this machine has one that can have a codemode.
 *
 * `spawn("pi")` resolves through PATH, and under vitest PATH begins with `node_modules/.bin`,
 * so the bare name lands on the pinned `@earendil-works/pi-coding-agent@0.86.1`, which ships no
 * codemode at all. That one is still the right pi for the other tests in this file (it is the
 * version this repo compiles against, and they are about the built dist loading and about tool
 * visibility) -- and the no-codemode branch of detection is pinned against it, unconditionally,
 * by the last test in this file.
 *
 * What cannot be done with it is the OTHER branch. The previous resolution here was
 * `findRealPi()`: the first executable named `pi` outside a `node_modules/.bin`, chosen with
 * `existsSync` and nothing else. That answers a question about the filesystem -- is there a
 * file called `pi` -- and not the question the test then asked, which is about pi's registry.
 * Round 4 measured both ways that goes wrong, and both are silent:
 *
 *   - a stray non-pi executable named `pi` first on PATH: the test failed in 308 ms here
 *     (89 ms in the round-4 measurement) with 'the probe never observed a provider request',
 *     which blames the harness over a binary that was never a pi at all.
 *   - a no-codemode pi first on PATH: the test PASSED, because the expectation was written as
 *     "whatever this pi's registry says", so the wrong pi agreed with itself.
 *
 * So the resolution asks pi instead of the filesystem: walk the candidates in PATH order and
 * keep the first one whose OWN registry, read in a real run of that pi, reports
 * `hasCodemode: true` (`codemodeSupport` below). A candidate that cannot answer -- not a pi,
 * or a pi too old to have a registry -- is recorded and stepped over rather than being allowed
 * to decide the answer by being first.
 *
 * Cost: one pi startup per candidate until one says yes. On this machine that is one.
 */
const CODEMODE_PI = await resolveCodemodePi();

/**
 * Executables named `pi` on PATH, in resolution order, minus this repo's own bin directories.
 *
 * Excluding `node_modules/.bin` is not a preference: the pinned devDependency sits there, and
 * it is a pi with no codemode, so letting it answer would make every machine's detection test
 * measure the pinned pi instead of the one the developer runs.
 */
function piCandidates(): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    // Both separators: PATH entries are joined with `delimiter` but the "inside a
    // node_modules" part is always a path separator, so checking for `node_modules:.bin`
    // (a colon, on POSIX) silently keeps this repo's own pinned pi in the candidate list --
    // measured, and visible in the survey the skip message prints.
    if (/(^|[/\\])node_modules[/\\]\.bin$/.test(dir)) continue;
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

interface CodemodePiResolution {
  /** The first candidate whose registry reports codemode; absent when none does. */
  bin: string | undefined;
  /** What every candidate answered, so a skip says which pis were asked and what they said. */
  survey: string;
}

async function resolveCodemodePi(): Promise<CodemodePiResolution> {
  const answers: string[] = [];
  for (const candidate of piCandidates()) {
    let ships: boolean;
    try {
      ships = await codemodeSupport(candidate);
    } catch (error) {
      // A candidate that cannot be asked is a measurement, not a crash: the next one may
      // still be the pi this test needs. The reason goes into the survey so a skip names it
      // rather than reporting a bare "nothing found".
      answers.push(
        candidate + " -> no answer: " + (error instanceof Error ? error.message : error),
      );
      continue;
    }
    answers.push(candidate + " -> " + (ships ? "ships codemode" : "no codemode"));
    if (ships) return { bin: candidate, survey: answers.join("; ") };
  }
  return {
    bin: undefined,
    survey:
      answers.length === 0
        ? "no executable named pi on PATH outside node_modules/.bin"
        : answers.join("; "),
  };
}

/** The named reason the subagents half of detection is skipped, and why it is not a defect. */
const NO_CODEMODE_PI_REASON =
  "no installed pi ships codemode, so the 'this pi has codemode' branch of detection has nothing " +
  "to measure here (" +
  CODEMODE_PI.survey +
  "); the no-codemode branch is still pinned " +
  "unconditionally by the last test in this file";

/**
 * The title carries the skip reason because `test.skipIf` takes no reason argument and vitest
 * prints the title. A skip that says only "skipped" is indistinguishable from a broken machine.
 */
const SUBAGENTS_HALF_TITLE =
  "on a real pi that ships codemode: a plain launch gets the PTC surfaces, and a launch whose " +
  "loadout names codemode gets the subagent face" +
  (CODEMODE_PI.bin === undefined ? " -- SKIPPED: " + NO_CODEMODE_PI_REASON : "");

interface ProbeRecord {
  tools: string[];
  prompt: string;
}

/**
 * The two surfaces ADR-0026 decision 1 chooses between, as literals.
 *
 * The three task tools are in both: BG-14 registers `ptc_task_*` outside PTC mode, so the
 * orchestrator face is the only thing detection decides. Written out rather than derived from a
 * constant in `src/`, so a change to what the factory registers has to be made here on purpose.
 */
const SUBAGENTS_SURFACE = ["ptc_subagent", "ptc_task_list", "ptc_task_output", "ptc_task_stop"];
const FULL_SURFACE = [
  "ptc_run_code",
  "ptc_task_list",
  "ptc_task_output",
  "ptc_task_stop",
  "ptc_workflow",
];

/**
 * Run pi until it exits.
 *
 * stdin is `/dev/null`, not a pipe: in print mode pi reads piped stdin and merges it into the
 * initial prompt, so an inherited-to-the-test pipe that is never closed leaves pi waiting for EOF
 * forever (the first version of this test timed out at 60 s for exactly that reason).
 */
/**
 * Run pi until it exits. `bin` defaults to the bare name, i.e. whatever PATH resolves; see
 * {@link CODEMODE_PI} for why the detection test overrides it.
 */
function runPi(args: string[], env: NodeJS.ProcessEnv, bin = "pi"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not exit within 60 s. stderr:\n${stderr.slice(-2000)}`));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // The exit code is deliberately ignored: the payload is the subject under test, and pi can exit
    // non-zero for unrelated reasons in a bare environment. A missing payload is the real failure,
    // and `capturePayload` reports that.
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** One pi print-mode session against the canned provider, reporting what pi was about to send. */
async function capturePayload(options: {
  withDist?: boolean;
  narrow?: string;
  /** ADR-0025: which surface the built extension registers. Defaults to `full`. */
  surfaceMode?: "off" | "subagents" | "full" | "detected";
  /** Which pi binary to spawn. Defaults to the bare name; see {@link CODEMODE_PI}. */
  bin?: string;
  /**
   * ADR-0029: a `--tools` allowlist for the spawned pi, which is how a real session puts
   * `codemode` into the model's tool list. Passed through verbatim, so the value here is the
   * value pi parses.
   */
  tools?: string;
}): Promise<ProbeRecord> {
  const dir = await makeTempDir("pi-ptc-probe-");
  const out = join(dir, "payload.json");
  const args = [
    "--no-session",
    // `-ne` keeps the developer's extensions out of the measurement, and it is safe for every
    // case that pins `surfaceMode` in ptc.json. It is NOT safe for the "detected" half, and
    // ADR-0027 is why: `-ne` resolves the codemode SWITCH to `disabled`, so with it the detected
    // default is `full` and that half would never reach the cell it is named for. The
    // PI_CODING_AGENT_DIR pin below already excludes the developer's real packages, so dropping
    // `-ne` for this one spawn costs no isolation and puts pi back in its default state --
    // built-ins loaded, which is the "ships codemode AND loads it" cell.
    ...(options.surfaceMode === "detected" ? [] : ["-ne"]),
    ...(options.tools === undefined ? [] : ["--tools", options.tools]),
    "-e",
    PROBE,
    ...(options.withDist === true ? ["-e", DIST] : []),
    "--provider",
    "ptc-probe",
    "--model",
    "ptc-probe-model",
    "-p",
    "hello",
  ];
  // ADR-0025: the built extension reads the agent-dir ptc.json at construction time, so this
  // probe pins PI_CODING_AGENT_DIR. Without the pin a developer with {"surfaceMode":"off"}
  // configured gets three failures here for a reason unrelated to the code under test -- the
  // same invisible class as the verify-dist-render gate the first round had to fix separately.
  // ADR-0026: "detected" writes NO key, so the built extension runs its real codemode probe
  // against the pi that is actually launching it. That is the only place the probe meets a real
  // pi rather than a fixture, and the filesystem layout it depends on is exactly the kind of
  // thing a unit test with a hand-built tree gets wrong.
  if (options.surfaceMode !== "detected") {
    await writeFile(
      join(dir, "ptc.json"),
      JSON.stringify({ surfaceMode: options.surfaceMode ?? "full" }),
      "utf8",
    );
  }
  await runPi(
    args,
    {
      ...process.env,
      PI_CODING_AGENT_DIR: dir,
      PTC_PROBE_OUT: out,
      ...(options.narrow === undefined ? {} : { PTC_PROBE_NARROW: options.narrow }),
    },
    options.bin,
  );

  const record = await readPayload(out);
  await removeTempDir(dir);
  if (record === undefined) throw new Error("the probe never observed a provider request");
  return record;
}

async function readPayload(path: string): Promise<ProbeRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProbeRecord;
  } catch {
    return undefined;
  }
}

/**
 * Whether the pi that would launch us can hand over its own `codemode` — asked of pi, not of us.
 *
 * A second spawn, on purpose. `-e builtin:codemode` is how a test gets pi to register its own
 * tool without opening extension discovery (which would load whatever the developer has
 * installed), and pi treats an unknown built-in as FATAL: it exits before the provider request
 * and before `session_start`. So the question cannot ride along with the run that depends on the
 * answer — on a pi without codemode it would take that run down with it.
 *
 * The discriminator is pi's registry at `session_start`, where `getAllTools()` finally answers
 * (ADR-0026: it throws from a factory). The factory marker the fixture writes first is what
 * makes a missing answer readable: a file that still says `factory` means pi refused the
 * built-in, which is a measurement, not a broken harness.
 */
async function codemodeSupport(bin: string): Promise<boolean> {
  const dir = await makeTempDir("pi-ptc-codemode-");
  const out = join(dir, "registry.json");
  await runPi(
    [
      "--no-session",
      "-ne",
      "-e",
      PROBE,
      "-e",
      REGISTRY_PROBE,
      "-e",
      BUILTIN_CODEMODE,
      "--provider",
      "ptc-probe",
      "--model",
      "ptc-probe-model",
      "-p",
      "hello",
    ],
    {
      ...process.env,
      PI_CODING_AGENT_DIR: dir,
      PTC_PROBE_OUT: join(dir, "payload.json"),
      PTC_REGISTRY_OUT: out,
    },
    bin,
  );
  const record = await readRegistry(out);
  await removeTempDir(dir);
  if (record === undefined) {
    throw new Error(
      "the registry probe never ran: neither fixture loaded into that pi run, so the harness " +
        "is broken rather than the pi lacking codemode",
    );
  }
  // `factory` means pi never reached session_start, which is what this pi not shipping the
  // built-in looks like: it fails the `-e` load, before any request. Either way the answer to
  // the question asked here is no, so the surface below has to be the full one.
  return record.stage === "session_start" && record.hasCodemode;
}

/**
 * The `ptc_*` names pi's REGISTRY holds after loading the built extension, on a real pi, with
 * `codemode` both registered and active.
 *
 * Two things this needs that {@link capturePayload} cannot give it, and both are loadout facts:
 *
 *   - `-e builtin:codemode` puts codemode in the registry, which a plain launch cannot do. It is
 *     fatal on a pi that does not ship the built-in, so the caller has already established that
 *     this pi does (see `codemodeSupport`).
 *   - `--tools …,codemode` puts it in the ACTIVE set. The activation probe reads the command line,
 *     so this is the half of ADR-0029 that only a real launch can exercise.
 *
 * The registry rather than the model-facing tool list, and that choice is the whole reason this is
 * a separate function. `--tools` narrows BOTH: `getCurrentTools()` obviously, and `getAllTools()`
 * too, because pi builds the registry with `includeAllExtensionTools` unset on the initial load. So
 * an allowlist naming only some of this package's tools hides the rest, and "absent" stops meaning
 * "never registered".
 *
 * That is why the caller passes a SUPERSET of both surfaces — every name either one could register,
 * plus `codemode`. With all of them allowed, a name missing from the registry is missing because the
 * factory did not register it, which is the only thing this test is trying to read. An allowlist
 * naming just the subagent face would also pass for a `full` session, which is the measurement this
 * exists to avoid making.
 */
async function captureRegisteredPtcTools(options: {
  bin: string;
  tools: string;
}): Promise<string[]> {
  const dir = await makeTempDir("pi-ptc-registry-");
  const out = join(dir, "registry.json");
  await runPi(
    [
      "--no-session",
      "-e",
      PROBE,
      "-e",
      REGISTRY_PROBE,
      "-e",
      BUILTIN_CODEMODE,
      "-e",
      DIST,
      "--tools",
      options.tools,
      "--provider",
      "ptc-probe",
      "--model",
      "ptc-probe-model",
      "-p",
      "hello",
    ],
    {
      ...process.env,
      PI_CODING_AGENT_DIR: dir,
      PTC_PROBE_OUT: join(dir, "payload.json"),
      PTC_REGISTRY_OUT: out,
    },
    options.bin,
  );
  const record = await readRegistry(out);
  await removeTempDir(dir);
  if (record === undefined || record.stage !== "session_start") {
    throw new Error(
      "the registry probe never reached session_start, so the measurement below would be empty " +
        "rather than wrong — and an empty tool list is what a filtered loadout also looks like",
    );
  }
  return record.tools.filter((name) => name.startsWith("ptc_")).sort();
}

async function readRegistry(path: string): Promise<RegistryRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RegistryRecord;
  } catch {
    return undefined;
  }
}

// Each session costs a pi startup, so the two variants every test needs are captured once.
let withoutDist: Promise<ProbeRecord> | undefined;
let withDist: Promise<ProbeRecord> | undefined;
const baseline = (): Promise<ProbeRecord> => (withoutDist ??= capturePayload({}));
const extended = (): Promise<ProbeRecord> => (withDist ??= capturePayload({ withDist: true }));

test("the built dist loads under real pi and adds both PTC tools beside the built-ins", async () => {
  const [before, after] = await Promise.all([baseline(), extended()]);

  expect(after.tools).toContain("ptc_run_code");
  expect(after.tools).toContain("ptc_workflow");
  // The diff is attributable to the extension: the same harness without it exposes none of them.
  expect(before.tools).not.toContain("ptc_run_code");
  expect(before.tools).not.toContain("ptc_workflow");

  // Print mode is deliberately never narrowed (the mode requires ctx.mode === "tui"), so the
  // built-ins must still be directly callable here.
  for (const builtin of ["read", "bash", "edit", "write"]) {
    expect(after.tools).toContain(builtin);
  }
}, 120_000);

test("the PTC tools reach the request with their prompt snippets and guideline", async () => {
  const { prompt } = await extended();
  // `promptSnippet` is what puts a custom tool into the prompt's "Available tools" section. Without
  // it the model sees the declarations but the prompt lists nothing usable — which would be
  // especially broken in PTC mode, where these two are the only callable tools.
  expect(prompt).toContain("composes pi's tools in one shot");
  expect(prompt).toContain("structured TypeScript workflow");
  // Guidelines must name their tool (pi appends them flat, with no tool-name prefix).
  expect(prompt).toContain("Use ptc_run_code when");
}, 120_000);

test("narrowing the loadout really does change what the provider is offered (the mechanism PTC mode relies on)", async () => {
  const narrowed = await capturePayload({
    withDist: true,
    narrow: "ptc_run_code,ptc_workflow",
  });
  expect(narrowed.tools).toEqual(["ptc_run_code", "ptc_workflow"]);
  // …which is exactly why bindings must come from a base snapshot: the built-ins are no longer in
  // the live loadout, so a binding table derived from it would be empty.
  expect(narrowed.tools).not.toContain("read");
}, 120_000);
test.skipIf(CODEMODE_PI.bin === undefined)(
  SUBAGENTS_HALF_TITLE,
  async () => {
    // ADR-0026 decisions 1 and 6, end to end. Every other test in this file pins a mode; this one
    // pins nothing and lets the built extension run its real codemode probe against the pi actually
    // launching it. The probe walks a filesystem layout, and a hand-built tree in a unit test is
    // exactly the kind of fixture that gets a real install's layout wrong.
    //
    // The other half -- a pi that does NOT ship codemode gets the full surface -- is the last
    // test in this file, and it runs on every machine. This half needs a pi that really does ship
    // one, or there is nothing to detect, so it is skipped by name when the machine has none
    // rather than being run against a pi that cannot answer the question.
    //
    // What the expected value is anchored to, and why it is a literal now: the bin under test is
    // chosen by asking each candidate's own registry (see `resolveCodemodePi`), and the
    // expectation is `SUBAGENTS_SURFACE` as written above it. The previous version computed the
    // expectation FROM the same measurement (`registryHasCodemode ? SUBAGENTS : FULL`), which is
    // what let a wrong binary on PATH pass the test by agreeing with itself. Here the
    // measurement is a PRECONDITION: if the chosen pi turns out not to ship codemode, the run
    // says so and fails, rather than quietly expecting the fallback.
    const bin = CODEMODE_PI.bin;
    if (bin === undefined) {
      // Unreachable: `skipIf` is driven by the same value. Throwing (rather than falling back to
      // a bare name) keeps a resolution bug from turning into a silent measurement of some other
      // pi, which is the failure this whole change exists to remove.
      throw new Error(
        "the subagents half was reached with no codemode pi: " + NO_CODEMODE_PI_REASON,
      );
    }
    const [registryHasCodemode, plain, delegatedPtc] = await Promise.all([
      codemodeSupport(bin),
      capturePayload({ withDist: true, surfaceMode: "detected", bin }),
      captureRegisteredPtcTools({
        bin,
        // ADR-0029: the one thing a plain launch does not do is put `codemode` in the loadout.
        // Naming it on the command line is the half of the probe only a real launch can exercise.
        // Every ptc_* name either surface could register is allowed too, so what the registry
        // reports is the factory's decision rather than this list — see the function's note.
        tools: [
          ...new Set([
            "read",
            "bash",
            "edit",
            "write",
            "codemode",
            ...SUBAGENTS_SURFACE,
            ...FULL_SURFACE,
          ]),
        ].join(","),
      }),
    ]);
    expect(
      registryHasCodemode,
      "the pi this half measures really does ship codemode (" + bin + ")",
    ).toBe(true);

    // The default cell: a real pi that ships codemode, launched with nothing configured. Before
    // ADR-0029 this was `subagents`, which meant `ptc_subagent` with no orchestrator and a
    // warning on every session. It is now `full`, silently, which is the fix stated as a fact
    // about the built artifact rather than about the probe.
    const plainPtc = plain.tools.filter((name) => name.startsWith("ptc_")).sort();
    expect(
      plainPtc,
      "a plain launch on a pi that ships codemode gets the PTC surfaces, because codemode is " +
        "registered inactive and the model cannot call it (ADR-0029)",
    ).toEqual(FULL_SURFACE);

    // The delegated cell, same binary, same everything but the loadout. Asked of the REGISTRY, so
    // the absence of the run-code front is "never registered" rather than "filtered out of the
    // allowlist" — which is the distinction `--tools` would otherwise erase.
    expect(
      delegatedPtc,
      "and with codemode in the tool list the same pi registers the subagent face and nothing else",
    ).toEqual(SUBAGENTS_SURFACE);

    // The two orchestrators, named one at a time so a failure says which half moved. This pair is
    // what the neutered-probe mutation breaks: with CODEMODE_PROBE_PATHS emptied this pi still
    // ships codemode, so the expectation above turns red.
    expect(
      delegatedPtc.includes("ptc_subagent"),
      "a pi whose loadout names codemode is handed the subagent face",
    ).toBe(true);
    expect(
      delegatedPtc.includes("ptc_run_code"),
      "and never both orchestrators at once — the thing this setting exists to prevent",
    ).toBe(false);
  },
  120_000,
);

test("a plain launch never delegates, whichever pi is on PATH (ADR-0029)", async () => {
  // The half that runs on EVERY machine, including one where nothing installed ships codemode.
  //
  // It is the same launch as its sibling — no `surfaceMode` key, no `--tools` — and the point is
  // that the answer no longer depends on whether the pi happens to ship codemode. It used to:
  // the previous version branched the expectation on `registryHasCodemode`, which on a developer
  // machine with pi 1.0 on PATH made this test assert `subagents` and a CI machine with the
  // pinned devDependency assert `full`, so it was measuring the PATH rather than the code.
  //
  // ADR-0029 makes the expectation a constant, which is the honest form: with no loadout naming
  // it, `codemode` is registered inactive on every pi, so `full` is the only correct answer
  // whichever binary is under test. `registryHasCodemode` is still reported in the failure
  // message, because "this pi does not even ship codemode" is worth knowing when it goes red.
  const [registryHasCodemode, detected] = await Promise.all([
    codemodeSupport("pi"),
    capturePayload({ withDist: true, surfaceMode: "detected" }),
  ]);
  const detectedPtc = detected.tools.filter((name) => name.startsWith("ptc_")).sort();

  expect(
    detectedPtc,
    "this pi " +
      (registryHasCodemode ? "ships" : "does not ship") +
      " codemode, and this launch does not put it in the tool list, so the detected default " +
      "must be full (ADR-0029)",
  ).toEqual(FULL_SURFACE);
  expect(
    detectedPtc.includes("ptc_run_code"),
    "a session that cannot call codemode keeps the front, or the delegation hands over to nothing",
  ).toBe(true);
  expect(detectedPtc.includes("ptc_subagent"), "and hands over nothing in its place").toBe(false);
}, 120_000);
