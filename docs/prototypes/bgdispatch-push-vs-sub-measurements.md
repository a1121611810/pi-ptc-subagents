# bgdispatch/G2 - Push vs Subscription head-to-head

# seed=42 deterministic; 12 scenarios

## Scenarios

| #   | scenario         | desc                                           | tasks |
| --- | ---------------- | ---------------------------------------------- | ----- |
| 1   | steady_60        | 60 tasks over 10min, AI always idle            | 60    |
| 2   | burst_100        | 100 tasks complete in 1s, AI idle after 5s     | 100   |
| 3   | super_burst_500  | 500 tasks in 5s, AI idle after 10s             | 500   |
| 4   | ai_busy_5min     | 50 tasks complete during 5-min AI tool loop    | 50    |
| 5   | restart          | AI crashes at 5min, restart at 11min           | 60    |
| 6   | fork             | Session forks at 5min (both branches continue) | 60    |
| 7   | stop_spike       | 50 tasks; stop called on 15 mid-flight         | 50    |
| 8   | ptc_off          | 30 tasks; /ptc off from 2-8min                 | 30    |
| 9   | cadence_pressure | 60 tasks complete during 12-min AI idle        | 60    |
| 10  | mixed_500        | 500 tasks over 10min (scale test)              | 500   |
| 11  | zombie_60        | 60 tasks; 10% never complete                   | 60    |
| 12  | slow_fast        | 1 super-slow (10min) + 50 fast burst           | 51    |

## Per-scenario: PUSH vs SUB

### steady_60 - 60 tasks over 10min, AI always idle

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 47.98 KB | 47.98 KB | 1.00x            |
| wake count         | 60       | 60       | 1.00x            |
| max backlog/buffer | 0        | 0        | 0.00x            |
| cadence injections | 0        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 60/60    | 60/60    | -                |
| p50 latency        | 307 ms   | 330 ms   | -                |
| p99 latency        | 991 ms   | 993 ms   | -                |

### burst_100 - 100 tasks complete in 1s, AI idle after 5s

| metric             | PUSH       | SUB       | ratio (PUSH/SUB) |
| ------------------ | ---------- | --------- | ---------------- |
| total bytes        | 59.20 KB   | 79.42 KB  | 0.75x            |
| wake count         | 12         | 1         | 12.00x           |
| max backlog/buffer | 100        | 100       | 1.00x            |
| cadence injections | 12         | 0         | -                |
| poll count         | n/a        | 0         | -                |
| delivered          | 72/100     | 100/100   | -                |
| p50 latency        | 419,620 ms | 29,556 ms | -                |
| p99 latency        | 719,396 ms | 29,996 ms | -                |

### super_burst_500 - 500 tasks in 5s, AI idle after 10s

| metric             | PUSH       | SUB       | ratio (PUSH/SUB) |
| ------------------ | ---------- | --------- | ---------------- |
| total bytes        | 56.11 KB   | 404.32 KB | 0.14x            |
| wake count         | 12         | 1         | 12.00x           |
| max backlog/buffer | 500        | 500       | 1.00x            |
| cadence injections | 12         | 0         | -                |
| poll count         | n/a        | 0         | -                |
| delivered          | 72/500     | 500/500   | -                |
| p50 latency        | 419,612 ms | 27,593 ms | -                |
| p99 latency        | 719,342 ms | 29,967 ms | -                |

### ai_busy_5min - 50 tasks complete during 5-min AI tool loop

| metric             | PUSH       | SUB       | ratio (PUSH/SUB) |
| ------------------ | ---------- | --------- | ---------------- |
| total bytes        | 41.30 KB   | 39.82 KB  | 1.04x            |
| wake count         | 6          | 0         | 6.00x            |
| max backlog/buffer | 38         | 8         | 4.75x            |
| cadence injections | 11         | 0         | -                |
| poll count         | n/a        | 10        | -                |
| delivered          | 50/50      | 50/50     | -                |
| p50 latency        | 283,443 ms | 16,803 ms | -                |
| p99 latency        | 398,148 ms | 29,796 ms | -                |

### restart - AI crashes at 5min, restart at 11min

| metric             | PUSH       | SUB       | ratio (PUSH/SUB) |
| ------------------ | ---------- | --------- | ---------------- |
| total bytes        | 39.77 KB   | 47.98 KB  | 0.83x            |
| wake count         | 30         | 30        | 1.00x            |
| max backlog/buffer | 17         | 4         | 4.25x            |
| cadence injections | 7          | 0         | -                |
| poll count         | n/a        | 11        | -                |
| delivered          | 49/60      | 60/60     | -                |
| p50 latency        | 689 ms     | 962 ms    | -                |
| p99 latency        | 199,276 ms | 28,961 ms | -                |

### fork - Session forks at 5min (both branches continue)

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 47.98 KB | 47.98 KB | 1.00x            |
| wake count         | 60       | 60       | 1.00x            |
| max backlog/buffer | 0        | 0        | 0.00x            |
| cadence injections | 0        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 60/60    | 60/60    | -                |
| p50 latency        | 307 ms   | 330 ms   | -                |
| p99 latency        | 991 ms   | 993 ms   | -                |

