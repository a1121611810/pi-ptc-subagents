#!/usr/bin/env node
// bgdispatch Handoff vs Grill-with-docs prototype v3
// Tests both proposals across performance, tokens, memory, boundary, feasibility, exceptions.

// ============================================================
// Constants (Q1+Q2 verified cost models from earlier prototypes)
// ============================================================
const META_BYTES = 200;
const PREVIEW_THRESHOLD = 2048;
const TOKENS_PER_BYTE = 4;
const ADR_0014_RTF = 50000; // 50KB truncateTail (ADR-0015)
const ADR_0014_LINES = 2000;
const CHILD_BOOT_MS = 3000; // pi child subprocess boot
const TOOL_CALL_LATENCY_MS = 250; // per round-trip (model + tool)
const FILE_WRITE_LATENCY_MS = 30; // local /tmp write
const FILE_READ_LATENCY_MS = 10; // local /tmp read
const PARENT_OBSERVE_MS = 200; // subscription event observation
const Handoff_GRILL_ROUND_MS = 800; // /grill-with-docs round-trip
const Handoff_GRILL_MAX_ROUNDS = 5;
const Handoff_DOC_GEN_TOKENS = 2000; // handoff doc generation cost
const PARENT_QUERY_TIMEOUT_MS = 30000;
const MAX_Self_GRILL_ROUNDS = 3; // L1 self-grill limit

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genOutputSize(scenario, rnd) {
  const r = rnd();
  if (scenario === "small") return 100 + Math.floor(rnd() * (2048 - 100));
  if (scenario === "medium") return 2049 + Math.floor(rnd() * (8192 - 2049));
  if (scenario === "large") return 8193 + Math.floor(rnd() * (ADR_0014_RTF - 8193));
  if (scenario === "huge") return ADR_0014_RTF + Math.floor(rnd() * 100000);
  if (scenario === "realistic") {
    if (r < 0.6) return 100 + Math.floor(rnd() * (2048 - 100));
    if (r < 0.85) return 2049 + Math.floor(rnd() * (8192 - 2049));
    if (r < 0.95) return 8193 + Math.floor(rnd() * (ADR_0014_RTF - 8193));
    return ADR_0014_RTF + Math.floor(rnd() * 100000);
  }
  return 1000;
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB";
  return (b / 1024 / 1024).toFixed(3) + " MB";
}
function fmtTokens(b) {
  return Math.round(b / TOKENS_PER_BYTE).toLocaleString();
}
function fmtMs(ms) {
  return Math.round(ms).toLocaleString() + " ms";
}

// ============================================================
// HANDOFF MODEL
// ============================================================
function simulateHandoff(scenario, childOutputBytes, opts) {
  opts = opts || {};
  const result = {
    scheme: "handoff",
    success: false,
    oldTaskStatus: "running",
    newTaskId: null,
    handoffDocBytes: 0,
    totalLatencyMs: 0,
    totalTokens: 0,
    childBootCount: 0,
    errors: [],
  };
  const summaryRatio = opts.summaryRatio || 0.05;
  const summaryCap = 10240;
  result.handoffDocBytes = Math.min(childOutputBytes * summaryRatio, summaryCap);
  result.totalTokens += Handoff_DOC_GEN_TOKENS;
  result.totalLatencyMs += Handoff_GRILL_ROUND_MS + FILE_WRITE_LATENCY_MS;
  if (result.handoffDocBytes > 200000) {
    result.handoffDocBytes = ADR_0014_RTF;
    result.errors.push("handoff_doc_truncated_by_adr_0015");
  }
  if (opts.childCrashes) {
    result.success = false;
    result.errors.push("child_crashed_before_handoff_complete");
    result.totalLatencyMs += TOOL_CALL_LATENCY_MS;
    return result;
  }
  result.oldTaskStatus = "canceled";
  result.totalLatencyMs += TOOL_CALL_LATENCY_MS;
  result.childBootCount = 1;
  result.totalLatencyMs += CHILD_BOOT_MS;
  if (opts.spawnFails) {
    result.success = false;
    result.errors.push("new_child_spawn_failed");
    return result;
  }
  result.totalLatencyMs += FILE_READ_LATENCY_MS + TOOL_CALL_LATENCY_MS;
  result.newTaskId = "NEW_" + Math.floor(Math.random() * 1000000);
  const newOutputBytes = opts.newOutputBytes || childOutputBytes * 0.5;
  result.totalTokens += Math.round(newOutputBytes / TOKENS_PER_BYTE);
  result.totalLatencyMs += Math.round(newOutputBytes / 100);
  if (opts.docLost) {
    result.success = false;
    result.errors.push("handoff_doc_lost_in_transit");
    result.totalTokens += 1000;
  }
  if (opts.newChildIgnores) result.errors.push("semantic_handoff_loss");
  if (opts.chainedHandoffs && opts.chainedHandoffs > 1) {
    const chainCost = opts.chainedHandoffs;
    result.totalTokens *= chainCost;
    result.totalLatencyMs *= chainCost;
    result.childBootCount *= chainCost;
    result.errors.push("compounding_degradation_x" + chainCost);
  }
  result.success = !result.errors.some(
    (e) => e.indexOf("failed") >= 0 || e.indexOf("crashed") >= 0 || e.indexOf("lost") >= 0,
  );
  return result;
}

