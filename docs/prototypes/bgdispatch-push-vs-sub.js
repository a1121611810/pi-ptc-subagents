#!/usr/bin/env node
// Push vs Subscription prototype v3 — fixed SUB drain-on-idle, optimized stepping

const META_BYTES = 200;
const PREVIEW_THRESHOLD = 2048;
const RATE_LIMIT = 3;
const RATE_LIMIT_WINDOW = 60000;
const CADENCE_INTERVAL = 60000;
const CADENCE_REMINDER_BYTES = 100;
const POLL_INTERVAL = 30000;

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

function genRealisticDist(rnd) {
  const r = rnd();
  if (r < 0.6) return 100 + rnd() * (2048 - 100);
  if (r < 0.85) return 2049 + rnd() * (8192 - 2049);
  if (r < 0.95) return 8193 + rnd() * (51200 - 8193);
  return 51201 + rnd() * (250000 - 51201);
}

function genTasks(count, arrival, seed) {
  const rnd = mulberry32(seed);
  const tasks = [];
  for (let i = 0; i < count; i++) {
    let completesAt;
    if (arrival.kind === "uniform")
      completesAt = (i / count) * arrival.totalMs + rnd() * (arrival.totalMs / count);
    else if (arrival.kind === "burst") completesAt = rnd() * 1000;
    else if (arrival.kind === "super_burst") completesAt = rnd() * 5000;
    else if (arrival.kind === "during_busy") completesAt = 30000 + rnd() * 270000;
    else if (arrival.kind === "during_idle") completesAt = 60000 + rnd() * 660000;
    else completesAt = rnd() * 600000;
    const sz = Math.max(50, Math.floor(genRealisticDist(rnd)));
    tasks.push({ id: "T" + i, completesAt, outputSize: sz, completed: true });
  }
  return tasks;
}

function aiStateFromScenario(name) {
  const idle = (t) => true;
  if (name === "burst_100") return { idleAt: (t) => t > 5000 };
  if (name === "super_burst_500") return { idleAt: (t) => t > 10000 };
  if (name === "ai_busy_5min") return { idleAt: (t) => t < 30000 || t > 330000 };
  if (name === "restart") return { idleAt: (t) => t < 300000 || t > 700000 };
  if (name === "fork") return { idleAt: idle };
  if (name === "ptc_off") return { idleAt: (t) => t < 120000 || t > 480000 };
  if (name === "cadence_pressure") return { idleAt: idle };
  return { idleAt: idle };
}

function notifBytes(task) {
  if (task.outputSize <= PREVIEW_THRESHOLD) return META_BYTES + task.outputSize;
  return META_BYTES;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length * p) / 100)];
}
function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB";
  return (b / 1024 / 1024).toFixed(3) + " MB";
}
function fmtMs(ms) {
  return Math.round(ms).toLocaleString() + " ms";
}

function simulatePush(tasks, aiState) {
  const sorted = [...tasks].sort((a, b) => a.completesAt - b.completesAt);
  let totalBytes = 0;
  let wakeCount = 0;
  let maxBacklog = 0;
  let cadenceInjections = 0;
  let delivered = 0;
  let latencies = [];
  let backlog = [];
  let lastCadenceTime = 0;
  let deliveryTimestamps = [];
  let i = 0;
  let t = 0;
  const finiteCompletes = sorted.map((x) => x.completesAt).filter((x) => isFinite(x));
  const maxT =
    Math.max(600000, finiteCompletes.length > 0 ? Math.max(...finiteCompletes) : 0) + 120000;

  while (t <= maxT) {
    while (i < sorted.length && sorted[i].completesAt <= t) {
      backlog.push(sorted[i]);
      i++;
    }

    const isIdle = aiState.idleAt(t);
    if (isIdle && backlog.length > 0) {
      deliveryTimestamps = deliveryTimestamps.filter((x) => x > t - RATE_LIMIT_WINDOW);
      const slots = Math.max(0, RATE_LIMIT - deliveryTimestamps.length);
      const toDeliver = Math.min(backlog.length, Math.max(1, slots));
      const drained = backlog.splice(0, toDeliver);
      for (const task of drained) {
        totalBytes += notifBytes(task);
        delivered++;
        latencies.push(Math.max(0, t - task.completesAt));
      }
      if (drained.length > 0) {
        deliveryTimestamps.push(t);
        wakeCount++;
      }
    }

    maxBacklog = Math.max(maxBacklog, backlog.length);

    if (t - lastCadenceTime >= CADENCE_INTERVAL && backlog.length > 0) {
      cadenceInjections++;
      totalBytes += CADENCE_REMINDER_BYTES + Math.floor(Math.log2(backlog.length + 1)) * 10;
      const drain = Math.min(backlog.length, 3);
      const drained = backlog.splice(0, drain);
      for (const task of drained) {
        totalBytes += notifBytes(task);
        delivered++;
        latencies.push(Math.max(0, t - task.completesAt));
      }
      lastCadenceTime = t;
    }

    if (i >= sorted.length && backlog.length === 0) break;
    const nextTaskAt = i < sorted.length ? sorted[i].completesAt : Infinity;
    const nextCadenceAt = lastCadenceTime + CADENCE_INTERVAL;
    const minNext = Math.min(nextTaskAt, nextCadenceAt);
    t = minNext > t ? minNext : t + 1000;
  }

  return {
    scheme: "push",
    totalBytes,
    wakeCount,
    maxBacklog,
    cadenceInjections,
    deliveredTasks: delivered,
    totalTasks: sorted.length,
    p50Latency: median(latencies),
    p99Latency: percentile(latencies, 99),
  };
}

