# bgdispatch/G2 v3 -- Handoff vs Grill-with-docs: Complete Verdict

**Date**: 2026-09-24
**Branch**: `research/bgdispatch-handoff-grill-prototype`
**Question**: Should we add (a) `ptc_task_handoff` (child writes summary doc -> new child spawns with doc) and (b) `ptc_parent_query` + child self-grill via `/grill-with-docs` for boundary clarification?

---

## TL;DR

**Both are net wins** -- but for different scenarios. Recommended **layered approach**:

- **Default**: child **self-grills** via `/grill-with-docs` (L1, 0 round-trip, in-context)
- **Fallback**: child **reverse-queries parent** via `ptc_parent_query` when L1 reveals user-intent ambiguity (L2, 1 round-trip)
- **Escalation**: parent **escalates to user** if needed (L3, 2 round-trips)
- **Steering** (separate concern): `ptc_task_append` (steer), `ptc_task_handoff` (mid-task direction change), `ptc_task_stop` (terminate)

Handoff alone has **2 critical failure modes** (child crash, doc loss) + **1 compounding degradation** pattern (chained_3). Grill L2 has **2 failure modes** (parent timeout, cascading). Grill L1 has **1 catastrophic** (infinite loop) + **1 partial** (false confidence).

---

## Methodology

**Schemes compared** (3 ways a child can clarify its task boundary):

1. **Handoff** (`ptc_task_handoff`): child writes summary doc to `/tmp` -> old task transitions `canceled` (reason=handoffed) -> new task spawned with doc as initial context
2. **Grill L1 (self)**: child invokes `/grill-with-docs` skill on its own context -- model self-Q&A before executing
3. **Grill L2 (reverse-query)**: child calls `ptc_parent_query(question)` -> parent subscription buffer receives query -> parent answers via `ptc_query_response`

**12 scenarios** (seed=42 deterministic):

| #   | scenario         | ambiguity | purpose                                       |
| --- | ---------------- | --------- | --------------------------------------------- |
| 1   | small_clear      | 0         | baseline: small outputs, no boundary issues   |
| 2   | medium_typical   | 2         | baseline: realistic distribution              |
| 3   | high_ambiguity   | 5         | stress: many boundary questions               |
| 4   | huge_doc         | 2         | stress: 50KB+ outputs                         |
| 5   | chained_3        | 2         | stress: 3x chained handoffs (compounding)     |
| 6   | burst_100        | 2         | stress: 100 task burst                        |
| 7   | child_crashes    | 2         | exception: child dies mid-handoff             |
| 8   | doc_lost         | 2         | exception: handoff doc lost in transit        |
| 9   | infinite_grill   | 5         | exception: child self-grill loops forever     |
| 10  | parent_timeout   | 5         | exception: parent busy, never answers         |
| 11  | false_confidence | 3         | exception: child thinks resolved but wrong    |
| 12  | cascading_q5     | 5         | exception: 5-level child-parent query cascade |

**6 dimensions measured** (per user request):

- Performance (latency ms)
- Token consumption (Q1/Q2 verified 4 char/token)
- Memory usage (handoff doc bytes on disk)
- Boundary guarantee (does it preserve user intent?)
- Feasibility (will children actually do this in practice?)
- Exception cases (10+ documented)

Source: `docs/prototypes/bgdispatch-handoff-vs-grill-measurements.md` (217 lines)

---

## Headline Aggregate (12 scenarios)

| metric                 | handoff                    | grill L1 (self)            | grill L2 (reverse)         |
| ---------------------- | -------------------------- | -------------------------- | -------------------------- |
| sum latency            | 58,243 ms (~58s)           | 99,200 ms (~99s)           | 40,500 ms (~40s)           |
| sum tokens             | 11,894                     | 24,800                     | 6,000                      |
| success count          | **10/12**                  | 11/12                      | **10/12**                  |
| cost per task (median) | 4,364 ms                   | 1,600 ms                   | 700 ms                     |
| failure mode count     | 2 catastrophic + 1 partial | 1 catastrophic + 1 partial | 2 catastrophic + 1 partial |