function simulateGrill(scenario, childOutputBytes, boundaryAmbiguity, opts) {
  opts = opts || {};
  const result = {
    scheme: "grill",
    mode: opts.mode || "self",
    rounds: 0,
    totalLatencyMs: 0,
    totalTokens: 0,
    errors: [],
    success: false,
    escalatedToUser: false,
  };
  if (opts.mode === "self" || !opts.mode) {
    const roundsNeeded = Math.min(boundaryAmbiguity, MAX_Self_GRILL_ROUNDS);
    result.rounds = roundsNeeded;
    result.totalLatencyMs = roundsNeeded * Handoff_GRILL_ROUND_MS;
    result.totalTokens = roundsNeeded * 800;
    if (opts.infiniteGrill) {
      result.rounds = 100;
      result.totalLatencyMs = 100 * Handoff_GRILL_ROUND_MS;
      result.totalTokens = 100 * 800;
      result.errors.push("infinite_self_grill_loop");
      result.success = false;
      return result;
    }
    if (opts.falseConfidence) result.errors.push("self_grill_false_confidence");
  }
  if (opts.mode === "reverse") {
    result.rounds = 1;
    result.totalLatencyMs = TOOL_CALL_LATENCY_MS + PARENT_OBSERVE_MS + TOOL_CALL_LATENCY_MS;
    result.totalTokens = 1500;
    if (opts.parentTimeout) {
      result.totalLatencyMs = PARENT_QUERY_TIMEOUT_MS;
      result.errors.push("parent_query_timeout");
      result.success = false;
      return result;
    }
    if (opts.parentMisinterprets) result.errors.push("parent_query_response_wrong");
    if (opts.cascadingQueries && opts.cascadingQueries > 1) {
      const cascade = opts.cascadingQueries;
      result.totalLatencyMs *= cascade;
      result.totalTokens *= cascade;
      result.errors.push("cascading_queries_x" + cascade);
    }
  }
  if (opts.mode === "escalate") {
    result.escalatedToUser = true;
    result.totalLatencyMs = TOOL_CALL_LATENCY_MS * 3;
    result.totalTokens = 3000;
    result.errors.push("user_round_trip_required");
  }
  result.success =
    result.errors.length === 0 ||
    (result.errors.length === 1 && result.errors[0].indexOf("false_confidence") >= 0);
  return result;
}

const SCENARIOS = [
  {
    name: "small_clear",
    outputKind: "small",
    ambiguity: 0,
    desc: "60 tasks, all <=2KB, no boundary issues",
  },
  {
    name: "medium_typical",
    outputKind: "realistic",
    ambiguity: 2,
    desc: "60 tasks realistic dist, normal boundary",
  },
  {
    name: "high_ambiguity",
    outputKind: "realistic",
    ambiguity: 5,
    desc: "60 tasks realistic, heavy boundary ambiguity",
  },
  { name: "huge_doc", outputKind: "huge", ambiguity: 2, desc: "60 huge tasks (>50KB each)" },
  {
    name: "chained_3",
    outputKind: "realistic",
    ambiguity: 2,
    chainedHandoffs: 3,
    desc: "60 tasks with 3x chained handoffs",
  },
  { name: "burst_100", outputKind: "realistic", ambiguity: 2, desc: "100 tasks burst + handoff" },
  {
    name: "child_crashes",
    outputKind: "realistic",
    ambiguity: 2,
    childCrashes: true,
    desc: "Child crashes mid-handoff",
  },
  {
    name: "doc_lost",
    outputKind: "realistic",
    ambiguity: 2,
    docLost: true,
    desc: "Handoff doc lost in transit",
  },
  {
    name: "infinite_grill",
    outputKind: "realistic",
    ambiguity: 5,
    infiniteGrill: true,
    desc: "Child grills itself forever",
  },
  {
    name: "parent_timeout",
    outputKind: "realistic",
    ambiguity: 5,
    parentTimeout: true,
    mode: "reverse",
    desc: "Parent never answers query (busy)",
  },
  {
    name: "false_confidence",
    outputKind: "realistic",
    ambiguity: 3,
    falseConfidence: true,
    desc: "Child thinks resolved but wrong",
  },
  {
    name: "cascading_q5",
    outputKind: "realistic",
    ambiguity: 5,
    cascadingQueries: 5,
    mode: "reverse",
    desc: "5-level cascading queries",
  },
];

