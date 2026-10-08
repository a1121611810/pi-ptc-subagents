# bgdispatch/G2 v3 -- Handoff vs Grill-with-docs head-to-head
# seed=42 deterministic; 12 scenarios

## Scenarios

| 1 | small_clear | 60 tasks, all <=2KB, no boundary issues | ambiguity=0 |
| 2 | medium_typical | 60 tasks realistic dist, normal boundary | ambiguity=2 |
| 3 | high_ambiguity | 60 tasks realistic, heavy boundary ambiguity | ambiguity=5 |
| 4 | huge_doc | 60 huge tasks (>50KB each) | ambiguity=2 |
| 5 | chained_3 | 60 tasks with 3x chained handoffs | ambiguity=2 |
| 6 | burst_100 | 100 tasks burst + handoff | ambiguity=2 |
| 7 | child_crashes | Child crashes mid-handoff | ambiguity=2 |
| 8 | doc_lost | Handoff doc lost in transit | ambiguity=2 |
| 9 | infinite_grill | Child grills itself forever | ambiguity=5 |
| 10 | parent_timeout | Parent never answers query (busy) | ambiguity=5 |
| 11 | false_confidence | Child thinks resolved but wrong | ambiguity=3 |
| 12 | cascading_q5 | 5-level cascading queries | ambiguity=5 |

## Per-scenario: Handoff vs Grill-Self vs Grill-Reverse

### small_clear -- 60 tasks, all <=2KB, no boundary issues

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,345 ms | 0 ms | 700 ms | 4345.0x |
| total tokens | 531 | 0 | 375 | 2122.0x |
| handoff doc bytes | 48.650000000000006 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 0 | 1 | - |
| errors | (clean) | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### medium_typical -- 60 tasks realistic dist, normal boundary

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 1,600 ms | 700 ms | 2.7x |
| total tokens | 650 | 400 | 375 | 1.6x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | (clean) | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### high_ambiguity -- 60 tasks realistic, heavy boundary ambiguity

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 2,400 ms | 700 ms | 1.8x |
| total tokens | 650 | 600 | 375 | 1.1x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 3 | 1 | - |
| errors | (clean) | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### huge_doc -- 60 huge tasks (>50KB each)

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,814 ms | 1,600 ms | 700 ms | 3.0x |
| total tokens | 3,464 | 400 | 375 | 8.7x |
| handoff doc bytes | 4.63 KB | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | (clean) | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### chained_3 -- 60 tasks with 3x chained handoffs

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 13,092 ms | 1,600 ms | 700 ms | 8.2x |
| total tokens | 1,950 | 400 | 375 | 4.9x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 3 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | compounding_degradation_x3 | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### burst_100 -- 100 tasks burst + handoff

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 1,600 ms | 700 ms | 2.7x |
| total tokens | 650 | 400 | 375 | 1.6x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | (clean) | (clean) | (clean) | - |
| success | Y | Y | Y | - |

### child_crashes -- Child crashes mid-handoff

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 1,080 ms | 1,600 ms | 700 ms | 0.7x |
| total tokens | 500 | 400 | 375 | 1.3x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 0 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | child_crashed_before_handoff_complete | (clean) | (clean) | - |
| success | N | Y | Y | - |

### doc_lost -- Handoff doc lost in transit

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 1,600 ms | 700 ms | 2.7x |
| total tokens | 900 | 400 | 375 | 2.3x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 2 | 1 | - |
| errors | handoff_doc_lost_in_transit | (clean) | (clean) | - |
| success | N | Y | Y | - |

### infinite_grill -- Child grills itself forever

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 80,000 ms | 700 ms | 0.1x |
| total tokens | 650 | 20,000 | 375 | 0.0x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 100 | 1 | - |
| errors | (clean) | infinite_self_grill_loop | (clean) | - |
| success | Y | N | Y | - |

### parent_timeout -- Parent never answers query (busy)

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 2,400 ms | 30,000 ms | 1.8x |
| total tokens | 650 | 600 | 375 | 1.1x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 3 | 1 | - |
| errors | (clean) | (clean) | parent_query_timeout | - |
| success | Y | Y | N | - |

### false_confidence -- Child thinks resolved but wrong

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 2,400 ms | 700 ms | 1.8x |
| total tokens | 650 | 600 | 375 | 1.1x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 3 | 1 | - |
| errors | (clean) | self_grill_false_confidence | (clean) | - |
| success | Y | Y | Y | - |

### cascading_q5 -- 5-level cascading queries

| metric | handoff | grill L1 (self) | grill L2 (reverse-query) | ratio (handoff/grillL1) |
|---|---|---|---|---|
| total latency | 4,364 ms | 2,400 ms | 3,500 ms | 1.8x |
| total tokens | 650 | 600 | 1,875 | 1.1x |
| handoff doc bytes | 240.10000000000002 B | (n/a) | (n/a) | - |
| child boots | 1 | 0 | 0 | - |
| rounds | n/a | 3 | 1 | - |
| errors | (clean) | (clean) | cascading_queries_x5 | - |
| success | Y | Y | N | - |

## Aggregate (across 12 scenarios)

| metric | handoff | grill L1 (self) | grill L2 (reverse) |
|---|---|---|---|
| sum latency | 58,243 ms | 99,200 ms | 40,500 ms |
| sum tokens | 11,894 | 24,800 | 6,000 |
| success count | 10/12 | 11/12 | 10/12 |

## Error modes observed

| scheme | scenario | error |
|---|---|---|
| handoff | chained_3 | compounding_degradation_x3 |
| handoff | child_crashes | child_crashed_before_handoff_complete |
| handoff | doc_lost | handoff_doc_lost_in_transit |
| grillL1 | infinite_grill | infinite_self_grill_loop |
| grillL2 | parent_timeout | parent_query_timeout |
| grillL1 | false_confidence | self_grill_false_confidence |
| grillL2 | cascading_q5 | cascading_queries_x5 |

## Boundary guarantee analysis

| scenario | ambiguity | handoff preserves intent | grill self | grill reverse |
|---|---|---|---|---|
| small_clear | 0 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| medium_typical | 2 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| high_ambiguity | 5 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| huge_doc | 2 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| chained_3 | 2 | PARTIAL (chain degradation) | Y (self-grill resolves) | Y (parent answered) |
| burst_100 | 2 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| child_crashes | 2 | Y (handoff doc captures) | Y (self-grill resolves) | Y (parent answered) |
| doc_lost | 2 | N (doc lost) | Y (self-grill resolves) | Y (parent answered) |
| infinite_grill | 5 | Y (handoff doc captures) | N (loop) | Y (parent answered) |
| parent_timeout | 5 | Y (handoff doc captures) | Y (self-grill resolves) | N (parent timeout) |
| false_confidence | 3 | Y (handoff doc captures) | PARTIAL (false confidence) | Y (parent answered) |
| cascading_q5 | 5 | Y (handoff doc captures) | Y (self-grill resolves) | PARTIAL (cascade) |

## Feasibility (will children be required to do this in practice?)

| scenario | handoff cost | grill L1 cost | grill L2 cost |
|---|---|---|---|
| small_clear | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| medium_typical | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| high_ambiguity | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| huge_doc | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| chained_3 | high (3x chained, ~10s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| burst_100 | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| child_crashes | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| doc_lost | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| infinite_grill | low (1 spawn, ~3.5s) | infinite (broken) | medium (~700ms, 1 round-trip) |
| parent_timeout | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| false_confidence | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | medium (~700ms, 1 round-trip) |
| cascading_q5 | low (1 spawn, ~3.5s) | very low (0-2.4s, 0 spawns) | very high (5x round-trip) |