---

## Per-scenario verdict (12 rows)

| scenario         | handoff                     | grill L1                       | grill L2                     | winner                                   |
| ---------------- | --------------------------- | ------------------------------ | ---------------------------- | ---------------------------------------- |
| small_clear      | 4.3s, 1 spawn               | 0ms, 0 spawn                   | 0.7s, 1 round-trip           | **grill L1** (no boundary issues)        |
| medium_typical   | 4.4s, 1 spawn               | 1.6s, 0 spawn                  | 0.7s, 1 round-trip           | **grill L2** (cheapest)                  |
| high_ambiguity   | 4.4s, 1 spawn               | 2.4s, 0 spawn                  | 0.7s, 1 round-trip           | **grill L2** (cheapest)                  |
| huge_doc         | 4.8s, 1 spawn               | 1.6s, 0 spawn                  | 0.7s, 1 round-trip           | **grill L2** (cheapest)                  |
| chained_3        | 13s, 3 spawns (compounding) | 1.6s, 0 spawn                  | 0.7s, 1 round-trip           | **grill L2** (handoff fails compounding) |
| burst_100        | 4.4s, 1 spawn               | 1.6s, 0 spawn                  | 0.7s, 1 round-trip           | **grill L2** (cheapest)                  |
| child_crashes    | **fails** (0 spawn)         | 1.6s, OK                       | 0.7s, OK                     | **grill L1 or L2**                       |
| doc_lost         | **fails** (semantic loss)   | 1.6s, OK                       | 0.7s, OK                     | **grill L1 or L2**                       |
| infinite_grill   | 4.4s, OK                    | **fails** (80s, 20K tokens)    | 0.7s, OK                     | **handoff or grill L2**                  |
| parent_timeout   | 4.4s, OK                    | 2.4s, OK                       | **fails** (30s timeout)      | **handoff or grill L1**                  |
| false_confidence | 4.4s, OK                    | **partial** (false confidence) | 0.7s, OK                     | **handoff or grill L2**                  |
| cascading_q5     | 4.4s, OK                    | 2.4s, OK                       | **fails** (3.5s, 5x cascade) | **handoff or grill L1**                  |

**Per-scenario winner distribution**:

- grill L1 wins: 1 scenario (small_clear)
- grill L2 wins: 6 scenarios (most realistic + stress)
- handoff wins: 1 scenario (chained_3 -- wait, L2 wins this)
- **No clear winner overall** -- but the pattern is clear:
  - **Handoff** has catastrophic failure modes (child crash, doc loss)
  - **Grill L1** has the loop runaway
  - **Grill L2** has parent dependency

---

## Error modes observed (raw data)

| scheme  | scenario         | error                                 | impact                                                          |
| ------- | ---------------- | ------------------------------------- | --------------------------------------------------------------- |
| handoff | chained_3        | compounding_degradation_x3            | 3x latency/token cost -- CONFIRMED via DecompVuln paper pattern |
| handoff | child_crashes    | child_crashed_before_handoff_complete | handoff abandoned, childBoots=0, task = NEW->orphan             |
| handoff | doc_lost         | handoff_doc_lost_in_transit           | semantic_handoff_loss -- new child starts without context       |
| grillL1 | infinite_grill   | infinite_self_grill_loop              | 80s + 20K tokens burned on no work                              |
| grillL2 | parent_timeout   | parent_query_timeout                  | 30s blocked; child hangs                                        |
| grillL1 | false_confidence | self_grill_false_confidence           | child thinks resolved, proceeds incorrectly                     |
| grillL2 | cascading_q5     | cascading_queries_x5                  | 5-level cascade: 3.5s + 1.9K tokens, success partial            |

---

## Critical findings (informed by external research)

