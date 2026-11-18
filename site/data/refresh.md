---
title: Refreshing data in CI
description: Fetch and validate changed source data, review the counts and output impact, and build offline from the locked result.
layout: doc
permalink: /data/refresh/
---

# Refreshing data in CI

A data site can refresh its locked sources on a schedule and ask a person to review the result. `mizzen data refresh`
does the fetch and validation; a small workflow does the branch, commit, and pull request.

```bash
mizzen data refresh [dir] --collections <a,b> --report <file> [--json]
```

`--collections` limits the run, and every other lock entry stays as it was. `--report` is required and receives a
`mizzen-refresh/1` document with counts, added and removed record ids, changed ids, the lock hashes, the validation
result, and the stage that failed. `--json` prints the same document to stdout.

Exit `0` is changed or unchanged, `1` is a failed stage, and `2` is a usage error. Validation failure restores the
previous `mizzen.lock.json`, so a bad source never replaces the last healthy lock.

The report never holds an environment value or a credential, and its paths are relative to the site.

## Changed, unchanged, and failed

Start the fixture service with one of three scenarios:

```bash
SCENARIO=changed   node fixtures/refresh-ci/service.mjs
SCENARIO=unchanged node fixtures/refresh-ci/service.mjs
SCENARIO=failed    node fixtures/refresh-ci/service.mjs
```

A changed run writes the lock and reports the new records. An unchanged run reports the same lock hash and makes no
commit or pull request. A failed run exits `1`, names the failed stage, and leaves the previous lock in place.

## The workflow

Copy [`docs/recipes/refresh-data.yml`](https://github.com/velella-sh/mizzen/blob/main/docs/recipes/refresh-data.yml)
to `.github/workflows/refresh-data.yml`. It accepts `workflow_dispatch` and `schedule`, and a manual run may set the
comma-separated collection filter.

The jobs are split by permission:

- a read-only **refresh** job fetches and validates, uploads the report and one input package;
- a read-only **build** job builds the base and refreshed sites from the package and writes the output impact with
  `mizzen diff`;
- a write **propose** job imports the package, commits only `mizzen.lock.json` and `.mizzen/data/`, and creates or
  updates one pull request.

`concurrency` is one fixed group per repository, so two runs cannot update the same lock or review branch at once.
The branch is fixed, so a later run updates its open pull request rather than opening a duplicate. The report and
package artifacts are named with `github.run_id`, which is also written to the run summary: a failure leaves the run
number, stage, and report available.

See [the full refresh note](https://github.com/velella-sh/mizzen/blob/main/docs/refresh-ci.md) for the report fields,
the allowlist check, and the fixture.
