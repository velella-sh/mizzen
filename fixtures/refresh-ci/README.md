# Refresh CI fixture

A small data site used by `test/refresh-ci.test.ts` and by the `docs/recipes/refresh-data.yml` sample workflow.
The collection is a JSON API on the loopback interface, so a run never reaches the public internet.

## Run it by hand

Start the service in one terminal. It serves one of three scenarios:

```bash
SCENARIO=unchanged node fixtures/refresh-ci/service.mjs   # one record, matching a fresh lock
SCENARIO=changed   node fixtures/refresh-ci/service.mjs   # two records, one changed and one added
SCENARIO=failed    node fixtures/refresh-ci/service.mjs   # HTTP 500
```

In another terminal, with the site at `fixtures/refresh-ci/site`:

```bash
npx mizzen data refresh fixtures/refresh-ci/site --report /tmp/refresh.json
npx mizzen data refresh fixtures/refresh-ci/site --collections items --report /tmp/refresh.json
```

The first run writes `mizzen.lock.json` and `.mizzen/data/`, and reports `changed`. A second run against
`SCENARIO=unchanged` reports `unchanged`. A run against `SCENARIO=failed` reports `failed` and leaves the lock as it
was.

The report is the only file a CI job needs to read:

```json
{
  "schema": "mizzen-refresh/1",
  "status": "changed",
  "stage": "done",
  "changes": { "totals": { "before": 1, "after": 2, "added": 1, "removed": 0, "changed": 1 } }
}
```

`mizzen data refresh` writes only `mizzen.lock.json` and its content-addressed store. A pull request should add only
those paths; the sample recipe enforces that before it commits.
