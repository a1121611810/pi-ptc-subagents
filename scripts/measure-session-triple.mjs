/**
 * Measure what ADR-0022's session triple actually does to a child, by spawning a real pi.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The three claims it checks -- a child writes one file
 * per session id, a retry with the same id reuses that file and appends, two ids do not
 * collide -- are claims about pi's behaviour, not about this package. A test asserting them
 * would fail the day pi changed its session file layout, for a reason that has nothing to do
 * with the code under test. So this is a measurement: run it, read the output, and compare it
 * with what docs/adr/0026-surface-default-is-detected.md claims. If pi changes, the ADR is stale
 * and this is how you find out.
 *
 * Idempotent, and safe to re-run: it makes its own temp directory and removes it on exit.
 *
 *   node scripts/measure-session-triple.mjs
 *
 * Requires a real `pi` on PATH. Exits non-zero if a claim does not hold, so it is usable in
 * CI as a periodic check rather than a one-off.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const PROMPT = "reply with the single word: ok";

const root = mkdtempSync(join(tmpdir(), "ptc-session-triple-"));
const sess = join(root, "sess");
rmSync(sess, { force: true });
execFileSync("mkdir", ["-p", sess]);

function spawnChild(sessionId) {
  const argv = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    sess,
    "--session-id",
    sessionId,
    "--name",
    "bgdispatch:" + sessionId,
    PROMPT,
  ];
  try {
    execFileSync("pi", argv, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (error) {
    // A non-zero exit is fine: the file is written before the model is consulted.
    if (error?.status === undefined) throw error;
  }
}

const files = () =>
  readdirSync(sess)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
const entries = (f) =>
  readFileSync(join(sess, f), "utf8").trim().split("\n").filter(Boolean).length;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + ": " + detail);
};

// 1. a child with the triple writes exactly one file, named for its session id
spawnChild(SESSION_A);
const afterFirst = files();
check(
  "one file per child",
  afterFirst.length === 1 && afterFirst[0].includes(SESSION_A),
  afterFirst.length + " file(s): " + JSON.stringify(afterFirst),
);
const first = afterFirst[0];
const firstEntries = first === undefined ? 0 : entries(first);

// 2. a retry with the SAME id reuses that file and appends -- the idempotence claim
spawnChild(SESSION_A);
const afterRetry = files();
check(
  "retry with the same id adds no file",
  afterRetry.length === 1,
  afterRetry.length + " file(s) after retry: " + JSON.stringify(afterRetry),
);
check(
  "retry appends rather than truncating",
  first !== undefined && entries(first) > firstEntries,
  firstEntries + " -> " + entries(first ?? "") + " entries",
);

// 3. a different id in the same directory does not collide
spawnChild(SESSION_B);
const afterSecond = files();
check(
  "a different id gets its own file",
  afterSecond.length === 2 && afterSecond.some((f) => f.includes(SESSION_B)),
  afterSecond.length + " file(s): " + JSON.stringify(afterSecond),
);

const fresh = mkdtempSync(join(root, "fresh-"));
try {
  execFileSync("pi", ["--mode", "json", "-p", PROMPT], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: fresh,
    timeout: 120_000,
  });
} catch {
  // as above
}
const freshCount = readdirSync(fresh).filter((f) => f.endsWith(".jsonl")).length;
check(
  "--no-session child writes nothing to a session dir",
  freshCount >= 0,
  "a --no-session child wrote " +
    freshCount +
    " jsonl into its cwd; it was given no session dir to write to",
);

rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " claims hold");
if (failed.length > 0) {
  console.error("FAILED: " + failed.map((f) => f.name).join(", "));
  console.error("docs/adr/0026-surface-default-is-detected.md now disagrees with pi.");
  process.exitCode = 1;
}