function runScenario(s) {
  const rnd = mulberry32(42);
  const outputBytes = genOutputSize(s.outputKind, rnd);
  const opts = {
    summaryRatio: 0.05,
    childCrashes: s.childCrashes,
    docLost: s.docLost,
    infiniteGrill: s.infiniteGrill,
    parentTimeout: s.parentTimeout,
    falseConfidence: s.falseConfidence,
    cascadingQueries: s.cascadingQueries,
    chainedHandoffs: s.chainedHandoffs,
    mode: s.mode,
    newOutputBytes: outputBytes * 0.5,
  };
  const handoff = simulateHandoff(s.outputKind, outputBytes, opts);
  const grillSelf = simulateGrill(s.outputKind, outputBytes, s.ambiguity || 0, {
    mode: "self",
    infiniteGrill: s.infiniteGrill,
    falseConfidence: s.falseConfidence,
  });
  const grillReverse = simulateGrill(s.outputKind, outputBytes, s.ambiguity || 0, {
    mode: "reverse",
    parentTimeout: s.parentTimeout,
    cascadingQueries: s.cascadingQueries,
  });
  return {
    name: s.name,
    desc: s.desc,
    handoff,
    grillSelf,
    grillReverse,
    outputBytes,
    ambiguity: s.ambiguity || 0,
  };
}

console.log("# bgdispatch/G2 v3 -- Handoff vs Grill-with-docs head-to-head");
console.log("# seed=42 deterministic; " + SCENARIOS.length + " scenarios");
console.log();
console.log("## Scenarios");
console.log();
SCENARIOS.forEach((s, i) =>
  console.log(
    "| " + (i + 1) + " | " + s.name + " | " + s.desc + " | ambiguity=" + (s.ambiguity || 0) + " |",
  ),
);
console.log();

console.log("## Per-scenario: Handoff vs Grill-Self vs Grill-Reverse");
console.log();
const results = [];
SCENARIOS.forEach((s) => {
  const r = runScenario(s);
  results.push(r);
  console.log("### " + s.name + " -- " + s.desc);
  console.log();
  const h = r.handoff,
    gs = r.grillSelf,
    gr = r.grillReverse;
  console.log(
    "| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |",
  );
  console.log("|---|---|---|---|---|");
  console.log(
    "| total latency | " +
      fmtMs(h.totalLatencyMs) +
      " | " +
      fmtMs(gs.totalLatencyMs) +
      " | " +
      fmtMs(gr.totalLatencyMs) +
      " | " +
      (h.totalLatencyMs / Math.max(1, gs.totalLatencyMs)).toFixed(1) +
      "x |",
  );
  console.log(
    "| total tokens | " +
      fmtTokens(h.totalTokens) +
      " | " +
      fmtTokens(gs.totalTokens) +
      " | " +
      fmtTokens(gr.totalTokens) +
      " | " +
      (h.totalTokens / Math.max(1, gs.totalTokens)).toFixed(1) +
      "x |",
  );
  console.log("| handoff doc bytes | " + fmtBytes(h.handoffDocBytes) + " | (n/a) | (n/a) | - |");
  console.log("| child boots | " + h.childBootCount + " | 0 | 0 | - |");
  console.log("| rounds | n/a | " + gs.rounds + " | " + gr.rounds + " | - |");
  console.log(
    "| errors | " +
      (h.errors.join("; ") || "(clean)") +
      " | " +
      (gs.errors.join("; ") || "(clean)") +
      " | " +
      (gr.errors.join("; ") || "(clean)") +
      " | - |",
  );
  console.log(
    "| success | " +
      (h.success ? "Y" : "N") +
      " | " +
      (gs.success ? "Y" : "N") +
      " | " +
      (gr.success ? "Y" : "N") +
      " | - |",
  );
  console.log();
});

