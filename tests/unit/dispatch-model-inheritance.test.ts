/**
 * ADR-0044 (task-7): the dispatch child inherits the caller session's current model.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6). Every expected value points at an
 * in-repo source, never at the implementation:
 *   - the precedence is ADR-0044 Decision 1 (docs/adr/0044-a-dispatch-inherits-the-session-model.md):
 *     the call-site `model` > the agent definition's frontmatter `model:` > the caller session's
 *     current model > pi's configured default (no flag at all);
 *   - the `--model deepseek/deepseek-flash` spelling is Decision 1's `provider/id` form — the
 *     spelling pi's resolver and the two other model tiers already use;
 *   - the real captured pair minimax-cn-512k / MiniMax-M3.1-Flash-Preview is not hand-invented:
 *     it is the provider/model the live 429 capture carried
 *     (tests/fixtures/pi-1.3.0-429-token-plan.jsonl, driven by dispatch-diagnostics.test.ts; see
 *     Decision 2 for why an observed model is reported at all).
 *
 * The call sites are pinned separately on purpose. `buildArgv`'s fourth parameter is optional, so
 * "the dispatcher's foreground branch passes the session model", "the background branch passes
 * it", and "each programming tool reads `ctx.model` and hands it to the dispatcher" are three
 * independent wirings that one unit test of `buildArgv` cannot see — dropping one would leave the
 * others green.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createBuiltinBindings } from "../../src/runtime/bindings.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  isDispatchHandle,
  DispatchSlotCounter,
  buildArgv,
  dispatch,
  type AgentConfigLike,
  type DispatchContext,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import { runPtcProgram } from "../../src/runtime/dispatcher.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/limits.ts";
import type { SessionModel } from "../../src/runtime/session-model.ts";
import { createTaskRegistry } from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage, type TaskRecord, type ULID } from "../../src/runtime/task-storage.ts";
import { createPtcRunCodeTool } from "../../src/tools/run-code.ts";
import { createPtcSubagentTool } from "../../src/tools/subagent.ts";
import { createPtcWorkflowTool } from "../../src/tools/workflow.ts";
import {
  installRecordingPi,
  makeTempDir,
  removeTempDir,
  toolContext,
  waitFor,
} from "../helpers/ptc.ts";

const AGENT = "model-inherit-probe";
const AGENT_MD = "---\nname: model-inherit-probe\n---\nYou inherit the caller's model.\n";

/** The CONTRACT's session-model sample: provider "deepseek" / id "deepseek-flash". */
const DS_FLASH: SessionModel = { provider: "deepseek", id: "deepseek-flash" };
/** Its `--model` spelling; pi resolves `provider/id` off the first slash. */
const DS_FLASH_ARG = "deepseek/deepseek-flash";

/** The child's answer. `PONG` is this repo's child-answer literal (tests/helpers/ptc.ts). */
const PONG = "PONG";

/** An agent with no model of its own, so the session tier is the only one in play. */
const AGENT_WITHOUT_MODEL: AgentConfigLike = {
  name: AGENT,
  source: "project",
  systemPrompt: "You inherit the caller's model.",
};

/** An agent that names its own model, exercising the middle tier of the precedence. */
const AGENT_WITH_MODEL: AgentConfigLike = { ...AGENT_WITHOUT_MODEL, model: "agent/declared-model" };

/** One assistant turn as the JSONL child would emit it (no model observed). */
function assistantText(text: string): ParsedAgentEvent {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** The value of `--model`, or undefined when the flag itself is absent. */
function modelFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--model");
  return index === -1 ? undefined : argv[index + 1];
}

/** A temp cwd with a project-scope agent definition, cleaned up even when a test throws. */
async function withAgentDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), AGENT_MD, "utf-8");
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

/** Records every spawn request, so a test can assert what the child was launched with. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  /** The handle for spawn `index`, or a loud failure rather than an unchecked index. */
  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) throw new Error("RecordingLifecycle: no handle at " + String(index));
    return handle;
  }
}

/** A dispatch context for the run under test; `sessionModel` is the tier this file varies. */
function contextFor(dir: string, sessionModel?: SessionModel): DispatchContext {
  return {
    callId: 1,
    cwd: dir,
    depth: 0,
    maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
    ...(sessionModel === undefined ? {} : { sessionModel }),
  };
}

