#!/usr/bin/env node
/**
 * build-review-checklist.mjs — the checklist-building step the three-layer review apparatus was
 * missing (issue #254, acceptance ①).
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * Every check item in `.opencodereview/rules/*.md` carries an ownership marker
 * (`[机械: X]` / `[待补守卫: …]` / `[判断层: …]`). Until now those markers were **prose**: the
 * checklist handed to the reviewer was raw `ocr delegate rule` output, marker and all, so
 * "the judgement layer does not re-report what the mechanical layer already forces red" was a
 * promise in a document rather than a fact something could read. `ocr delegate rule` does not
 * read the markers (it hands the whole rule file back as the checklist), so nothing removed the
 * mechanical items. This script is the thing that reads them.
 *
 * WHAT IT DOES
 * ------------
 * Input : the JSON `ocr delegate rule --format json <paths>` produces (a file path, or stdin
 *         when the path is omitted or is `-`).
 * Output: the SAME JSON shape on stdout, with every **mechanically-owned** check item removed
 *         from each group's `rule` text. A drop-in replacement for the raw delegate output.
 * stderr: the **handover list** — what was moved to the mechanical layer and which guard owns
 *         it. It is for the host agent's report, NOT for the reviewer's checklist; without it
 *         the removal would be a silent drop.
 *
 * WHICH ITEMS ARE "MECHANICALLY-OWNED"
 * ------------------------------------
 * The marker grammar is the one `tests/review-layer-ownership.test.ts` pins:
 *
 *   - `[机械: a.test.ts, b.test.ts]` — the mechanical layer owns it and the named guards force
 *     it. Removed from the checklist; the handover names the guard(s).
 *   - `[待补守卫: <reason>]` — it **would** be mechanical, but the guard is absent or incomplete.
 *     `docs/agents/review-layers.md` defines this kind as "a GAP in the mechanical layer, not
 *     the judgement layer's job", so it is removed from the checklist too — and the handover
 *     reports it under "unguarded", because nobody enforces it today.
 *   - `[判断层: <reason>]` — the judgement layer owns it. It stays in the checklist.
 *
 * A marker that stands ALONE on its line (the whole line is the marker) declares the ownership
 * of the **whole file** — that is `general.md`'s shape, and it survives the transform unharmed.
 *
 * THE ONE INVARIANT THIS SCRIPT RELIES ON, AND HOW IT ENFORCES IT
 * ---------------------------------------------------------------
 * The marker sits at the END of its check item's last line. `tests/review-layer-ownership.test.ts`
 * (`markerIsAppended`) already pins that for the repository's own rule files, but this script
 * runs on whatever `ocr delegate rule` hands it, so it verifies the invariant itself and
 * **fails loudly** (non-zero exit, nothing on stdout) when a marker is not at an item's end —
 * a silently mis-parsed item would put a mechanical check item back into the checklist, which
 * is exactly the failure this script exists to remove.
 *
 * The three item shapes it understands are the three the repository actually uses (the same
 * three `tests/review-layer-ownership.test.ts` pins):
 *   - a top-level list item (`1. …` / `- …`), possibly spanning several lines;
 *   - a `###` subsection (its whole body belongs to it);
 *   - a markdown table row (one line; the marker must end the LAST CELL).
 *
 * It is read-only and deterministic: it writes to stdout and stderr and touches nothing else.
 */

import { readFileSync } from "node:fs";

/** The three legal ownership markers. The body runs to the closing bracket, so it may not contain `]`. */
const MARKER_PATTERN = /\[(机械|待补守卫|判断层)(:[^\]]*)?\]/g;

