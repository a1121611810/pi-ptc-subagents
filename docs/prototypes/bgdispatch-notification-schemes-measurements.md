# bgdispatch/G2 Notification Scheme Measurements

# seed=42 deterministic; 25 cells = 5 dists x 5 counts

## Head-to-head matrix (winner marked with *)

| dist                   | count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map | winner | total RT |
| ---------------------- | ----- | --------- | ------------ | -------------- | ------------- | ------ | -------- |
| small (<=2K)           | 20    | 23.39 KB  | 25.34 KB     | 23.39 KB       | 3.91 KB       | D      | 20       |
| small (<=2K)           | 60    | 73.83 KB  | 79.69 KB     | 73.83 KB       | 11.72 KB      | D      | 60       |
| small (<=2K)           | 100   | 122.10 KB | 131.87 KB    | 122.10 KB      | 19.53 KB      | D      | 100      |
| small (<=2K)           | 200   | 254.70 KB | 274.24 KB    | 254.70 KB      | 39.06 KB      | D      | 200      |
| small (<=2K)           | 500   | 638.34 KB | 687.17 KB    | 638.34 KB      | 97.66 KB      | D      | 500      |
| small+med (80/20)      | 20    | 33.99 KB  | 22.78 KB     | 20.83 KB       | 3.91 KB       | D      | 26       |
| small+med (80/20)      | 60    | 114.66 KB | 70.17 KB     | 64.31 KB       | 11.72 KB      | D      | 84       |
| small+med (80/20)      | 100   | 188.42 KB | 116.02 KB    | 106.25 KB      | 19.53 KB      | D      | 138      |
| small+med (80/20)      | 200   | 382.45 KB | 240.87 KB    | 221.34 KB      | 39.06 KB      | D      | 266      |
| small+med (80/20)      | 500   | 1.003 MB  | 585.19 KB    | 536.36 KB      | 97.66 KB      | D      | 700      |
| realistic (60/25/10/5) | 20    | 42.63 KB  | 19.89 KB     | 17.93 KB       | 3.91 KB       | D      | 34       |
| realistic (60/25/10/5) | 60    | 153.24 KB | 56.16 KB     | 50.30 KB       | 11.72 KB      | D      | 115      |
| realistic (60/25/10/5) | 100   | 250.31 KB | 93.24 KB     | 83.47 KB       | 19.53 KB      | D      | 188      |
| realistic (60/25/10/5) | 200   | 506.86 KB | 190.68 KB    | 171.15 KB      | 39.06 KB      | D      | 369      |
| realistic (60/25/10/5) | 500   | 1.202 MB  | 477.51 KB    | 428.68 KB      | 97.66 KB      | D      | 973      |
| large (30/70)          | 20    | 41.86 KB  | 5.86 KB      | _3.91 KB_      | 3.91 KB       | C      | 80       |
| large (30/70)          | 60    | 101.58 KB | 17.58 KB     | _11.72 KB_     | 11.72 KB      | C      | 240      |
| large (30/70)          | 100   | 157.30 KB | 29.30 KB     | _19.53 KB_     | 19.53 KB      | C      | 400      |
| large (30/70)          | 200   | 310.59 KB | 58.59 KB     | _39.06 KB_     | 39.06 KB      | C      | 800      |
| large (30/70)          | 500   | 738.48 KB | 146.48 KB    | _97.66 KB_     | 97.66 KB      | C      | 2000     |
| burst (70/20/7/3)      | 20    | 37.15 KB  | 22.10 KB     | 20.14 KB       | 3.91 KB       | D      | 28       |
| burst (70/20/7/3)      | 60    | 128.82 KB | 64.07 KB     | 58.21 KB       | 11.72 KB      | D      | 100      |
| burst (70/20/7/3)      | 100   | 217.11 KB | 104.46 KB    | 94.70 KB       | 19.53 KB      | D      | 164      |
| burst (70/20/7/3)      | 200   | 424.31 KB | 219.37 KB    | 199.84 KB      | 39.06 KB      | D      | 316      |
| burst (70/20/7/3)      | 500   | 1.029 MB  | 547.08 KB    | 498.25 KB      | 97.66 KB      | D      | 827      |

