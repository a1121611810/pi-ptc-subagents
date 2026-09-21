/**
 * Shared helpers for the PTC test suites.
 *
 * Nothing here ends in `.test.ts`, so `scripts/test.mjs` never picks it up as a suite.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import ptcSubagents, { BUILTIN_BINDING_NAMES } from "../../src/index.ts";
import type { Binding, BindingTable } from "../../src/runtime/bindings.ts";

/** Timeout applied to tests that spawn real workers, so a deadlock fails instead of hanging. */
export const RUN_TIMEOUT_MS = 20_000;

/** Create a realpath-resolved temp directory (macOS `/var` → `/private/var` otherwise). */
export async function makeTempDir(prefix = "pi-ptc-test-"): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A binding whose `execute` is the supplied function. */
export function makeBinding(name: string, execute: Binding["execute"]): Binding {
  return { name, execute };
}

/**
 * Run the extension factory against a recording stub and return the tools it registered,
 * keyed by registered name. This is the registration path pi itself takes, so the definitions
 * under test are the ones the model would actually call.
 *
 * The stub reports every built-in as active, so integration tests exercise the full surface;
 * enablement-policy tests wire restricted `getActiveToolNames` getters into the factories
 * directly instead.
 */
export function captureRegisteredTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const stub = {
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => [...BUILTIN_BINDING_NAMES],
  } as unknown as ExtensionAPI;
  ptcSubagents(stub);
  return tools;
}

/**
 * Minimal execution context for tool tests.
 *
 * The tool layer reads exactly one field — `cwd` (see `src/tools/common.ts`) — but the real
 * parameter type is pi's `ExtensionContext`, so tests pass this narrowed object through a cast
 * rather than fabricating a whole session.
 */
export function toolContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/** Build a binding table; keys become the `tools.<name>` namespace in the worker. */
export function makeBindings(entries: Record<string, Binding["execute"]>): BindingTable {
  const table = new Map<string, Binding>();
  for (const [name, execute] of Object.entries(entries)) table.set(name, makeBinding(name, execute));
  return table;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