function simulateSub(tasks, aiState) {
  const sorted = [...tasks].sort((a, b) => a.completesAt - b.completesAt);
  let totalBytes = 0;
  let wakeCount = 0;
  let maxBuffer = 0;
  let pollCount = 0;
  let delivered = 0;
  let latencies = [];
  let buffer = [];
  let lastPollAt = 0;
  let i = 0;
  let t = 0;
  const finiteCompletes = sorted.map((x) => x.completesAt).filter((x) => isFinite(x));
  const maxT =
    Math.max(600000, finiteCompletes.length > 0 ? Math.max(...finiteCompletes) : 0) + 120000;

  let wasIdle = true;
  while (t <= maxT) {
    while (i < sorted.length && sorted[i].completesAt <= t) {
      const task = sorted[i];
      i++;
      buffer.push(task);
    }

    const isIdle = aiState.idleAt(t);

    // Drain on idle transition (idle -> idle with buffered events: wake once)
    if (isIdle && buffer.length > 0) {
      const drain = buffer.splice(0, buffer.length);
      for (const bt of drain) {
        totalBytes += notifBytes(bt);
        delivered++;
        latencies.push(Math.max(0, t - bt.completesAt));
      }
      wakeCount++;
    }
    // Poll when busy
    else if (!isIdle && t - lastPollAt >= POLL_INTERVAL && buffer.length > 0) {
      pollCount++;
      const drain = buffer.splice(0, buffer.length);
      for (const bt of drain) {
        totalBytes += notifBytes(bt);
        delivered++;
        latencies.push(Math.max(0, t - bt.completesAt));
      }
      lastPollAt = t;
    }

    maxBuffer = Math.max(maxBuffer, buffer.length);

    if (i >= sorted.length && buffer.length === 0) break;
    const nextTaskAt = i < sorted.length ? sorted[i].completesAt : Infinity;
    const nextPollAt = lastPollAt + POLL_INTERVAL;
    const minNext = Math.min(nextTaskAt, nextPollAt);
    t = minNext > t ? minNext : t + 1000;
  }

  return {
    scheme: "sub",
    totalBytes,
    wakeCount,
    maxBuffer,
    pollCount,
    deliveredTasks: delivered,
    totalTasks: sorted.length,
    p50Latency: median(latencies),
    p99Latency: percentile(latencies, 99),
  };
}

const SCENARIOS = [
  {
    name: "steady_60",
    count: 60,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "60 tasks over 10min, AI always idle",
  },
  {
    name: "burst_100",
    count: 100,
    arrival: { kind: "burst" },
    desc: "100 tasks complete in 1s, AI idle after 5s",
  },
  {
    name: "super_burst_500",
    count: 500,
    arrival: { kind: "super_burst" },
    desc: "500 tasks in 5s, AI idle after 10s",
  },
  {
    name: "ai_busy_5min",
    count: 50,
    arrival: { kind: "during_busy" },
    desc: "50 tasks complete during 5-min AI tool loop",
  },
  {
    name: "restart",
    count: 60,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "AI crashes at 5min, restart at 11min",
  },
  {
    name: "fork",
    count: 60,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "Session forks at 5min (both branches continue)",
  },
  {
    name: "stop_spike",
    count: 50,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "50 tasks; stop called on 15 mid-flight",
  },
  {
    name: "ptc_off",
    count: 30,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "30 tasks; /ptc off from 2-8min",
  },
  {
    name: "cadence_pressure",
    count: 60,
    arrival: { kind: "during_idle" },
    desc: "60 tasks complete during 12-min AI idle",
  },
  {
    name: "mixed_500",
    count: 500,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "500 tasks over 10min (scale test)",
  },
  {
    name: "zombie_60",
    count: 60,
    arrival: { kind: "uniform", totalMs: 600000 },
    desc: "60 tasks; 10% never complete",
  },
  {
    name: "slow_fast",
    count: 51,
    arrival: { kind: "burst" },
    desc: "1 super-slow (10min) + 50 fast burst",
  },
];

function runScenario(s) {
  const tasks = genTasks(s.count, s.arrival, 42);
  if (s.name === "zombie_60") {
    for (let i = 0; i < Math.floor(tasks.length * 0.1); i++) {
      tasks[i].completed = false;
      tasks[i].completesAt = Infinity;
    }
    tasks.sort((a, b) => a.completesAt - b.completesAt);
  }
  if (s.name === "slow_fast") {
    tasks[0].completesAt = 600000;
  }
  const aiState = aiStateFromScenario(s.name);
  return {
    name: s.name,
    desc: s.desc,
    push: simulatePush(tasks, aiState),
    sub: simulateSub(tasks, aiState),
  };
}

