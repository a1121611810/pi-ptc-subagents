/**
 * PROTOTYPE — throwaway. Runs the A/B probe once per route and prints what pi actually sent.
 *
 *   node docs/research/prototype-image-delivery-ab/run.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const PROBE = join(here, "probe-ab.ts");
const ROUTES = ["toolResult", "userMessage", "customMessage"];

function runPi(args, env) {
  return new Promise((resolve) => {
    const child = spawn("pi", args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stderr);
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "ptc-image-ab-"));
for (const route of ROUTES) {
  const out = join(dir, `${route}.jsonl`);
  const stderr = await runPi(
    [
      "--no-session",
      "-ne",
      "-e",
      PROBE,
      "--provider",
      "probe-ab",
      "--model",
      "probe-ab-model",
      "-p",
      "produce an image",
    ],
    { ...process.env, AB_ROUTE: route, AB_OUT: out },
  );

  console.log(`\n=== route: ${route} ===`);
  let lines = [];
  try {
    lines = readFileSync(out, "utf8").trim().split("\n");
  } catch {
    console.log("  (no provider request reached the probe)");
  }
  for (const line of lines) {
    const record = JSON.parse(line);
    console.log(`  request ${record.request}:`);
    for (const message of record.messages) console.log(`    ${message}`);
  }
  console.log(`  → ${lines.length} LLM request(s)`);
  if (stderr.trim().length > 0)
    console.log(`  [stderr] ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
}
rmSync(dir, { recursive: true, force: true });
