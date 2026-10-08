#!/usr/bin/env node
// Throwaway measurement script — runs the same logic as the HTML prototype,
// outputs the head-to-head matrix and verdict as plain text.

const META_BYTES = 200;
const REF_STRING_BYTES = 100;
const INLINE_THRESHOLD_A = 8 * 1024;
const PREVIEW_THRESHOLD_BC = 2 * 1024;
const PREVIEW_TAIL_A = 4 * 1024;
const MEDIUM_THRESHOLD_A = 50 * 1024;
const TOKENS_PER_BYTE = 4;

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function genTaskSizes(distKey, count, seed) {
  const rnd = mulberry32(seed);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const r = rnd();
    let sz;
    switch (distKey) {
      case "small":
        sz = 100 + rnd() * (2048 - 100);
        break;
      case "small-medium":
        sz = r < 0.8 ? 100 + rnd() * (2048 - 100) : 2049 + rnd() * (8192 - 2049);
        break;
      case "realistic":
        if (r < 0.60) sz = 100 + rnd() * (2048 - 100);
        else if (r < 0.85) sz = 2049 + rnd() * (8192 - 2049);
        else if (r < 0.95) sz = 8193 + rnd() * (51200 - 8193);
        else sz = 51201 + rnd() * (250000 - 51201);
        break;
      case "large":
        if (r < 0.3) sz = 8193 + rnd() * (51200 - 8193);
        else sz = 51201 + rnd() * (250000 - 51201);
        break;
      case "burst":
        if (r < 0.70) sz = 100 + rnd() * (2048 - 100);
        else if (r < 0.90) sz = 2049 + rnd() * (8192 - 2049);
        else if (r < 0.97) sz = 8193 + rnd() * (51200 - 8193);
        else sz = 51201 + rnd() * (300000 - 51201);
        break;
    }
    sizes.push(Math.max(50, Math.floor(sz)));
  }
  return sizes;
}

function computeScheme(scheme, sizes) {
  let totalBytes = 0;
  let totalRoundTrips = 0;
  const perTask = [];
  for (const sz of sizes) {
    let bytes = 0;
    let rt = 0;
    if (scheme === "tiered") {
      if (sz <= INLINE_THRESHOLD_A) { bytes = sz + META_BYTES; rt = 0; }
      else if (sz <= MEDIUM_THRESHOLD_A) { bytes = PREVIEW_TAIL_A + META_BYTES + REF_STRING_BYTES; rt = 1; }
      else { bytes = META_BYTES + REF_STRING_BYTES; rt = 1; }
    } else if (scheme === "reference") {
      bytes = META_BYTES + REF_STRING_BYTES;
      if (sz <= PREVIEW_THRESHOLD_BC) { bytes += sz; rt = 0; } else { rt = 1; }
    } else if (scheme === "map-preview") {
      bytes = META_BYTES;
      if (sz <= PREVIEW_THRESHOLD_BC) { bytes += sz; rt = 0; } else { rt = 1; }
    } else if (scheme === "map-strict") {
      bytes = META_BYTES; rt = 1;
    }
    totalBytes += bytes;
    totalRoundTrips += rt;
    perTask.push({ sz, bytes, rt });
  }
  return { totalBytes, totalRoundTrips, perTask };
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB";
  return (b / 1024 / 1024).toFixed(3) + " MB";
}
function fmtTokens(b) { return Math.round(b / TOKENS_PER_BYTE).toLocaleString(); }

const dists = ["small", "small-medium", "realistic", "large", "burst"];
const counts = [20, 60, 100, 200, 500];
const allSchemes = ["tiered", "reference", "map-preview", "map-strict"];
const SCHEME_LABELS = { tiered: "A. Tiered", reference: "B. Reference", "map-preview": "C. Map+preview", "map-strict": "D. Strict Map" };
const DIST_LABELS = { small: "small (<=2K)", "small-medium": "small+med (80/20)", realistic: "realistic (60/25/10/5)", large: "large (30/70)", burst: "burst (70/20/7/3)" };

const winsByScheme = {tiered: 0, reference: 0, "map-preview": 0, "map-strict": 0};
const totalCells = dists.length * counts.length;
const avgBytes = {tiered: 0, reference: 0, "map-preview": 0, "map-strict": 0};
const avgRT = {tiered: 0, reference: 0, "map-preview": 0, "map-strict": 0};
const aggByDist = {};
for (const d of dists) aggByDist[d] = {tiered: 0, reference: 0, "map-preview": 0, "map-strict": 0, cells: 0};
const aggByCount = {};
for (const c of counts) aggByCount[c] = {tiered: 0, reference: 0, "map-preview": 0, "map-strict": 0, cells: 0};
const matrix = [];

for (const d of dists) {
  for (const c of counts) {
    const sizes = genTaskSizes(d, c, 42);
    const results = allSchemes.map(s => computeScheme(s, sizes));
    const minB = Math.min(...results.map(r => r.totalBytes));
    const winIdx = results.findIndex(r => r.totalBytes === minB);
    winsByScheme[allSchemes[winIdx]]++;
    const totalRT = results.reduce((a, r) => a + r.totalRoundTrips, 0);
    const row = { dist: d, count: c, results: results.map((r, i) => Object.assign({}, r, {key: allSchemes[i]})), winnerKey: allSchemes[winIdx], totalRT };
    matrix.push(row);
    results.forEach((r, i) => {
      const k = allSchemes[i];
      avgBytes[k] += r.totalBytes;
      avgRT[k] += r.totalRoundTrips;
      aggByDist[d][k] += r.totalBytes;
      aggByCount[c][k] += r.totalBytes;
    });
    aggByDist[d].cells++;
    aggByCount[c].cells++;
  }
}
for (const s of allSchemes) { avgBytes[s] /= totalCells; avgRT[s] /= totalCells; }
for (const d of dists) { for (const s of allSchemes) aggByDist[d][s] /= aggByDist[d].cells; }
for (const c of counts) { for (const s of allSchemes) aggByCount[c][s] /= aggByCount[c].cells; }

