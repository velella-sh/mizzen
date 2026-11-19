# Determinism and performance of the 0.2.6 release

This page records the measured cost of the release build, one context pack, one edit transaction with its proof, and
one trace replay on a fixed snapshot. It also states the budget a regression must stay under. The numbers are from the
release branch at the candidate commit, on one machine; they are not a promise for other hardware.

## Fixed snapshot

| Input | Recorded value |
| --- | --- |
| Compatibility site | `fixtures/compat-0.2.4/site`, built with `fixtures/compat-0.2/theme` (197 public files) |
| Context task | `fixtures/context-compiler/task.json` against `fixtures/context-compiler`, blocks lock `fc3b5deb…d6b7` |
| Edit transaction | two files, one single-line patch each, `requireBeforeHash` and `validateContent` on |
| Trace | `fixtures/traces/release-trace.json`, SHA-256 `2fdc167e6182b62f68e003e10319fc81a4a8b8ba528293fd7de92bf9485d2d32` |
| Engine | `0.2.6`, Node 24, macOS arm64 |

Reproduce a run with `/usr/bin/time -l`:

```sh
/usr/bin/time -l node bin/mizzen.ts build fixtures/compat-0.2.4/site --out /tmp/out --theme fixtures/compat-0.2/theme
/usr/bin/time -l node bin/mizzen.ts pack fixtures/context-compiler --task fixtures/context-compiler/task.json --format json
/usr/bin/time -l node bin/mizzen.ts edit transaction tx.json /tmp/project --format json
/usr/bin/time -l node bin/mizzen.ts trace replay fixtures/traces/release-trace.json
```

## Measured results

Three runs each; wall clock in seconds, peak resident memory in MiB for the whole Node process.

| Operation | Run 1 | Run 2 | Run 3 | Median time | Peak memory | Budget |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Build (197 files) | 0.75 | 0.40 | 0.40 | 0.40 | 223 MiB | 2.0 s, 400 MiB |
| Pack (`--task`, 12k tokens) | 0.52 | 0.47 | 0.47 | 0.47 | 213 MiB | 1.5 s, 400 MiB |
| Edit transaction + proof | 0.45 | 0.47 | 0.40 | 0.45 | 209 MiB | 1.5 s, 400 MiB |
| Trace replay (5 events) | 0.42 | 0.41 | 0.42 | 0.42 | 209 MiB | 1.0 s, 400 MiB |

Most of the resident memory is the Node process itself (about 170 MiB before the site is read), so the budget is
expressed for the process, not for the site alone. A run over the budget is a regression to investigate, not a hard
failure of the suite.

## Determinism

- Two builds of the same input give byte-identical files; `test/build-determinism.test.ts` and
  `test/compat-0.2.5.test.ts` compare the bytes.
- Two graph queries over the same snapshot give the same JSON, including the snapshot id; the `graph` acceptance case
  asserts it.
- The reference evaluation suite gives the same report bytes on the same pins; a changed pin is
  `incomparable`, not a regression (`test/evals-baseline.test.ts`).
- Trace replay is read-only and reports a difference instead of writing; `test/release-security.test.ts` hashes the
  working folder before and after.
- No clock, network, or unordered map enters these paths. Timings in a trace are separated from replay.

## Live-model metrics

The engine ships no model client and the release gate never calls one. The opt-in live adapter
(`src/evals/live.ts`, `test/evals-live.test.ts`) and its scheduled workflow are outside the engine, so their latency and
token cost are not part of this release and are not measured here. A live run must report its own model, endpoint,
and cost beside this table; treating it as engine performance would hide the difference.

## Limits

- One machine, three runs: enough to catch a regression of the order measured, not a microbenchmark.
- The build fixture is 197 public files. A much larger site should scale with page count and output size; re-measure
  before raising the budget.
- Pagefind and social-image work are included in the build time but not isolated here.