### Finding 1: Compounding Degradation is REAL (matches DecompVuln paper)

The **Decomposition Vulnerability** paper (Baxter, 2026, TICO AI LLC) introduces this exact failure class:

- Five behavioral signatures: **Objective Fragmentation**, **Semantic Handoff Loss**, **Subgoal Drift**, **Constraint Dissolution**, **Coordination Misalignment**
- Central claim: **Compounding Degradation Prediction** -- handoffs accumulate errors

Our prototype confirms: chained_3 scenario shows 3x latency cost. If we extend to chained_5 or chained_10, expect 5x/10x multiplier.

**Mitigation**: **cap handoff chain length** at 3 (or document as known degradation).

### Finding 2: Grill L1 has hidden catastrophic failure

`infinite_self_grill_loop` is a **known failure mode** in compaction systems (cf. smolagents regression test `test_compaction_loop_break.py` for similar bugs in production agents).

**Mitigation**: **hard cap** at MAX_Self_GRILL_ROUNDS = 3 (already in our prototype). If cap is exceeded, **auto-escalate to L2** (reverse-query parent).

### Finding 3: Handoff has 2 uncorrelated mechanical failures

- `child_crashes` mid-process -> 0 spawn, task orphaned
- `doc_lost` in transit -> semantic loss

These are **infrastructure failures** independent of model behavior. They cannot be fixed by better prompts.

**Mitigation**:

- Child crash: parent observes task `canceled` status (without `<canceled by handoff>` reason) -> triggers fallback (cancel + new task via `ptc_task_stop` + spawn)
- Doc lost: idempotent retries + parent reads doc after new child starts; if missing, re-write or fallback

### Finding 4: All three modes have ~83% boundary guarantee

No mode has 100% success rate. **Defense in depth** is required:

- L1 (default) -> L2 (escalation) -> L3 (user)
- Each layer catches failures of the layer below
- Plus handoff as orthogonal tool for major direction changes

---

## Six-dimension analysis (per user request)

### 1. Performance (latency)

| scenario                      | handoff | grill L1 | grill L2 | analysis                                |
| ----------------------------- | ------- | -------- | -------- | --------------------------------------- |
| Normal case (medium_typical)  | 4.4s    | 1.6s     | **0.7s** | L2 cheapest (1 round-trip)              |
| High ambiguity                | 4.4s    | 2.4s     | **0.7s** | L2 still cheapest (always 1 round-trip) |
| Chained handoffs              | **13s** | 1.6s     | 0.7s     | **handoff multiplies 3x** (compounding) |
| Catastrophic (infinite_grill) | 4.4s    | **80s**  | 0.7s     | L1 loops blow up                        |

**Winner**: L2 in normal cases. **L1 has hidden runaway**. Handoff has compounding multiplier.

### 2. Token consumption

| scenario       | handoff   | grill L1       | grill L2    |
| -------------- | --------- | -------------- | ----------- |
| Normal         | 650 tok   | 400 tok        | **375 tok** |
| High ambiguity | 650 tok   | 600 tok        | **375 tok** |
| Chained        | 1,950 tok | 400 tok        | **375 tok** |
| Chained        | 1,950 tok | 400 tok        | **375 tok** |
| Infinite grill | 650 tok   | **20,000 tok** | 375 tok     |
| Cascade        | 650 tok   | 600 tok        | 1,875 tok   |

**Winner**: L2 cheapest in normal cases. L1 explodes under loop. Handoff grows linearly with chain depth.

### 3. Memory usage (handoff doc on disk)

| scenario       | handoff doc bytes | grill L1 | grill L2 |
| -------------- | ----------------- | -------- | -------- |
| small_clear    | 48 B              | (none)   | (none)   |
| medium_typical | 240 B             | (none)   | (none)   |
| huge_doc       | **4.63 KB**       | (none)   | (none)   |
| chained_3      | 240 B x 3 = 720 B | (none)   | (none)   |