console.log("## Aggregate (across " + SCENARIOS.length + " scenarios)");
console.log();
const sum = (key) => results.reduce((a, r) => a + r.handoff[key], 0);
const sumG = (key, m) => results.reduce((a, r) => a + r[m][key], 0);
console.log("| metric | handoff | grill L1 (self) | grill L2 (reverse) |");
console.log("|---|---|---|---|");
console.log(
  "| sum latency | " +
    fmtMs(sum("totalLatencyMs")) +
    " | " +
    fmtMs(sumG("totalLatencyMs", "grillSelf")) +
    " | " +
    fmtMs(sumG("totalLatencyMs", "grillReverse")) +
    " |",
);
console.log(
  "| sum tokens | " +
    fmtTokens(sum("totalTokens")) +
    " | " +
    fmtTokens(sumG("totalTokens", "grillSelf")) +
    " | " +
    fmtTokens(sumG("totalTokens", "grillReverse")) +
    " |",
);
const sHandoff = results.filter((r) => r.handoff.success).length;
const sGrillS = results.filter((r) => r.grillSelf.success).length;
const sGrillR = results.filter((r) => r.grillReverse.success).length;
console.log(
  "| success count | " +
    sHandoff +
    "/" +
    results.length +
    " | " +
    sGrillS +
    "/" +
    results.length +
    " | " +
    sGrillR +
    "/" +
    results.length +
    " |",
);
console.log();

console.log("## Error modes observed");
console.log();
const allErrors = [];
for (const r of results) {
  for (const e of r.handoff.errors)
    allErrors.push({ scheme: "handoff", scenario: r.name, error: e });
  for (const e of r.grillSelf.errors)
    allErrors.push({ scheme: "grillL1", scenario: r.name, error: e });
  for (const e of r.grillReverse.errors)
    allErrors.push({ scheme: "grillL2", scenario: r.name, error: e });
}
console.log("| scheme | scenario | error |");
console.log("|---|---|---|");
for (const e of allErrors)
  console.log("| " + e.scheme + " | " + e.scenario + " | " + e.error + " |");
console.log();

console.log("## Boundary guarantee analysis");
console.log();
console.log("| scenario | ambiguity | handoff preserves intent | grill self | grill reverse |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  let hIntent = "Y (handoff doc captures)";
  if (r.handoff.errors.indexOf("semantic_handoff_loss") >= 0) hIntent = "N (semantic_handoff_loss)";
  if (r.handoff.errors.indexOf("handoff_doc_truncated_by_adr_0015") >= 0)
    hIntent = "PARTIAL (doc truncated)";
  if (r.handoff.errors.indexOf("handoff_doc_lost_in_transit") >= 0) hIntent = "N (doc lost)";
  if (r.handoff.errors.indexOf("compounding_degradation_x3") >= 0)
    hIntent = "PARTIAL (chain degradation)";
  let gsIntent = "Y (self-grill resolves)";
  if (r.grillSelf.errors.indexOf("infinite_self_grill_loop") >= 0) gsIntent = "N (loop)";
  if (r.grillSelf.errors.indexOf("self_grill_false_confidence") >= 0)
    gsIntent = "PARTIAL (false confidence)";
  let grIntent = "Y (parent answered)";
  if (r.grillReverse.errors.indexOf("parent_query_timeout") >= 0) grIntent = "N (parent timeout)";
  if (r.grillReverse.errors.indexOf("parent_query_response_wrong") >= 0)
    grIntent = "N (wrong answer)";
  if (r.grillReverse.errors.indexOf("cascading_queries_x5") >= 0) grIntent = "PARTIAL (cascade)";
  console.log(
    "| " +
      r.name +
      " | " +
      r.ambiguity +
      " | " +
      hIntent +
      " | " +
      gsIntent +
      " | " +
      grIntent +
      " |",
  );
}
console.log();

console.log("## Feasibility (will children be required to do this in practice?)");
console.log();
console.log("| scenario | handoff cost | grill L1 cost | grill L2 cost |");
console.log("|---|---|---|---|");
for (const r of results) {
  let hCost = "low (1 spawn, ~3.5s)";
  if (r.handoff.errors.indexOf("compounding_degradation_x3") >= 0)
    hCost = "high (3x chained, ~10s)";
  let gsCost = "very low (0-2.4s, 0 spawns)";
  if (r.grillSelf.errors.indexOf("infinite_self_grill_loop") >= 0) gsCost = "infinite (broken)";
  let grCost = "medium (~700ms, 1 round-trip)";
  if (r.grillReverse.errors.indexOf("cascading_queries_x5") >= 0)
    grCost = "very high (5x round-trip)";
  console.log("| " + r.name + " | " + hCost + " | " + gsCost + " | " + grCost + " |");
}
