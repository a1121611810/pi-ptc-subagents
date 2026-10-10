// PROTOTYPE — throwaway, lives on branch `prototype/f2-live-registry-probe`, never on main.
//
// THE QUESTION (option F2): could surface detection stop mirroring pi's settings and
// just ASK pi, at `session_start`, instead of parsing `--tools` / `defaultTools` off disk?
//
// That question is only answerable if four things are true. Each is a separate gate, and
// each one failing is enough to kill F2:
//
//   G1  `pi.getActiveTools()` / `pi.getSettings()` exist on ExtensionAPI and are USABLE at
//       `session_start` (they are `notInitialized` stubs during the factory).
//   G2  Their values already have pi's project-trust filtering applied — a project
//       `defaultTools` pi declined to read is ABSENT from `getSettings()`, not merely
//       reported as untrusted.
//   G3  `pi.registerTool()` is legal from an event handler, and a tool registered there
//       lands in the registry, joins the active set, and reaches the model payload.
//   G4  `exposure: "codemode"` is resolved against the LIVE registry at refresh time. If
//       exposure were snapshotted at load time, a tool registered after load would be
//       declared to the model even though `codemode` is not running — which is the exact
//       "two orchestrators" defect ADR-0025 §3 exists to prevent.
//
// G4 is the one that decides it, and it is the one a stubbed `pi` object cannot answer.
//
// Every gate is reported as OBSERVED / UNSUPPORTED / THREW, with the raw value, so a
// version that fails is distinguishable from a version the probe failed to exercise.

const out = (o) => console.error("[F2PROBE] " + JSON.stringify(o));
const V = process.env.F2_PROBE_VERSION ?? "unknown";

/** Run a probe, never letting a throw abort the report. */
function attempt(label, fn) {
  try {
    const value = fn();
    return { gate: label, state: "OBSERVED", value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      gate: label,
      // pi's own stub is a legitimate answer to "is this usable yet?", not a crash.
      state: /not initialized/i.test(msg) ? "UNUSABLE_AT_THIS_MOMENT" : "THREW",
      value: msg.slice(0, 160),
    };
  }
}