/** One foreground dispatch driven to a clean close; returns the argv the child was spawned with. */
async function driveForeground(
  dir: string,
  sessionModel?: SessionModel,
): Promise<{ result: DispatchResult; argv: readonly string[] }> {
  const lifecycle = new RecordingLifecycle();
  const settled = dispatch(
    { agent: AGENT, agentScope: "project", task: "name the model you inherited" },
    contextFor(dir, sessionModel),
    { lifecycle, slots: new DispatchSlotCounter(4) },
  );
  await waitFor(() => lifecycle.spawned.length > 0);
  const child = lifecycle.handleAt(0);
  lifecycle.pushEvent(child, assistantText(PONG));
  lifecycle.resolveExit(child, 0, null);
  const result = await settled;
  return { result, argv: lifecycle.getRecordedArgv(child) };
}

/** Wait until the detached background pump persists a terminal record. */
async function waitForTerminal(storage: InMemoryTaskStorage, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await storage.loadTask(taskId);
    if (record !== null && record.status !== "running" && record.status !== "stopping") {
      return record;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

/**
 * One background dispatch driven to a clean close. `settle` must be called (or the detached
 * pump keeps running after the assertion), so the test owns both halves explicitly.
 */
async function driveBackground(
  dir: string,
  sessionModel?: SessionModel,
): Promise<{ argv: readonly string[]; settle: () => Promise<TaskRecord> }> {
  const storage = new InMemoryTaskStorage();
  const clock = (): number => 1000;
  const lifecycle = new RecordingLifecycle();
  const deps: DispatchDeps = {
    taskRegistry: createTaskRegistry(storage, { clock }),
    lifecycle,
    slots: new DispatchSlotCounter(4),
    clock,
  };
  const outcome = await dispatch(
    { agent: AGENT, agentScope: "project", task: "name the model you inherited", background: true },
    contextFor(dir, sessionModel),
    deps,
  );
  if (!isDispatchHandle(outcome)) throw new Error("the background fixture was refused");
  await waitFor(() => lifecycle.spawned.length > 0);
  const child = lifecycle.handleAt(0);
  const argv = lifecycle.getRecordedArgv(child);
  return {
    argv,
    settle: async () => {
      lifecycle.pushEvent(child, assistantText(PONG));
      lifecycle.resolveExit(child, 0, null);
      return await waitForTerminal(storage, outcome.taskId);
    },
  };
}

describe("buildArgv model precedence (CONTRACT P2)", () => {
  test("the call site's model wins over both the agent's and the session's", () => {
    const argv = buildArgv(
      { agent: AGENT, task: "t", model: "call-site/model" },
      AGENT_WITH_MODEL,
      "/tmp/p.md",
      DS_FLASH,
    );
    expect(modelFlag(argv)).toBe("call-site/model");
  });

  test("the agent's declared model wins over the session's", () => {
    const argv = buildArgv({ agent: AGENT, task: "t" }, AGENT_WITH_MODEL, "/tmp/p.md", DS_FLASH);
    expect(modelFlag(argv)).toBe("agent/declared-model");
  });

  test("the session model is used when neither the call site nor the agent names one", () => {
    const argv = buildArgv({ agent: AGENT, task: "t" }, AGENT_WITHOUT_MODEL, "/tmp/p.md", DS_FLASH);
    expect(modelFlag(argv)).toBe(DS_FLASH_ARG);
    // The flag and its value are ADJACENT argv elements, not a single "--model=..." token: the
    // child's parser is given two arguments.
    const index = argv.indexOf("--model");
    expect(argv.slice(index, index + 2)).toEqual(["--model", "deepseek/deepseek-flash"]);
  });

  test("no model anywhere means no --model flag, which is the pre-ADR-0044 argv", () => {
    const argv = buildArgv({ agent: AGENT, task: "t" }, AGENT_WITHOUT_MODEL, "/tmp/p.md");
    expect(argv).not.toContain("--model");
    // The three-argument call is the existing call shape; an explicit undefined fourth argument
    // must be identical to omitting it, or the optional parameter is not actually optional.
    expect(
      buildArgv({ agent: AGENT, task: "t" }, AGENT_WITHOUT_MODEL, "/tmp/p.md", undefined),
    ).toEqual(argv);
  });
});

describe("the foreground call site passes the session model", () => {
  test("a foreground child is spawned with --model provider/id from ctx.sessionModel", async () => {
    await withAgentDir(async (dir) => {
      const { result, argv } = await driveForeground(dir, DS_FLASH);
      expect(result.status, "the child still answered, so the dispatch succeeded").toBe(
        "fulfilled",
      );
      expect(result.text).toBe(PONG);
      expect(modelFlag(argv)).toBe(DS_FLASH_ARG);
    });
  });

  test("without a session model the foreground argv carries no --model", async () => {
    await withAgentDir(async (dir) => {
      const { result, argv } = await driveForeground(dir);
      expect(result.status).toBe("fulfilled");
      expect(modelFlag(argv)).toBeUndefined();
    });
  });
});

describe("the background call site passes the session model", () => {
  test("a background child is spawned with --model provider/id from ctx.sessionModel", async () => {
    await withAgentDir(async (dir) => {
      const { argv, settle } = await driveBackground(dir, DS_FLASH);
      expect(modelFlag(argv)).toBe(DS_FLASH_ARG);
      expect((await settle()).status).toBe("succeeded");
    });
  });

  test("without a session model the background argv carries no --model", async () => {
    await withAgentDir(async (dir) => {
      const { argv, settle } = await driveBackground(dir);
      expect(modelFlag(argv)).toBeUndefined();
      expect((await settle()).status).toBe("succeeded");
    });
  });
});

describe("ptc_subagent reads ctx.model and forwards it (installRecordingPi)", () => {
  /**
   * The real front, the real spawn: `ptc_subagent` calls the production foreground
   * `dispatch()`, which spawns the `pi` on PATH. `installRecordingPi` is therefore the only
   * observation seam that sees the argv this tool actually produced — a mock lifecycle would
   * test the dispatcher, not the tool's ctx read.
   */
  test("a tool call whose ctx carries a model spawns pi with --model deepseek/deepseek-flash", async () => {
    const pi = await installRecordingPi();
    try {
      await withAgentDir(async (dir) => {
        const tool = createPtcSubagentTool({
          cwd: dir,
          depth: 0,
          maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        });
        const result = (await tool.execute(
          "call-inherit",
          { agent: AGENT, agentScope: "project", task: "reply with PONG" },
          undefined,
          undefined,
          toolContext(dir, DS_FLASH),
        )) as { content: { type: string; text: string }[] };
        const text = result.content.map((part) => part.text).join("\n");
        expect(text, "the real child answered, so the dispatch ran").toContain(PONG);
        const spawns = await pi.settle();
        expect(spawns, "exactly one child was launched").toHaveLength(1);
        expect(modelFlag(spawns[0] ?? [])).toBe(DS_FLASH_ARG);
      });
    } finally {
      await pi.restore();
    }
  }, 30_000);

  test("a tool call whose ctx has no model leaves the argv unchanged", async () => {
    // The counterfactual for the test above: the same tool, the same call, only the context's
    // model removed. If `ptc_subagent` synthesised a model from anywhere else, this would fail.
    const pi = await installRecordingPi();
    try {
      await withAgentDir(async (dir) => {
        const tool = createPtcSubagentTool({
          cwd: dir,
          depth: 0,
          maxDispatchDepth: DEFAULT_CONFIG.maxDispatchDepth,
        });
        await tool.execute(
          "call-no-inherit",
          { agent: AGENT, agentScope: "project", task: "reply with PONG" },
          undefined,
          undefined,
          toolContext(dir),
        );
        const spawns = await pi.settle();
        expect(spawns).toHaveLength(1);
        expect(modelFlag(spawns[0] ?? [])).toBeUndefined();
      });
    } finally {
      await pi.restore();
    }
  }, 30_000);
});

describe("runPtcProgram threads sessionModel to the pi.dispatch binding", () => {
  /** One program whose only act is a foreground dispatch; the child is the recording pi. */
  async function runDispatchProgram(
    dir: string,
    sessionModel?: SessionModel,
  ): Promise<readonly (readonly string[])[]> {
    const pi = await installRecordingPi();
    try {
      const outcome = await runPtcProgram({
        code:
          "return await tools['pi.dispatch']({ agent: '" +
          AGENT +
          "', agentScope: 'project', task: 'reply with PONG' });",
        surface: "run_code",
        cwd: dir,
        bindings: createBuiltinBindings({ cwd: dir, includeDispatch: true }),
        ...(sessionModel === undefined ? {} : { sessionModel }),
      });
      expect(
        outcome.error,
        "the program completed and the dispatch binding answered",
      ).toBeUndefined();
      return await pi.settle();
    } finally {
      await pi.restore();
    }
  }

  test("the program's dispatch inherits the run's session model into the child argv", async () => {
    await withAgentDir(async (dir) => {
      const spawns = await runDispatchProgram(dir, DS_FLASH);
      expect(spawns).toHaveLength(1);
      expect(modelFlag(spawns[0] ?? [])).toBe(DS_FLASH_ARG);
    });
  }, 60_000);

  test("a run without a session model spawns the same argv as before ADR-0044", async () => {
    await withAgentDir(async (dir) => {
      const spawns = await runDispatchProgram(dir);
      expect(spawns).toHaveLength(1);
      expect(modelFlag(spawns[0] ?? [])).toBeUndefined();
    });
  }, 60_000);
});
describe("the two programming tools read ctx.model and forward it to the dispatcher", () => {
  /** Run one tool call against the recording `pi` on PATH; return the argv every child got. */
  async function spawnsThroughTool(
    execute: () => Promise<unknown>,
  ): Promise<readonly (readonly string[])[]> {
    const pi = await installRecordingPi();
    try {
      await execute();
      return await pi.settle();
    } finally {
      await pi.restore();
    }
  }

  /**
   * `ptc_run_code`'s execute reads `ctx.model` (run-code.ts's `readContextModel(ctx)`) and threads
   * it into `runPtcProgram`. Delete that read and the child spawns without `--model` while every
   * other test in this file stays green — the tool takes its own wiring path to the same
   * dispatcher, so the dispatcher's two call sites cannot see it.
   */
  test("ptc_run_code inherits the session model into the dispatched child's argv", async () => {
    await withAgentDir(async (dir) => {
      const tool = createPtcRunCodeTool();
      const spawns = await spawnsThroughTool(async () => {
        await tool.execute(
          "call-run-code-inherit",
          {
            description: "one dispatch",
            code:
              "return await tools['pi.dispatch']({ agent: '" +
              AGENT +
              "', agentScope: 'project', task: 'reply with PONG' });",
          },
          undefined,
          undefined,
          toolContext(dir, DS_FLASH),
        );
      });
      expect(spawns, "the program's dispatch reached a child").toHaveLength(1);
      expect(modelFlag(spawns[0] ?? [])).toBe(DS_FLASH_ARG);
    });
  }, 60_000);

  test("ptc_workflow inherits the session model into the dispatched child's argv", async () => {
    await withAgentDir(async (dir) => {
      const tool = createPtcWorkflowTool();
      const spawns = await spawnsThroughTool(async () => {
        await tool.execute(
          "call-workflow-inherit",
          {
            meta: { name: "inherit-model", description: "one dispatch" },
            script:
              "return await tools['pi.dispatch']({ agent: '" +
              AGENT +
              "', agentScope: 'project', task: 'reply with PONG' });",
          },
          undefined,
          undefined,
          toolContext(dir, DS_FLASH),
        );
      });
      expect(spawns, "the workflow's dispatch reached a child").toHaveLength(1);
      expect(modelFlag(spawns[0] ?? [])).toBe(DS_FLASH_ARG);
    });
  }, 60_000);
});

describe("the sources these new suites cite are committed and in-repo", () => {
  /**
   * Review R1 (oracle headers): a suite header is part of its evidence chain, so a citation into
   * a gitignored scratch file (`.scratch/`) or an ephemeral `/tmp` capture is not a source a
   * later reader can verify — the file is gone or never committed. ADR-0044 and the committed
   * fixture are. The scan is HEADER-only: later in this file `/tmp/p.md` is a buildArgv argument,
   * not a provenance claim.
   */
  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const NEW_SUITE_FILES = [
    "session-model.test.ts",
    "dispatch-model-inheritance.test.ts",
    "dispatch-diagnostics.test.ts",
  ] as const;
  const CITED_IN_REPO_SOURCES = [
    "docs/adr/0044-a-dispatch-inherits-the-session-model.md",
    "tests/fixtures/pi-1.3.0-429-token-plan.jsonl",
  ] as const;

  /** The leading TSDoc block: everything before the first `import`. */
  function headerOf(fileName: string): string {
    const text = readFileSync(join(REPO_ROOT, "tests/unit", fileName), "utf8");
    const firstImport = text.indexOf("\nimport ");
    return firstImport === -1 ? text : text.slice(0, firstImport);
  }

  test("no new suite header cites a scratch or temp path, and every cited source exists", () => {
    for (const fileName of NEW_SUITE_FILES) {
      const header = headerOf(fileName);
      expect(header, fileName + " must not cite the gitignored .scratch/ dir").not.toContain(
        ".scratch/",
      );
      expect(header, fileName + " must not cite an ephemeral /tmp path").not.toContain("/tmp/");
    }
    for (const source of CITED_IN_REPO_SOURCES) {
      expect(existsSync(join(REPO_ROOT, source)), source + " is a committed in-repo source").toBe(
        true,
      );
    }
  });
});
