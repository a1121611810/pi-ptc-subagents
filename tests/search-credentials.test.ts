/**
 * Resolving the DeepSeek credential out of a pi agent directory.
 *
 * ## The fixtures
 *
 * Six shapes of `auth.json`, each one measured against pi's own resolver in
 * `docs/research/pi-credential-surface-20261020.md` §2.2 and §4.2. Three of them are the
 * regression guard for the trap this module exists to avoid:
 *
 * - the `$VAR` template and the `!command` line are **unparsed** by `readStoredCredential`, so an
 *   implementation built on it would hand back the template or the command string as if it were
 *   the key;
 * - the `oauth` entry and the entry with no `key` are **entries that exist but carry no key**, so
 *   an implementation that asks "is there an entry?" instead of "is there a usable key?" reports
 *   them as configured.
 *
 * ## Why the ambient environment variable is removed
 *
 * pi's ambient lookup reads `process.env`, and its value differs from machine to machine. The
 * fixture removes it for the duration of each test, so the "environment level" the tests exercise
 * is the injected one and nothing else.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDeepSeekCredential } from "../src/search/credentials.ts";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-ptc-ds-credential-"));
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

function writeAuth(value: unknown): void {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(value), "utf-8");
}

function writeModels(value: unknown): void {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(value), "utf-8");
}

describe("resolveDeepSeekCredential", () => {
  test("a literal key in auth.json is the resolved key", async () => {
    writeAuth({ deepseek: { type: "api_key", key: "sk-test-literal" } });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-literal");
    expect(credential.source).toBe("stored credential");
  });

  test("a $VAR template is interpolated, not handed back as the key", async () => {
    writeAuth({
      deepseek: {
        type: "api_key",
        key: "$DS_TEST_KEY",
        env: { DS_TEST_KEY: "sk-test-interpolated" },
      },
    });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-interpolated");
    expect(credential.key).not.toBe("$DS_TEST_KEY");
  });

  test("a !command line is executed, not handed back as the key", async () => {
    writeAuth({ deepseek: { type: "api_key", key: "!echo sk-test-from-command" } });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-from-command");
    expect(credential.key).not.toBe("!echo sk-test-from-command");
  });

  test("an oauth entry is not a usable api key, so the provider is not configured", async () => {
    writeAuth({
      deepseek: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 4102444800000,
      },
    });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(false);
    expect(credential.key).toBeUndefined();
  });

  test("an entry without a key field is not a configured provider", async () => {
    writeAuth({ deepseek: { type: "api_key" } });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(false);
    expect(credential.key).toBeUndefined();
  });

  test("the environment level is used when nothing is stored", async () => {
    const credential = await resolveDeepSeekCredential({
      agentDir,
      env: { DEEPSEEK_API_KEY: "sk-test-from-env" },
    });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-from-env");
    expect(credential.source).toBe("DEEPSEEK_API_KEY");
  });

  test("a stored credential outranks the environment level", async () => {
    writeAuth({ deepseek: { type: "api_key", key: "sk-test-literal" } });

    const credential = await resolveDeepSeekCredential({
      agentDir,
      env: { DEEPSEEK_API_KEY: "sk-test-from-env" },
    });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-literal");
    expect(credential.source).toBe("stored credential");
  });

  test("the provider's own models.json configuration is the level below the stored credential", async () => {
    writeModels({ providers: { deepseek: { apiKey: "sk-test-models" } } });

    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(true);
    expect(credential.key).toBe("sk-test-models");
    expect(typeof credential.source).toBe("string");
  });

  test("an empty agent directory means the provider is not configured", async () => {
    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(false);
    expect(credential.key).toBeUndefined();
    expect(credential.source).toBeUndefined();
  });

  test("an agent directory with no auth.json at all means the provider is not configured", async () => {
    const credential = await resolveDeepSeekCredential({ agentDir });

    expect(credential.configured).toBe(false);
    expect(credential.key).toBeUndefined();
  });
});