/** A markdown heading of any level. A heading ends the item in progress. */
const HEADING_PATTERN = /^(#{1,6})\s/;

/** A `###` subsection — a check item in its own right (`tests/review-layer-oracle` style). */
const SUBSECTION_PATTERN = /^###\s/;

/** A top-level list item. Indented list items are continuations of the item above them. */
const LIST_ITEM_PATTERN = /^(?:\d+\.|[-*+])\s/;

/** A markdown table row. */
const TABLE_ROW_PATTERN = /^\s*\|/;

/** A fenced code block delimiter. Content inside a fence is never an item. */
const FENCE_PATTERN = /^\s*(```|~~~)/;

/**
 * Every ownership marker in a piece of text, in order, with where it sits.
 *
 * `start` / `end` are offsets into the text, so a caller can ask "does this marker reach the
 * end of the line?" without re-running the regex.
 */
function markersIn(text) {
  const found = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const body = (match[2] ?? "").replace(/^:/, "").trim();
    found.push({
      kind: match[1],
      body,
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * Split a rule document into its check items.
 *
 * The rules, in one place, so the shape is auditable:
 *   - a heading (any level) ends the item in progress; a `###` heading starts a new item whose
 *     body runs to the next heading;
 *   - a top-level list item ends the item in progress — UNLESS that item is a `###` subsection,
 *     whose body may contain top-level bullets of its own (`test-discipline-oracle.md`'s T2 does);
 *   - a table row is a complete item by itself;
 *   - every other line is a continuation of the item in progress.
 *
 * An item's extent never includes trailing blank lines: the marker sits on the last NON-BLANK
 * line, and a trailing blank would hide it.
 */
function splitItems(text) {
  const lines = text.split("\n");
  const items = [];
  let open = null;
  let fence = null;

  const close = (endIndex) => {
    if (open === null) return;
    let end = endIndex;
    while (end > open.start && (lines[end] ?? "").trim() === "") end -= 1;
    open.end = end;
    items.push(open);
    open = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1];
        // A top-level fence opens a new block: it ends the item in progress.
        if (open !== null && !/^\s/.test(line)) close(i - 1);
      } else if (line.trim().startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue; // code-block content never starts an item

    if (HEADING_PATTERN.test(line)) {
      close(i - 1);
      if (SUBSECTION_PATTERN.test(line)) {
        open = { kind: "subsection", start: i, end: i };
      }
      continue;
    }

    if (TABLE_ROW_PATTERN.test(line)) {
      close(i - 1);
      open = { kind: "table-row", start: i, end: i };
      close(i);
      continue;
    }

    if (LIST_ITEM_PATTERN.test(line)) {
      // A bullet inside a `###` subsection belongs to that subsection, not to a new item.
      if (open === null || open.kind !== "subsection") close(i - 1);
      if (open === null) {
        open = { kind: "list-item", start: i, end: i };
      }
      continue;
    }
  }
  close(lines.length - 1);
  return items;
}

/**
 * Does this marker sit at the END of the line it is on?
 *
 * For a list item or a subsection that means the line's last characters. For a table row it
 * means the last CELL's last characters — the row itself ends with `|`, and the ownership
 * fixture (`markerIsAppended`) uses the same rule.
 */
function markerEndsLine(marker, line, kind) {
  const trimmed = line.trimEnd();
  if (kind === "table-row") {
    // A table row ends with `|`, so "the marker is at the end" means "the marker is in the
    // LAST CELL and ends that cell" — the same rule the ownership fixture uses
    // (`markerIsAppended`, table branch).
    const finalPipe = trimmed.lastIndexOf("|");
    if (finalPipe === -1) return false;
    const cellStart = trimmed.lastIndexOf("|", finalPipe - 1) + 1;
    if (marker.start < cellStart) return false;
    if (trimmed.slice(marker.end, finalPipe).trim() !== "") return false;
    return marker.end <= finalPipe;
  }
  return marker.end === trimmed.length;
}

/**
 * The whole line is exactly this one marker — a file-level declaration, not a per-item one.
 */
function isStandaloneMarker(line, marker) {
  return line.trim() === marker.text;
}

/**
 * The analysis of one rule document: which items are mechanically owned, which markers are
 * file-level, and whether every per-item marker really is at an item's end.
 */
function analyseRuleText(text) {
  const lines = text.split("\n");
  const items = splitItems(text);

  /** item index -> the marker on that item's last line (if any) */
  const itemMarkers = new Map();
  /** line index -> the item covering it */
  const ownerOfLine = new Map();
  for (const item of items) {
    for (let i = item.start; i <= item.end; i += 1) ownerOfLine.set(i, item);
  }

  const problems = [];
  const fileLevel = [];
  const marked = [];

  /** Position key of a marker: which line, at which offset. Identity is not comparable across
   *  two separate regex passes, but a position is. */
  const keyOf = (lineIndex, marker) => `${lineIndex}:${marker.start}`;

  for (const item of items) {
    const lastLine = lines[item.end] ?? "";
    const lastMarkers = markersIn(lastLine);
    if (lastMarkers.length > 1) {
      problems.push(
        `line ${item.end + 1}: ${lastMarkers.length} ownership markers on one check item's last line`,
      );
      continue;
    }
    if (lastMarkers.length === 1) {
      const marker = lastMarkers[0];
      if (!markerEndsLine(marker, lastLine, item.kind)) {
        problems.push(
          `line ${item.end + 1}: the ownership marker is not at the end of the check item`,
        );
        continue;
      }
      itemMarkers.set(item, marker);
    }
  }

  // Every marker must be accounted for: either it ends a check item, or it stands alone on its
  // line outside any check item (a file-level declaration). Anything else is a parse failure —
  // reporting it is the whole point of checking the invariant here.
  const accounted = new Set();
  for (const [item, marker] of itemMarkers) {
    accounted.add(keyOf(item.end, marker));
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const marker of markersIn(line)) {
      const key = keyOf(i, marker);
      if (accounted.has(key)) continue;
      if (isStandaloneMarker(line, marker) && !ownerOfLine.has(i)) {
        fileLevel.push({ line: i + 1, marker });
        accounted.add(key);
        continue;
      }
      problems.push(
        `line ${i + 1}: an ownership marker is not at the end of any check item` +
          (ownerOfLine.has(i) ? " (it sits inside a check item)" : ""),
      );
    }
  }

  for (const [item, marker] of itemMarkers) {
    marked.push({ item, marker });
  }

  return { items, itemMarkers, fileLevel, marked, problems };
}

/**
 * The identity of a removed item, for the handover list: where it was and what it said.
 */
function describeItem(item, lines) {
  const first = (lines[item.start] ?? "").trim();
  return { line: item.start + 1, kind: item.kind, summary: first };
}

/**
 * Build the filtered rule text and the handover entries for one rule document.
 */
function filterRuleText(text, label) {
  const analysis = analyseRuleText(text);
  if (analysis.problems.length > 0) {
    throw new Error(
      `${label}: the ownership markers could not be parsed safely:\n` +
        analysis.problems.map((problem) => "  - " + problem).join("\n"),
    );
  }

  const lines = text.split("\n");
  const removed = new Set();
  const handover = [];

  for (const { item, marker } of analysis.marked) {
    const isMechanical = marker.kind === "机械" || marker.kind === "待补守卫";
    if (!isMechanical) continue;
    for (let i = item.start; i <= item.end; i += 1) removed.add(i);
    handover.push({
      ...describeItem(item, lines),
      kind: marker.kind,
      body: marker.body,
      guards:
        marker.kind === "机械"
          ? marker.body
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean)
          : [],
    });
  }

  const kept = lines.filter((_, index) => !removed.has(index));
  return { text: kept.join("\n"), handover, fileLevel: analysis.fileLevel };
}