## Aggregate by distribution (avg bytes across counts)

| dist                   | A. Tiered | B. Reference | C. Map+preview | D. Strict Map |
| ---------------------- | --------- | ------------ | -------------- | ------------- |
| small (<=2K)           | 222.47 KB | 239.66 KB    | 222.47 KB      | 34.38 KB      |
| small+med (80/20)      | 349.37 KB | 207.01 KB    | 189.82 KB      | 34.38 KB      |
| realistic (60/25/10/5) | 436.82 KB | 167.49 KB    | 150.31 KB      | 34.38 KB      |
| large (30/70)          | 269.96 KB | 51.56 KB     | 34.38 KB       | 34.38 KB      |
| burst (70/20/7/3)      | 372.32 KB | 191.42 KB    | 174.23 KB      | 34.38 KB      |

## Aggregate by task count (avg bytes across dists)

| count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map |
| ----- | --------- | ------------ | -------------- | ------------- |
| 20    | 35.80 KB  | 19.19 KB     | 17.24 KB       | 3.91 KB       |
| 60    | 114.43 KB | 57.53 KB     | 51.67 KB       | 11.72 KB      |
| 100   | 187.05 KB | 94.98 KB     | 85.21 KB       | 19.53 KB      |
| 200   | 375.78 KB | 196.75 KB    | 177.22 KB      | 39.06 KB      |
| 500   | 937.88 KB | 488.69 KB    | 439.86 KB      | 97.66 KB      |

## Win count (out of 25 cells)

A. Tiered: 0 wins (0%)
B. Reference: 0 wins (0%)
C. Map+preview: 5 wins (20%)
D. Strict Map: 20 wins (80%)

## Average per scheme (across all cells)

| scheme         | avg bytes | avg tokens | avg RT |
| -------------- | --------- | ---------- | ------ |
| A. Tiered      | 330.19 KB | 84,528     | 43.5   |
| B. Reference   | 171.43 KB | 43,885     | 64.8   |
| C. Map+preview | 154.24 KB | 39,485     | 64.8   |
| D. Strict Map  | 34.38 KB  | 8,800      | 176.0  |

## Ratio: each scheme vs C. Map+preview (lower = C wins by more)

| scheme                    | bytes ratio | RT ratio |
| ------------------------- | ----------- | -------- |
| A. Tiered                 | 2.14x       | 0.67x    |
| B. Reference              | 1.11x       | 1.00x    |
| C. Map+preview (baseline) | 1.00x       | 1.00x    |
| D. Strict Map             | 0.22x       | 2.72x    |

## Does advantage scale? (realistic dist, varying count)

| count | A. Tiered | B. Reference | C. Map+preview | D. Strict Map | A/C   | B/C   |
| ----- | --------- | ------------ | -------------- | ------------- | ----- | ----- |
| 20    | 42.63 KB  | 19.89 KB     | 17.93 KB       | 3.91 KB       | 2.38x | 1.11x |
| 60    | 153.24 KB | 56.16 KB     | 50.30 KB       | 11.72 KB      | 3.05x | 1.12x |
| 100   | 250.31 KB | 93.24 KB     | 83.47 KB       | 19.53 KB      | 3.00x | 1.12x |
| 200   | 506.86 KB | 190.68 KB    | 171.15 KB      | 39.06 KB      | 2.96x | 1.11x |
| 500   | 1.202 MB  | 477.51 KB    | 428.68 KB      | 97.66 KB      | 2.87x | 1.11x |

## D (Strict Map) penalty vs C (Map+preview) - is the inline preview worth it?

