#!/usr/bin/env node
/**
 * Baseline test entry for pi-ptc-subagents.
 *
 * Runs Node's built-in test runner over `tests/**\/*.test.ts`. Until the first
 * suites land, a clean checkout must still pass: when no test files exist we
 * exit 0 with a notice instead of failing.
 *
 * TypeScript test files execute via Node's native type stripping (on by
 * default for Node >= 23.6; Node 22.x needs --experimental-strip-types).
 * Source and tests therefore stay within "erasable syntax only"
 * (see tsconfig `erasableSyntaxOnly`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testsDir = join(root, "tests");

const files = existsSync(testsDir)
  ? readdirSync(testsDir, { recursive: true })
      .filter((name) => typeof name === "string" && name.endsWith(".test.ts"))
      .map((name) => join(testsDir, name))
      .sort()
  : [];

if (files.length === 0) {
  console.log("pi-ptc-subagents: no test files yet (tests/**/*.test.ts) — nothing to run");
  process.exit(0);
}

const [major, minor] = process.versions.node.split(".").map(Number);
const needsStripFlag = major < 23 || (major === 23 && minor < 6);

const args = ["--test", ...(needsStripFlag ? ["--experimental-strip-types"] : []), ...files];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