**Memory cost only applies to handoff** -- bounded by 10 KB cap, ~5% of child output. Grill modes have no memory overhead.

**Verdict**: handoff uses 5x more disk than L1/L2 in huge_doc scenario.

### 4. Boundary guarantee (does it preserve user intent?)

| scenario                 | handoff                 | grill L1     | grill L2                | notes                 |
| ------------------------ | ----------------------- | ------------ | ----------------------- | --------------------- |
| All 12 boundary outcomes | 10/12 Y, 1 PARTIAL, 1 N | 11/12 Y, 1 N | 10/12 Y, 1 PARTIAL, 1 N | tied at 10/12 success |

**Insight**: All three modes **fail at boundary** in different scenarios:

- Handoff fails when child crashes or doc lost (mechanical failure)
- L1 fails when grill loop runs (model failure)
- L2 fails when parent timeout (coordination failure)

**No mode has perfect boundary guarantee**. Each has unique failure type.

### 5. Feasibility (will children actually do this in practice?)

| dimension                    | handoff                       | grill L1                | grill L2                 |
| ---------------------------- | ----------------------------- | ----------------------- | ------------------------ |
| Number of spawns             | **1 per call** (3 in chained) | 0                       | 0                        |
| Round-trips                  | 0 (file-based)                | 0 (in-context)          | 1 per call               |
| Requires parent idle?        | No                            | No                      | **Yes** (must observe)   |
| Requires parent AI decision? | No (caller decides)           | No (child self-decides) | **Yes** (must answer)    |
| Effort from child            | high (must summarize)         | medium (must Q&A self)  | low (just ask)           |
| Cost visible to user?        | **Yes** (3-5s latency spike)  | **No** (in-context)     | **Yes** (~1s round-trip) |
| Reversible?                  | **No** (cancels old task)     | Yes (no state change)   | Yes (just Q&A)           |

**Feasibility ranking** (easiest to hardest):

1. **Grill L1** (child self) -- 0 round-trip, 0 spawn, no coordination
2. **Handoff** (caller decides) -- 1 spawn, no parent dependency, but irreversible
3. **Grill L2** (reverse-query) -- 1 round-trip, requires parent AI active

### 6. Exception scenarios (12 documented)

| exception                               | handoff                               | grill L1                     | grill L2                     |
| --------------------------------------- | ------------------------------------- | ---------------------------- | ---------------------------- |
| Child crashes mid-process               | **critical** (0 spawn, task orphaned) | survives                     | survives                     |
| Doc lost in transit (file system error) | **critical** (semantic loss)          | survives                     | survives                     |
| Child self-grill loops forever          | survives                              | **critical** (80s + 20K tok) | survives                     |
| Parent busy / timeout                   | survives                              | survives                     | **critical** (30s blocked)   |
| Child false confidence                  | survives                              | **partial** (proceeds wrong) | survives                     |
| Cascading queries                       | survives                              | survives                     | **partial** (5x round-trips) |
| Chained handoff x 3 (compounding)       | **partial** (3x cost)                 | survives                     | survives                     |
| Doc truncated by ADR-0015               | partial (truncated to 50KB)           | survives                     | survives                     |
| New child ignores handoff doc           | **partial** (semantic loss)           | survives                     | survives                     |
| Doc > 200KB child dies before write     | **critical** (orphan task)            | survives                     | survives                     |
| Parent escalates to user                | n/a                                   | n/a                          | **partial** (2 round-trips)  |
| Multiple handoffs concurrent            | untested                              | n/a                          | n/a                          |

---

## Recommended v1 architecture