/**
 * The handover list, on stderr. It is for the host agent's report, not for the reviewer.
 */
function formatHandover(entries, fileLevel) {
  const lines = [];
  lines.push(
    "=== HANDOVER: mechanically-owned check items removed from the judgement checklist ===",
  );
  lines.push(
    "These items are NOT in the checklist on stdout. Report them in the host agent's report:",
  );
  lines.push("  - guarded   : the mechanical layer already forces them (cite the named guard);");
  lines.push(
    "  - unguarded : NO guard covers them today — these are gaps, and nobody enforces them.",
  );
  lines.push("");

  if (entries.length === 0) {
    lines.push("(no mechanically-owned check item was removed)");
  }
  for (const entry of entries) {
    const owner =
      entry.kind === "机械" ? `guard=${entry.guards.join(", ")}` : `NO GUARD — ${entry.body}`;
    lines.push(`  [${entry.kind}] ${owner}`);
    lines.push(`      L${entry.line}: ${entry.summary}`);
  }

  if (fileLevel.length > 0) {
    lines.push("");
    lines.push("  file-level declarations (whole file, not a check item — left in place):");
    for (const declaration of fileLevel) {
      lines.push(
        `      L${declaration.line}: [${declaration.marker.kind}] ${declaration.marker.body}`,
      );
    }
  }

  lines.push("");
  lines.push(`=== end of handover (${entries.length} item(s) removed) ===`);
  return lines.join("\n");
}

/**
 * Read the delegate-rule JSON from a file or from stdin.
 */
function readInput(path) {
  if (path === undefined || path === "-") {
    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch (cause) {
      throw new Error(`cannot read the delegate-rule JSON from stdin: ${String(cause)}`);
    }
    return raw;
  }
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read the delegate-rule JSON (${path}): ${String(cause)}`);
  }
}

/**
 * Parse the delegate-rule JSON. A malformed input is an explicit failure, never an empty
 * checklist: an empty checklist would look like "nothing to review" instead of "the input broke".
 */
function parseDelegateJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("the delegate-rule JSON is not valid JSON: " + String(cause));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the delegate-rule JSON is not an object");
  }
  const groups = parsed.groups;
  if (!Array.isArray(groups)) {
    throw new Error("the delegate-rule JSON has no `groups` array");
  }
  for (const group of groups) {
    if (typeof group?.rule !== "string") {
      throw new Error("a group in the delegate-rule JSON has no string `rule` text");
    }
  }
  return parsed;
}

function main(argv) {
  const path = argv[0];
  const parsed = parseDelegateJson(readInput(path));

  const groups = [];
  const allHandover = [];
  const allFileLevel = [];

  for (const group of parsed.groups) {
    const label = `group ${group.group_id ?? "?"} (${group.pattern ?? "no pattern"})`;
    const filtered = filterRuleText(group.rule, label);
    groups.push({ ...group, rule: filtered.text });
    for (const entry of filtered.handover) {
      allHandover.push({ ...entry, group: label });
    }
    for (const declaration of filtered.fileLevel) {
      allFileLevel.push({ ...declaration, group: label });
    }
  }

  const output = { ...parsed, groups };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.stderr.write(formatHandover(allHandover, allFileLevel) + "\n");
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    "build-review-checklist: " + (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