### stop_spike - 50 tasks; stop called on 15 mid-flight

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 39.82 KB | 39.82 KB | 1.00x            |
| wake count         | 50       | 50       | 1.00x            |
| max backlog/buffer | 0        | 0        | 0.00x            |
| cadence injections | 0        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 50/50    | 50/50    | -                |
| p50 latency        | 569 ms   | 569 ms   | -                |
| p99 latency        | 991 ms   | 991 ms   | -                |

### ptc_off - 30 tasks; /ptc off from 2-8min

| metric             | PUSH      | SUB       | ratio (PUSH/SUB) |
| ------------------ | --------- | --------- | ---------------- |
| total bytes        | 28.16 KB  | 27.47 KB  | 1.02x            |
| wake count         | 13        | 13        | 1.00x            |
| max backlog/buffer | 4         | 2         | 2.00x            |
| cadence injections | 6         | 0         | -                |
| poll count         | n/a       | 12        | -                |
| delivered          | 30/30     | 30/30     | -                |
| p50 latency        | 15,435 ms | 3,377 ms  | -                |
| p99 latency        | 60,251 ms | 22,366 ms | -                |

### cadence_pressure - 60 tasks complete during 12-min AI idle

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 48.08 KB | 47.98 KB | 1.00x            |
| wake count         | 59       | 59       | 1.00x            |
| max backlog/buffer | 1        | 0        | 1.00x            |
| cadence injections | 1        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 60/60    | 60/60    | -                |
| p50 latency        | 427 ms   | 482 ms   | -                |
| p99 latency        | 987 ms   | 987 ms   | -                |

### mixed_500 - 500 tasks over 10min (scale test)

| metric             | PUSH      | SUB       | ratio (PUSH/SUB) |
| ------------------ | --------- | --------- | ---------------- |
| total bytes        | 405.18 KB | 404.32 KB | 1.00x            |
| wake count         | 492       | 436       | 1.13x            |
| max backlog/buffer | 1         | 0         | 1.00x            |
| cadence injections | 8         | 0         | -                |
| poll count         | n/a       | 0         | -                |
| delivered          | 500/500   | 500/500   | -                |
| p50 latency        | 0 ms      | 468 ms    | -                |
| p99 latency        | 898 ms    | 991 ms    | -                |

### zombie_60 - 60 tasks; 10% never complete

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 41.74 KB | 41.74 KB | 1.00x            |
| wake count         | 54       | 54       | 1.00x            |
| max backlog/buffer | 0        | 0        | 0.00x            |
| cadence injections | 0        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 54/60    | 54/60    | -                |
| p50 latency        | 366 ms   | 366 ms   | -                |
| p99 latency        | 991 ms   | 991 ms   | -                |

### slow_fast - 1 super-slow (10min) + 50 fast burst

| metric             | PUSH     | SUB      | ratio (PUSH/SUB) |
| ------------------ | -------- | -------- | ---------------- |
| total bytes        | 41.06 KB | 41.06 KB | 1.00x            |
| wake count         | 51       | 51       | 1.00x            |
| max backlog/buffer | 0        | 0        | 0.00x            |
| cadence injections | 0        | 0        | -                |
| poll count         | n/a      | 0        | -                |
| delivered          | 51/51    | 51/51    | -                |
| p50 latency        | 0 ms     | 0 ms     | -                |
| p99 latency        | 0 ms     | 0 ms     | -                |

## Edge case verdict (issues per scheme)

| scenario         | PUSH issues                                               | SUB issues     |
| ---------------- | --------------------------------------------------------- | -------------- |
| steady_60        | (clean)                                                   | (clean)        |
| burst_100        | backlog=100; 12 cadence; p99 719,396 ms; 28 undelivered;  | buffer=100;    |
| super_burst_500  | backlog=500; 12 cadence; p99 719,342 ms; 428 undelivered; | buffer=500;    |
| ai_busy_5min     | backlog=38; 11 cadence; p99 398,148 ms;                   | buffer=8;      |
| restart          | backlog=17; 7 cadence; p99 199,276 ms; 11 undelivered;    | (clean)        |
| fork             | (clean)                                                   | (clean)        |
| stop_spike       | (clean)                                                   | (clean)        |
| ptc_off          | 6 cadence; p99 60,251 ms;                                 | (clean)        |
| cadence_pressure | 1 cadence;                                                | (clean)        |
| mixed_500        | 8 cadence;                                                | (clean)        |
| zombie_60        | 6 undelivered;                                            | 6 undelivered; |
| slow_fast        | (clean)                                                   | (clean)        |

## Aggregate (across all 12 scenarios)

| metric                        | PUSH      | SUB      |
| ----------------------------- | --------- | -------- |
| sum bytes                     | 896.35 KB | 1.240 MB |
| sum wake count                | 899       | 815      |
| sum cadence injections        | 57        | 0        |
| sum poll count                | n/a       | 33       |
| max backlog/buffer worst-case | 500       | 500      |