console.log("# bgdispatch/G2 Notification Scheme Measurements");
console.log("# seed=42 deterministic; " + totalCells + " cells = 5 dists x 5 counts");
console.log();
console.log("## Head-to-head matrix (winner marked with *)");
console.log();
console.log("| dist | count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map | winner | total RT |");
console.log("|---|---|---|---|---|---|---|---|");
for (const row of matrix) {
  const cells = row.results.map(r => fmtBytes(r.totalBytes));
  const winnerName = SCHEME_LABELS[row.winnerKey].split(".")[0];
  const cIdx = allSchemes.indexOf("map-preview");
  if (row.winnerKey === "map-preview") cells[cIdx] = "*" + cells[cIdx] + "*";
  console.log("| " + DIST_LABELS[row.dist] + " | " + row.count + " | " + cells[0] + " | " + cells[1] + " | " + cells[2] + " | " + cells[3] + " | " + winnerName + " | " + row.totalRT + " |");
}
console.log();

console.log("## Aggregate by distribution (avg bytes across counts)");
console.log();
console.log("| dist | A. Tiered | B. Reference | C. Map+preview | D. Strict Map |");
console.log("|---|---|---|---|---|");
for (const d of dists) {
  console.log("| " + DIST_LABELS[d] + " | " + fmtBytes(aggByDist[d].tiered) + " | " + fmtBytes(aggByDist[d].reference) + " | " + fmtBytes(aggByDist[d]["map-preview"]) + " | " + fmtBytes(aggByDist[d]["map-strict"]) + " |");
}
console.log();

console.log("## Aggregate by task count (avg bytes across dists)");
console.log();
console.log("| count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map |");
console.log("|---|---|---|---|---|");
for (const c of counts) {
  console.log("| " + c + " | " + fmtBytes(aggByCount[c].tiered) + " | " + fmtBytes(aggByCount[c].reference) + " | " + fmtBytes(aggByCount[c]["map-preview"]) + " | " + fmtBytes(aggByCount[c]["map-strict"]) + " |");
}
console.log();

console.log("## Win count (out of " + totalCells + " cells)");
console.log();
for (const s of allSchemes) {
  console.log("  " + SCHEME_LABELS[s] + ": " + winsByScheme[s] + " wins (" + (winsByScheme[s]/totalCells*100).toFixed(0) + "%)");
}
console.log();

console.log("## Average per scheme (across all cells)");
console.log();
console.log("| scheme | avg bytes | avg tokens | avg RT |");
console.log("|---|---|---|---|");
for (const s of allSchemes) {
  console.log("| " + SCHEME_LABELS[s] + " | " + fmtBytes(avgBytes[s]) + " | " + fmtTokens(avgBytes[s]) + " | " + avgRT[s].toFixed(1) + " |");
}
console.log();

console.log("## Ratio: each scheme vs C. Map+preview (lower = C wins by more)");
console.log();
console.log("| scheme | bytes ratio | RT ratio |");
console.log("|---|---|---|");
for (const s of allSchemes) {
  const bR = (avgBytes[s] / avgBytes["map-preview"]).toFixed(2);
  const rR = (avgRT[s] / avgRT["map-preview"]).toFixed(2);
  const flag = s === "map-preview" ? " (baseline)" : "";
  console.log("| " + SCHEME_LABELS[s] + flag + " | " + bR + "x | " + rR + "x |");
}
console.log();

console.log("## Does advantage scale? (realistic dist, varying count)");
console.log();
console.log("| count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map | A/C | B/C |");
console.log("|---|---|---|---|---|---|---|");
for (const c of counts) {
  const sizes = genTaskSizes("realistic", c, 42);
  const results = allSchemes.map(s => computeScheme(s, sizes));
  const a = results[0].totalBytes;
  const b = results[1].totalBytes;
  const cc = results[2].totalBytes;
  const d = results[3].totalBytes;
  console.log("| " + c + " | " + fmtBytes(a) + " | " + fmtBytes(b) + " | " + fmtBytes(cc) + " | " + fmtBytes(d) + " | " + (a/cc).toFixed(2) + "x | " + (b/cc).toFixed(2) + "x |");
}
console.log();

console.log("## D (Strict Map) penalty vs C (Map+preview) - is the inline preview worth it?");
console.log();
console.log("| dist | count | C bytes | D bytes | D-C diff | D/C | C RT | D RT | extra RT from strict |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const d of dists) {
  for (const c of counts) {
    const sizes = genTaskSizes(d, c, 42);
    const cR = computeScheme("map-preview", sizes);
    const dR = computeScheme("map-strict", sizes);
    const extraRT = dR.totalRoundTrips - cR.totalRoundTrips;
    console.log("| " + DIST_LABELS[d] + " | " + c + " | " + fmtBytes(cR.totalBytes) + " | " + fmtBytes(dR.totalBytes) + " | " + fmtBytes(dR.totalBytes - cR.totalBytes) + " | " + (dR.totalBytes/cR.totalBytes).toFixed(2) + "x | " + cR.totalRoundTrips + " | " + dR.totalRoundTrips + " | +" + extraRT + " RT |");
  }
}