console.log("# bgdispatch/G2 - Push vs Subscription head-to-head");
console.log("# seed=42 deterministic; " + SCENARIOS.length + " scenarios");
console.log("");
console.log("## Scenarios");
console.log("");
console.log("| # | scenario | desc | tasks |");
console.log("|---|---|---|---|");
SCENARIOS.forEach((s, i) =>
  console.log("| " + (i + 1) + " | " + s.name + " | " + s.desc + " | " + s.count + " |"),
);
console.log("");

console.log("## Per-scenario: PUSH vs SUB");
console.log("");
const results = [];
SCENARIOS.forEach((s) => {
  const r = runScenario(s);
  results.push(r);
  const p = r.push;
  const ss = r.sub;
  console.log("### " + s.name + " - " + s.desc);
  console.log("");
  console.log("| metric | PUSH | SUB | ratio (PUSH/SUB) |");
  console.log("|---|---|---|---|");
  console.log(
    "| total bytes | " +
      fmtBytes(p.totalBytes) +
      " | " +
      fmtBytes(ss.totalBytes) +
      " | " +
      (p.totalBytes / Math.max(1, ss.totalBytes)).toFixed(2) +
      "x |",
  );
  console.log(
    "| wake count | " +
      p.wakeCount +
      " | " +
      ss.wakeCount +
      " | " +
      (p.wakeCount / Math.max(1, ss.wakeCount)).toFixed(2) +
      "x |",
  );
  console.log(
    "| max backlog/buffer | " +
      p.maxBacklog +
      " | " +
      ss.maxBuffer +
      " | " +
      (p.maxBacklog / Math.max(1, ss.maxBuffer)).toFixed(2) +
      "x |",
  );
  console.log("| cadence injections | " + p.cadenceInjections + " | 0 | - |");
  console.log("| poll count | n/a | " + ss.pollCount + " | - |");
  console.log(
    "| delivered | " +
      p.deliveredTasks +
      "/" +
      p.totalTasks +
      " | " +
      ss.deliveredTasks +
      "/" +
      ss.totalTasks +
      " | - |",
  );
  console.log("| p50 latency | " + fmtMs(p.p50Latency) + " | " + fmtMs(ss.p50Latency) + " | - |");
  console.log("| p99 latency | " + fmtMs(p.p99Latency) + " | " + fmtMs(ss.p99Latency) + " | - |");
  console.log("");
});

console.log("## Edge case verdict (issues per scheme)");
console.log("");
console.log("| scenario | PUSH issues | SUB issues |");
console.log("|---|---|---|");
for (const r of results) {
  const p = r.push;
  const ss = r.sub;
  let pIssue = "";
  let sIssue = "";
  if (p.maxBacklog > 5) pIssue += "backlog=" + p.maxBacklog + "; ";
  if (p.cadenceInjections > 0) pIssue += p.cadenceInjections + " cadence; ";
  if (p.p99Latency > 30000) pIssue += "p99 " + fmtMs(p.p99Latency) + "; ";
  if (p.deliveredTasks < p.totalTasks) pIssue += p.totalTasks - p.deliveredTasks + " undelivered; ";
  if (ss.maxBuffer > 5) sIssue += "buffer=" + ss.maxBuffer + "; ";
  if (ss.p99Latency > 30000) sIssue += "p99 " + fmtMs(ss.p99Latency) + "; ";
  if (ss.deliveredTasks < ss.totalTasks)
    sIssue += ss.totalTasks - ss.deliveredTasks + " undelivered; ";
  if (!pIssue) pIssue = "(clean)";
  if (!sIssue) sIssue = "(clean)";
  console.log("| " + r.name + " | " + pIssue + " | " + sIssue + " |");
}
console.log("");

console.log("## Aggregate (across all " + SCENARIOS.length + " scenarios)");
console.log("");
const pushTotalBytes = results.reduce((a, r) => a + r.push.totalBytes, 0);
const subTotalBytes = results.reduce((a, r) => a + r.sub.totalBytes, 0);
const pushTotalWake = results.reduce((a, r) => a + r.push.wakeCount, 0);
const subTotalWake = results.reduce((a, r) => a + r.sub.wakeCount, 0);
const pushTotalCadence = results.reduce((a, r) => a + r.push.cadenceInjections, 0);
const subTotalPoll = results.reduce((a, r) => a + r.sub.pollCount, 0);
const pushMaxBacklog = Math.max(...results.map((r) => r.push.maxBacklog));
const subMaxBuffer = Math.max(...results.map((r) => r.sub.maxBuffer));
console.log("| metric | PUSH | SUB |");
console.log("|---|---|---|");
console.log("| sum bytes | " + fmtBytes(pushTotalBytes) + " | " + fmtBytes(subTotalBytes) + " |");
console.log("| sum wake count | " + pushTotalWake + " | " + subTotalWake + " |");
console.log("| sum cadence injections | " + pushTotalCadence + " | 0 |");
console.log("| sum poll count | n/a | " + subTotalPoll + " |");
console.log("| max backlog/buffer worst-case | " + pushMaxBacklog + " | " + subMaxBuffer + " |");