| dist                   | count | C bytes   | D bytes  | D-C diff  | D/C   | C RT | D RT | extra RT from strict |
| ---------------------- | ----- | --------- | -------- | --------- | ----- | ---- | ---- | -------------------- |
| small (<=2K)           | 20    | 23.39 KB  | 3.91 KB  | -19948 B  | 0.17x | 0    | 20   | +20 RT               |
| small (<=2K)           | 60    | 73.83 KB  | 11.72 KB | -63598 B  | 0.16x | 0    | 60   | +60 RT               |
| small (<=2K)           | 100   | 122.10 KB | 19.53 KB | -105031 B | 0.16x | 0    | 100  | +100 RT              |
| small (<=2K)           | 200   | 254.70 KB | 39.06 KB | -220817 B | 0.15x | 0    | 200  | +200 RT              |
| small (<=2K)           | 500   | 638.34 KB | 97.66 KB | -553658 B | 0.15x | 0    | 500  | +500 RT              |
| small+med (80/20)      | 20    | 20.83 KB  | 3.91 KB  | -17325 B  | 0.19x | 3    | 20   | +17 RT               |
| small+med (80/20)      | 60    | 64.31 KB  | 11.72 KB | -53849 B  | 0.18x | 12   | 60   | +48 RT               |
| small+med (80/20)      | 100   | 106.25 KB | 19.53 KB | -88802 B  | 0.18x | 19   | 100  | +81 RT               |
| small+med (80/20)      | 200   | 221.34 KB | 39.06 KB | -186653 B | 0.18x | 33   | 200  | +167 RT              |
| small+med (80/20)      | 500   | 536.36 KB | 97.66 KB | -449237 B | 0.18x | 100  | 500  | +400 RT              |
| realistic (60/25/10/5) | 20    | 17.93 KB  | 3.91 KB  | -14365 B  | 0.22x | 6    | 20   | +14 RT               |
| realistic (60/25/10/5) | 60    | 50.30 KB  | 11.72 KB | -39505 B  | 0.23x | 23   | 60   | +37 RT               |
| realistic (60/25/10/5) | 100   | 83.47 KB  | 19.53 KB | -65478 B  | 0.23x | 37   | 100  | +63 RT               |
| realistic (60/25/10/5) | 200   | 171.15 KB | 39.06 KB | -135256 B | 0.23x | 73   | 200  | +127 RT              |
| realistic (60/25/10/5) | 500   | 428.68 KB | 97.66 KB | -338968 B | 0.23x | 197  | 500  | +303 RT              |
| large (30/70)          | 20    | 3.91 KB   | 3.91 KB  | 0 B       | 1.00x | 20   | 20   | +0 RT                |
| large (30/70)          | 60    | 11.72 KB  | 11.72 KB | 0 B       | 1.00x | 60   | 60   | +0 RT                |
| large (30/70)          | 100   | 19.53 KB  | 19.53 KB | 0 B       | 1.00x | 100  | 100  | +0 RT                |
| large (30/70)          | 200   | 39.06 KB  | 39.06 KB | 0 B       | 1.00x | 200  | 200  | +0 RT                |
| large (30/70)          | 500   | 97.66 KB  | 97.66 KB | 0 B       | 1.00x | 500  | 500  | +0 RT                |
| burst (70/20/7/3)      | 20    | 20.14 KB  | 3.91 KB  | -16627 B  | 0.19x | 4    | 20   | +16 RT               |
| burst (70/20/7/3)      | 60    | 58.21 KB  | 11.72 KB | -47606 B  | 0.20x | 17   | 60   | +43 RT               |
| burst (70/20/7/3)      | 100   | 94.70 KB  | 19.53 KB | -76968 B  | 0.21x | 28   | 100  | +72 RT               |
| burst (70/20/7/3)      | 200   | 199.84 KB | 39.06 KB | -164632 B | 0.20x | 50   | 200  | +150 RT              |
| burst (70/20/7/3)      | 500   | 498.25 KB | 97.66 KB | -410212 B | 0.20x | 138  | 500  | +362 RT              |