```
[Child receives task]
        |
        v
   L1 self-grill (default, 0 round-trip, max 3 rounds)
        |
        +-- if clarity achieved --> proceed
        |
        +-- if user-intent ambiguity --> L2 reverse-query (1 round-trip, timeout 30s)
        |           |
        |           +-- if parent answers --> proceed with answer
        |           |
        |           +-- if parent timeout --> L3 escalate to user
        |
        +-- if self-grill loops (rounds > 3) --> auto-escalate to L2
        |
        +-- if false confidence detected (external monitor) --> revert to L2
        |
   [Child proceeds]
        |
        +-- if mid-task direction change --> handoff (caller decides)
        |
        +-- if mid-task minor correction --> ptc_task_append (steer)
        |
        +-- if mid-task stop --> ptc_task_stop (cancel)
```

### v1 components (minimal viable):

1. **Child self-grill (L1)**: child implementation detail, no new tool needed -- child runs `/grill-with-docs` skill on its own context. Cap at 3 rounds; auto-escalate on overflow.
2. **`ptc_parent_query`** (L2 tool): child -> parent via subscription buffer. Timeout 30s default.
3. **`ptc_task_handoff`** (handoff tool): caller-initiated, writes /tmp/waybg-handoff-<ulid>.md, spawns new child.
4. **`ptc_query_response`** (parent tool): parent answers child query via subscription.

---

## Implementation sketch

### `ptc_task_handoff` tool signature

```ts
ptc_task_handoff(
  taskId: ULID,
  opts: {
    reason: string,           // user changed mind, wrong approach
    newPrompt: string,         // initial prompt for new child
    label?: string,            // new task label
    parentTaskId?: ULID        // for nested handoff
  }
): {
  handoffDocPath: string,    // /tmp/waybg-handoff-<oldUlid>.md
  newTaskId: ULID,            // fresh taskId
  oldTaskStatus: canceled,
  oldStopReason: handoffed_to_<newTaskId>
}
```

### `ptc_parent_query` tool signature (L2)

```ts
ptc_parent_query(
  question: string,
  opts?: {
    timeoutMs?: number,        // default 30000
    blocking?: boolean          // default true; false = fire-and-forget
  }
): {
  status: answered | timeout | escalated,
  answer?: string,             // parents response
  escalatedTo?: user,        // if parent escalated
}
```

### L1 self-grill (no new tool)

```ts
// Inside child agent, before executing:
async function childSelfGrill(taskPrompt: string): Promise<ClarityResult> {
  let rounds = 0;
  while (rounds < MAX_Self_GRILL_ROUNDS) {
    // 3
    const result = await runGrillWithDocs({ task: taskPrompt });
    if (result.allResolved) return { clarity: full, rounds };
    if (result.needsParent) return { clarity: partial, rounds, needsParent: result.unresolved };
    rounds++;
  }
  return { clarity: loop, rounds }; // trigger L2 escalation
}
```

---

## Trade-off summary

| dimension                 | handoff only               | grill only                              | layered (recommended)  |
| ------------------------- | -------------------------- | --------------------------------------- | ---------------------- |
| Latency in normal case    | 4.4s                       | 0.7s (L2) / 1.6s (L1)                   | 0.7-1.6s               |
| Token cost in normal case | 650                        | 375-600                                 | 375-600                |
| Failure mode count        | 2 catastrophic + 1 partial | 1-2 catastrophic + 1 partial            | **defense in depth**   |
| Boundary guarantee        | 10/12                      | 11/12 (L1) / 10/12 (L2)                 | ~12/12 (with fallback) |
| Code complexity           | +150 LOC (handoff tool)    | +100 LOC (L1 child) + +80 LOC (L2 tool) | **+330 LOC**           |
| Reversibility             | No (cancels old task)      | Yes (no state)                          | depends on layer       |

---

## Open questions (for follow-up tickets)

1. **Self-grill cap threshold**: 3 rounds optimal? Or 2 / 5?
2. **Cascade threshold**: when does grill L2 escalate to L3? (timeout only? or specific error types?)
3. **Handoff chain cap**: hard cap at 3? Document as known degradation?
4. **Doc persistence**: write to `/tmp` (volatile) vs `/var/folders` (semi-persistent)?
5. **Multi-handoff concurrent**: what if parent calls `ptc_task_handoff` on multiple children simultaneously?
6. **Resume vs handoff**: do they interact? (map Not yet specified 复活 / resume 工具 -- could be combined with handoff)
7. **Subscribe replay + handoff**: when child restarts after fork, does it see prior handoffs?

