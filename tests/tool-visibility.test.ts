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
import { join } from "node:path";
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
 * The pi the detection test measures, if the machine has one that is not this repo's own.
 *
 * `spawn("pi")` resolves through PATH, and under vitest PATH begins with `node_modules/.bin`,
 * so the bare name lands on the pinned `@earendil-works/pi-coding-agent@0.86.1` rather than on
 * the pi the developer actually runs. That one ships no `codemode` at all, so the detection
 * this test exists to verify could never be observed against it -- the filesystem probe and
 * pi's own registry would both answer "absent" forever, and any comparison between them would
 * agree for the wrong reason. Measured on this machine:
 *
 *   node_modules/.bin/pi 0.86.1  ->  registry absent, probe not-found, surface full
 *   ~/.bun/bin/pi       0.99.1  ->  registry present, probe found,     surface subagents
 *
 * The other tests in this file keep using the bare name: they are about the built dist
 * loading and about tool visibility, and the pinned pi is the version this repo compiles
 * against. Only detection needs a pi that can have a codemode.
 *
 * Falling back to the bare name is not a skip: the run still asserts the relationship and still
 * turns red for a probe that answers the wrong way. It simply cannot cover the "this pi has
 * codemode" branch on a machine where no such pi is installed, because there the true answer
 * genuinely is "no codemode".
 */
const REAL_PI = findRealPi();

/** First `pi` on PATH that is not one of this repo's own bin directories, if any. */
function findRealPi(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    if (dir.endsWith("node_modules/.bin") || dir.endsWith("node_modules\\.bin")) continue;
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

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
 * {@link REAL_PI} for why the detection test overrides it.
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
  /** Which pi binary to spawn. Defaults to the bare name; see {@link REAL_PI}. */
  bin?: string;
}): Promise<ProbeRecord> {
  const dir = await makeTempDir("pi-ptc-probe-");
  const out = join(dir, "payload.json");
  const args = [
    "--no-session",
    "-ne",
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
test("with no key, the surface follows the pi's own registry, not our filesystem guess", async () => {
  // ADR-0026 decisions 1 and 6, end to end. Every other test in this file pins a mode; this one
  // pins nothing and lets the built extension run its real codemode probe against the pi actually
  // launching it. The probe walks a filesystem layout, and a hand-built tree in a unit test is
  // exactly the kind of fixture that gets a real install's layout wrong.
  //
  // The discriminator is measured FROM PI: `codemodeSupport` reads pi's own tool registry, in a
  // separate pi run of pi's own choosing. The previous version compared the detected run against
  // an explicit `full` run, which is a comparison between two of our OWN runs -- a probe that
  // never finds codemode yields the full surface, the explicit run yields the full surface, the
  // two agree, and the test passes on a pi that does ship codemode. Measured: with
  // CODEMODE_PROBE_PATHS emptied, the old test stayed green. It also returned early exactly when
  // the two agreed, so the one case that mattered was the case that asserted nothing.
  //
  // Both directions are asserted, and the assertion always runs: the expected VALUE is pi's
  // answer, not a branch on what we produced. On a pi with no codemode the expectation is the
  // full surface, which is ADR-0026 decision 3's documented fallback, so that case is a real
  // assertion rather than a skip.
  // One binary for both halves, or the two are talking about different pis. See REAL_PI.
  const bin = REAL_PI ?? "pi";
  const [registryHasCodemode, detected] = await Promise.all([
    codemodeSupport(bin),
    capturePayload({ withDist: true, surfaceMode: "detected", bin }),
  ]);
  const detectedPtc = detected.tools.filter((name) => name.startsWith("ptc_")).sort();

  // The whole surface, not just the orchestrator name: a probe that reached `subagents` while
  // still registering a `ptc_run_code` beside it, or that dropped a task tool, fails here.
  expect(
    detectedPtc,
    "this pi " +
      (registryHasCodemode ? "ships" : "does not ship") +
      " codemode, so the detected default must be " +
      (registryHasCodemode ? "subagents" : "full") +
      " (ADR-0026 decision 1)",
  ).toEqual(registryHasCodemode ? SUBAGENTS_SURFACE : FULL_SURFACE);

  // The two orchestrators, named one at a time so a failure says which half moved. This pair is
  // what the mutation breaks: with the probe emptied this pi still ships codemode, so it is the
  // expectation above that turns red.
  expect(
    detectedPtc.includes("ptc_subagent"),
    "a pi that ships codemode is handed the subagent face",
  ).toBe(registryHasCodemode);
  expect(
    detectedPtc.includes("ptc_run_code"),
    "and never both orchestrators at once — the thing this setting exists to prevent",
  ).toBe(!registryHasCodemode);
}, 120_000);

test("on the pi this repo pins as a devDependency -- which ships no codemode -- the detected default is full", async () => {
  // The other branch of the same rule, and the one that can be measured on EVERY machine.
  //
  // The detection test above needs a pi that actually ships codemode, or there is nothing to
  // detect and the "pi has codemode" half is untestable. This half is the mirror image: the pi
  // that `spawn("pi")` finds under vitest is the repo's own pinned devDependency, which has no
  // codemode at all, so its correct answer is `full` and a probe that wrongly answers "present"
  // turns this red. Written the same way as its sibling -- the expected value is pi's own
  // registry, not a branch on what we produced -- so if a dependency bump ever gives this pi a
  // codemode the expectation follows it instead of going stale.
  const [registryHasCodemode, detected] = await Promise.all([
    codemodeSupport("pi"),
    capturePayload({ withDist: true, surfaceMode: "detected" }),
  ]);
  const detectedPtc = detected.tools.filter((name) => name.startsWith("ptc_")).sort();

  expect(
    detectedPtc,
    "this pi " +
      (registryHasCodemode ? "ships" : "does not ship") +
      " codemode, so the detected default must be " +
      (registryHasCodemode ? "subagents" : "full") +
      " (ADR-0026 decision 1)",
  ).toEqual(registryHasCodemode ? SUBAGENTS_SURFACE : FULL_SURFACE);
  expect(
    detectedPtc.includes("ptc_run_code"),
    "a pi with no codemode keeps the front, or ADR-0026 decision 3's fallback is not the fallback",
  ).toBe(!registryHasCodemode);
  expect(detectedPtc.includes("ptc_subagent"), "and hands over nothing in its place").toBe(
    registryHasCodemode,
  );
}, 120_000);
