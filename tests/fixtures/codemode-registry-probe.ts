/**
 * Test fixture: reports what **pi's own tool registry** holds, read from inside a live session.
 *
 * `src/mode/ptc-mode.ts` cannot ask this question. ADR-0026 records why: `getAllTools()` is a
 * `notInitialized` stub until `bindCore` runs, a factory that calls it throws, and a throwing
 * factory makes the extension fail to load entirely. So the package answers "does this pi ship
 * codemode" with a filesystem probe over `process.argv[1]`, and `tests/tool-visibility.test.ts`
 * is the only place that probe meets a real pi.
 *
 * A probe checked only against itself is worth nothing. Comparing our "detected" run against our
 * "explicit full" run says the two agree -- and a probe that never finds codemode makes them
 * agree for the wrong reason, so the comparison passed while the probe was dead. This fixture is
 * the independent side: it reads **pi's** registry, in a run of pi's own choosing, so the two
 * answers being compared come from different state and can actually disagree.
 *
 * `getAllTools()`, not `getActiveTools()`: `codemode` registers with `defaultActive: false`
 * (ADR-0026 decision 6), so it is absent from the active set on a pi that ships it in full. The
 * question here is presence, not callability.
 *
 * ## Why the record has two stages
 *
 * `pi -e builtin:codemode` is how a test gets pi to register the tool without opening extension
 * discovery, and pi treats an unknown built-in as **fatal**: it exits before any provider request
 * and before `session_start`. A test therefore cannot tell "this pi has no codemode" from "the
 * harness is broken" by looking at a missing result alone. The factory writes the file first, so
 * a file that still says `factory` is a measurement -- this pi refused `builtin:codemode`, and
 * the caller knows why there is no answer rather than having to guess.
 *
 * Not a `.test.ts` file, so the test runner never collects it as a suite.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * What the probe managed to observe, and how far it got.
 *
 * `factory` is written from the extension body, where `getAllTools()` still throws. Everything
 * a caller needs from pi's registry is only in the `session_start` variant.
 */
export type RegistryRecord =
  | { stage: "factory"; argv: string[] }
  | { stage: "session_start"; argv: string[]; hasCodemode: boolean; tools: string[] };

export default function codemodeRegistryProbe(pi: ExtensionAPI): void {
  const out = process.env.PTC_REGISTRY_OUT;
  if (out === undefined) return;
  // Written first, overwritten below. See "Why the record has two stages".
  writeFileSync(out, JSON.stringify({ stage: "factory", argv: [...process.argv] }), "utf8");

  pi.on("session_start", () => {
    // **Deferred one turn of the event loop, and that is load-bearing.** This package registers its
    // tools from its own `session_start` handler (ADR-0035 moved registration there so the surface
    // could be read rather than reconstructed). pi dispatches `session_start` per extension in
    // load order, and that order is not ours to choose — so a synchronous read here sees whatever
    // had been registered when this handler happened to run, which is the difference between
    // "the package registered nothing" and "the package registered after me". Neither is the
    // answer this fixture exists to give.
    //
    // `setImmediate` runs after the synchronous dispatch completes, so every `session_start`
    // handler has returned and the registry is settled. The print session this runs in makes a
    // provider request afterwards, so the loop does turn.
    setImmediate(() => {
      const tools = pi.getAllTools().map((tool) => tool.name);
      const record: RegistryRecord = {
        stage: "session_start",
        argv: [...process.argv],
        hasCodemode: tools.includes("codemode"),
        tools,
      };
      writeFileSync(out, JSON.stringify(record), "utf8");
    });
  });
}