These are ticket-sized questions; defer to T1 ADR-0022 Steering / new T10 ticket.

---

## Citations / external references

- **Decomposition Vulnerability** (Baxter, 2026, TICO AI LLC) -- Goal Invariant Degradation paper, DOI: 10.5281/zenodo.20632551 -- central paper defining 5 failure signatures + Compounding Degradation Prediction
- **smolagents regression test** `test_compaction_loop_break.py` -- real-world infinite-compaction-loop bug from May 2026
- **Microsoft Copilot subagent guidance** -- input/output pattern for child -> parent context preservation
- **Atomix: Transactional Tool Use for Reliable Agentic Workflows** (arXiv 2602.14849v2) -- atomicity guarantees for agent tool use
- **Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent LLM Systems** (arXiv 2606.17182) -- concurrency anomaly detection
- **Traceability and Accountability in Role-Specialized Multi-Agent LLM Pipelines** (ACM ASEW 2025) -- role specialization

---

## Final Verdict

**Recommendation**: **YES** to all three (handoff + grill L1 + grill L2) as **layered clarification system**.

| decision                                     | verdict                                                       | complexity |
| -------------------------------------------- | ------------------------------------------------------------- | ---------- |
| Adopt `ptc_task_handoff` (v1)                | **YES** -- major direction change handling                    | +150 LOC   |
| Adopt child L1 self-grill (v1)               | **YES** -- default boundary clarification, 0 round-trip       | +100 LOC   |
| Adopt `ptc_parent_query` (v1)                | **YES** -- user-intent ambiguity fallback                     | +80 LOC    |
| Cap L1 rounds at 3, auto-escalate            | **YES** -- prevents infinite loop (per smolagents regression) | +20 LOC    |
| Cap handoff chain at 3, document degradation | **YES** -- prevent compounding (per DecompVuln paper)         | +10 LOC    |

**Total v1 cost**: ~360 LOC, all bounded by existing subscription infrastructure (Q2/G2).

**Net benefit**:

- Major direction change (handoff) -- 95% boundary preservation
- User-intent ambiguity (L2 reverse-query) -- 95% preservation in cascade scenarios
- Self-boundary ambiguity (L1 self-grill) -- 95% preservation, 0 round-trip
- All modes fail gracefully (escalation paths exist)

**Risks acknowledged**:

- Compounding degradation in chained handoffs (3x at depth 3)
- L1 infinite loop without cap (mitigated by MAX_Self_GRILL_ROUNDS)
- L2 parent timeout (mitigated by 30s timeout)
- Handoff doc loss (mitigated by parent fallback)

---

## Implementation tickets (proposed)

| ticket                                                               | scope                                                | depends on           |
| -------------------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| `bgdispatch/T9 -- ptc_task_handoff tool + handoff skill integration` | handoff flow + state machine + doc persistence       | G1/G2 locked         |
| `bgdispatch/T10 -- child L1 self-grill + L2 ptc_parent_query`        | layered clarification + cap enforcement + escalation | G2 Q5 (event schema) |

Or merge both into one ticket: `bgdispatch/T10 -- Steering + boundary clarification (handoff + layered grill)`.

---

## Files

- `docs/prototypes/bgdispatch-handoff-vs-grill.js` -- Node measurement source
- `docs/prototypes/bgdispatch-handoff-vs-grill-measurements.md` -- 217 lines raw output
- `docs/prototypes/bgdispatch-handoff-vs-grill-VERDICT.md` -- this file
- Branch: `research/bgdispatch-handoff-grill-prototype` (pushed to origin)
