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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/ptc.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(repoRoot, "dist", "index.js");
const PROBE = join(repoRoot, "tests", "fixtures", "fake-provider-probe.ts");

interface ProbeRecord {
  tools: string[];
  prompt: string;
}

/**
 * Run pi until it exits.
 *
 * stdin is `/dev/null`, not a pipe: in print mode pi reads piped stdin and merges it into the
 * initial prompt, so an inherited-to-the-test pipe that is never closed leaves pi waiting for EOF
 * forever (the first version of this test timed out at 60 s for exactly that reason).
 */
function runPi(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
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
  surfaceMode?: "off" | "subagents" | "full";
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
  await writeFile(
    join(dir, "ptc.json"),
    JSON.stringify({ surfaceMode: options.surfaceMode ?? "full" }),
    "utf8",
  );
  await runPi(args, {
    ...process.env,
    PI_CODING_AGENT_DIR: dir,
    PTC_PROBE_OUT: out,
    ...(options.narrow === undefined ? {} : { PTC_PROBE_NARROW: options.narrow }),
  });

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
