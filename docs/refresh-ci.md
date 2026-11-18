# Refreshing locked data in CI

`mizzen data refresh` fetches selected collection sources, validates the result, and writes one structured report.
It is the read-only half of a refresh workflow: a separate job commits the lock and opens the review pull request.

```bash
mizzen data refresh [dir] --collections <a,b> --report <file> [--json]
```

- `--collections` limits the run to those collections. Every other lock entry and snapshot stays exactly as it was,
  so two filtered runs can update different parts of one lock.
- `--report` is required and receives the `mizzen-refresh/1` JSON document, even when a stage fails.
- `--json` prints the same report to stdout instead of the human lines.

Exit `0` means changed or unchanged, `1` means a failed stage, and `2` means a usage error. A failed run restores the
previous `mizzen.lock.json` bytes before it returns; the content-addressed store may keep an extra blob, which a later
build ignores.

## The report

The report is deterministic and contains no timestamp, absolute path, environment value, or credential:

```json
{
  "schema": "mizzen-refresh/1",
  "status": "changed",
  "stage": "done",
  "collections": ["items"],
  "lock": { "file": "mizzen.lock.json", "before": "…", "after": "…", "restored": false },
  "sources": [{ "source": "https://data.example/items", "collections": ["items"], "status": "changed" }],
  "changes": {
    "collections": [
      { "name": "items", "before": 2, "after": 3, "added": ["c"], "removed": [], "changed": ["a"] }
    ],
    "totals": { "before": 2, "after": 3, "added": 1, "removed": 0, "changed": 1 }
  },
  "validation": {
    "diagnostics": [],
    "quality": { "findings": 0, "warnings": 0, "errors": 0 }
  },
  "errors": []
}
```

`stage` is `config`, `fetch`, `validate`, `quality`, or `done`. A failure keeps the diagnostics and the errors that
explain it. A source's status is `new`, `changed`, or `unchanged`. The lock hashes are SHA-256 hex, or `null` when the
file did not exist.

## The sample workflow

[`docs/recipes/refresh-data.yml`](recipes/refresh-data.yml) copies to `.github/workflows/refresh-data.yml`. It:

1. runs `data refresh` in a job with `contents: read`;
2. exports the refreshed inputs as one package, so a later job needs no source service;
3. builds the base and the refreshed site in a second `contents: read` job, imports the package, and writes the output
   impact from `mizzen diff`;
4. imports the package in the only job with `contents: write` and `pull-requests: write`, commits only
   `mizzen.lock.json` and `.mizzen/data/`, and creates or edits one pull request.

The job names in `git add` and the allowlist check are the boundary: a changed template, source file, or config is
never committed by a refresh run. The report and the package are uploaded as artifacts named with `github.run_id`, so a
failed run still leaves the run number, stage, and report. The previous lock is untouched in the repository because
nothing is committed on failure.

`concurrency.group` is one fixed group per repository with `cancel-in-progress: false`, so two runs cannot update the
same lock or review branch at once. The review branch is fixed (`mizzen/refresh-data`). A second run for the same
project and source force-pushes that branch and edits its open pull request instead of creating another one.

The manual trigger carries the collection filter through `inputs.collections`; the scheduled trigger supplies an empty
value and refreshes every collection.

## Changed, unchanged, and failed runs

`fixtures/refresh-ci/` has a loopback service and a site. Start the service in one terminal:

```bash
SCENARIO=unchanged node fixtures/refresh-ci/service.mjs
SCENARIO=changed   node fixtures/refresh-ci/service.mjs
SCENARIO=failed    node fixtures/refresh-ci/service.mjs
```

Then run:

```bash
npx mizzen data refresh fixtures/refresh-ci/site --report /tmp/refresh.json
```

- **Changed:** the first run, or a change to the records, writes the lock and reports `changed`.
- **Unchanged:** the same bytes report `unchanged`, and the sample workflow makes no commit and no pull request.
- **Failed:** the `failed` service returns HTTP 500; the command exits `1`, reports stage `fetch`, and the lock stays as
  it was.

A schema error stops at stage `validate` and a quality-rule error at stage `quality`, both before the proposal job
starts. `test/refresh-ci.test.ts` exercises those cases, the filtered lock, the credential-free report, and a build
that reads the refreshed lock with `fetch` disabled.

## Limits

- A refresh validates the whole site, not only the selected collections: a merge must leave the site buildable.
- A package carries raw source bytes; keep the artifact private.
- The sample workflow installs Mizzen and the theme with `npm install`; the source service is contacted only by the
  refresh job.