export default function f2probe(pi) {
  const factory = {
    version: V,
    phase: "factory",
    hasGetActiveTools: typeof pi.getActiveTools === "function",
    hasGetSettings: typeof pi.getSettings === "function",
    hasGetAllTools: typeof pi.getAllTools === "function",
    // G1 precondition: these exist but must not be usable yet. If they ARE usable here,
    // the whole premise of "we cannot ask at factory time" is wrong and F2's framing is wrong.
    activeToolsUsable: attempt("activeTools@factory", () => pi.getActiveTools()).state,
    settingsUsable: attempt("settings@factory", () => pi.getSettings()).state,
  };
  out(factory);

  pi.registerTool({
    name: "f2_factory_tool",
    description: "Registered during the extension factory.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "factory" }], details: null }),
  });

  // CONTROL for G4. Without this, a version that declares `f2_session_codemode` is
  // ambiguous: it could mean late registration broke exposure resolution, OR that this
  // pi predates the `codemode` exposure value entirely. This one is registered the way
  // production registers it, so any difference between the two is attributable to WHEN.
  pi.registerTool({
    name: "f2_factory_codemode",
    description: "Registered during the factory at codemode exposure (the production shape).",
    exposure: "codemode",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "fc" }], details: null }),
  });

  pi.on("session_start", async (_event, ctx) => {
    // G1 — usable now?
    const activeAtStart = attempt("activeTools@session_start", () => pi.getActiveTools());
    const settingsAtStart = attempt("settings@session_start", () => pi.getSettings());

    // G2 — is the settings object already trust-filtered? Report the raw key either way
    // so the runner can diff trusted against untrusted without parsing prose.
    const dt =
      settingsAtStart.state === "OBSERVED" && settingsAtStart.value
        ? (settingsAtStart.value.defaultTools ?? null)
        : null;
    const trustFn = typeof ctx.isProjectTrusted === "function";
    const trusted = trustFn ? attempt("isProjectTrusted", () => ctx.isProjectTrusted()) : null;

    // G3 — register from the handler.
    const activeBefore = activeAtStart.state === "OBSERVED" ? [...activeAtStart.value] : [];
    const regCodemode = attempt("registerCodemodeExposure", () => {
      pi.registerTool({
        name: "f2_session_direct",
        description: "Late-registered, direct exposure.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "d" }], details: null }),
      });
      pi.registerTool({
        name: "f2_session_codemode",
        description: "Late-registered at codemode exposure.",
        exposure: "codemode",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "c" }], details: null }),
      });
      return "ok";
    });
    const allAfter = attempt("getAllTools@session_start", () =>
      pi.getAllTools().map((t) => t.name),
    );
    const activeAfter = attempt("getActiveTools@afterRegister", () => pi.getActiveTools());

    out({
      version: V,
      phase: "session_start",
      // G1 — only the keys this question needs. Dumping the whole settings object would
      // print the operator's real pi configuration into the log.
      activeTools: activeAtStart,
      settingsUsable: settingsAtStart.state,
      settingsKeys: settingsAtStart.state === "OBSERVED" ? Object.keys(settingsAtStart.value) : null,
      // G2
      settingsDefaultTools: dt,
      hasIsProjectTrusted: trustFn,
      isProjectTrusted: trusted,
      codemodeInActiveSet:
        activeAfter.state === "OBSERVED" ? activeAfter.value.includes("codemode") : null,
      // G3
      register: regCodemode,
      registryHasFactoryTool:
        allAfter.state === "OBSERVED" ? allAfter.value.includes("f2_factory_tool") : null,
      registryHasSessionDirect:
        allAfter.state === "OBSERVED" ? allAfter.value.includes("f2_session_direct") : null,
      registryHasSessionCodemode:
        allAfter.state === "OBSERVED" ? allAfter.value.includes("f2_session_codemode") : null,
      activeHasSessionDirect:
        activeAfter.state === "OBSERVED" ? activeAfter.value.includes("f2_session_direct") : null,
      activeHasSessionCodemode:
        activeAfter.state === "OBSERVED" ? activeAfter.value.includes("f2_session_codemode") : null,
      nonProbeActiveSetUnchanged:
        activeAfter.state === "OBSERVED" &&
        activeBefore.filter((n) => !n.startsWith("f2_")).join(",") ===
          activeAfter.value.filter((n) => !n.startsWith("f2_")).join(","),
    });

    // ORDERING PROBE. pi's own MCP extension activates codemode from inside ITS
    // session_start handler (mcp/index.js:840 calls ensureDiscoveryActive, which calls
    // setActiveTools at :378). Extension order is not ours to choose, so the question is
    // whether reading one tick later sees an activation the synchronous read missed.
    const readAt = (label, fn) => {
      const a = attempt(label, fn);
      out({ version: V, phase: "ordering", label, codemodeActive: a.state === "OBSERVED" ? a.value.includes("codemode") : null });
    };
    readAt("sync", () => pi.getActiveTools());
    setImmediate(() => readAt("setImmediate", () => pi.getActiveTools()));
    setTimeout(() => readAt("setTimeout0", () => pi.getActiveTools()), 0);
    setTimeout(() => readAt("after250ms", () => pi.getActiveTools()), 250);

    // G4 — the decisive gate. Read the ACTUAL provider payload rather than inferring it.
    pi.on("before_provider_request", (ev) => {
      const names = (ev?.payload?.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? "?");
      out({
        version: V,
        phase: "payload",
        codemodeActive:
          activeAfter.state === "OBSERVED" ? activeAfter.value.includes("codemode") : null,
        payloadToolCount: names.length,
        // G4: a codemode-exposure tool must NOT be declared when codemode is not active.
        declaredSessionCodemode: names.includes("f2_session_codemode"),
        declaredFactoryCodemode: names.includes("f2_factory_codemode"),
        declaredSessionDirect: names.includes("f2_session_direct"),
        declaredFactoryTool: names.includes("f2_factory_tool"),
        declaredCodemode: names.includes("codemode"),
      });
    });
  });
}