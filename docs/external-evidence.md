# External evidence

Use `mizzen evidence ingest` to pin test, CI, and benchmark results for a documentation build. A site with `evidence.lock.json` writes `.mizzen/evidence.json` in its build output. The report gives each page claim and behavior a status and an outcome for every cited evidence ID.

## Prepare an envelope

Write a JSON object with these fields.

| Field | Meaning |
| --- | --- |
| `version` | Envelope version, currently `1` |
| `id` | Stable identifier, unique within the lock |
| `kind` | `test`, `ci`, or `benchmark` |
| `origin` | HTTPS URL identifying the source |
| `snapshot` | ID of the product snapshot the result belongs to |
| `executedAt` | Actual execution time in UTC as `YYYY-MM-DDTHH:mm:ssZ` or with three fractional digits |
| `payloadSha256` | Lowercase SHA-256 of the canonical JSON payload encoded as UTF-8 |
| `payload` | Object matching one of the schemas below |

To compute the payload hash, serialize primitives with JSON encoding, preserve array order, sort every object's keys in UTF-16 code-unit order, and omit whitespace outside JSON strings. Hash those bytes without a trailing newline. Mizzen validates this digest before storing the envelope. The digest printed by `ingest` covers the whole canonical envelope with a trailing LF.

A target is an object with `surface` and `behavior` string IDs. Use the same IDs in the evidence producer and the site's lock.

| Kind and payload schema | Payload fields in addition to `schema` |
| --- | --- |
| `test`, `test-json@1` | `results` array of `{suite, name, outcome}` rows and a `catalog` array of `{suite, name, surface, behavior}` rows |
| `test`, `junit@1` | `results` string containing the original JUnit XML and the same `catalog` array |
| `ci`, `ci-run@1` | `runId` and `workflow` strings, full lowercase Git `commit` ID, `configSha256` of the workflow configuration, `artifactSha256` of the original bytes, `outcome`, and `targets` |
| `benchmark`, `benchmark@1` | `metric` and `unit` strings, string-valued `environment` map, `raw` numeric samples, numeric summary `value`, HTTPS `run` URL, and `targets` |

Outcomes are `passed`, `failed`, or `skipped`. For JUnit, Mizzen takes the suite from `testcase@classname` or its containing suite's `name`, defaulting to an empty string. The pair of suite and test name identifies a result. A repeated pair is `duplicate`, a catalog entry absent from the report is `deleted`, and a result absent from the catalog is `unmapped`. Keep the baseline entries in the catalog when detecting deleted tests. A test envelope supports a claim when at least one catalog test maps to its surface and behavior and every mapped test passed.

Hash the actual workflow configuration used for a CI run and pass the original artifact file at ingestion. The lock independently records the expected commit, configuration hash, and artifact hash for the snapshot.

```sh
mizzen evidence ingest test-envelope.json site
mizzen evidence ingest ci-envelope.json site --artifact run-artifact.zip
```

Each command prints a digest. Record it under the corresponding envelope ID in the lock's `pins`. CI pins also need the expected `artifactSha256`. Preserve the pinned files under `site/.mizzen/evidence/` with your build inputs. Transfer that directory and the lock to an offline builder.

## Declare claims and build

Place `evidence.lock.json` alongside `mizzen.yml`. This example uses placeholders for digests and a test envelope with ID `install-tests`.

```json
{
  "version": 1,
  "snapshot": {
    "id": "v1",
    "commit": "<40- or 64-character Git commit ID>",
    "configSha256": "<64-character workflow configuration SHA-256>"
  },
  "maxAgeDays": 14,
  "pins": {
    "install-tests": { "sha256": "<digest printed by ingest>" }
  },
  "surfaces": ["cli:install"],
  "claims": [
    {
      "id": "install-guide",
      "subject": { "kind": "page", "id": "/install/" },
      "surface": "cli:install",
      "behavior": "install",
      "evidence": ["install-tests"]
    },
    {
      "id": "install-behavior",
      "subject": { "kind": "behavior", "id": "install" },
      "surface": "cli:install",
      "behavior": "install",
      "evidence": ["install-tests"]
    }
  ]
}
```

Use the final page URL without the site base for a page subject. A behavior subject's ID must match the claim's `behavior`. Each claim must use a surface from the lock. A CI run or benchmark must declare a matching target to support the claim.

```sh
mizzen build site --out dist --as-of 2026-11-23
```

Use a fixed `--as-of YYYY-MM-DD` or set `asOf` in the site configuration. A matching result is fresh through `maxAgeDays` after its UTC execution day. The report marks older results `stale` and gives `unverified` reasons for future, missing, incompatible, or unrelated evidence. A claim is `verified` when at least one cited result verifies it. A missing or changed pinned file fails the build before it replaces the previous output, including on a warm cache.

The public report includes test names, CI run metadata, and benchmark summaries with the linked raw run. Benchmark summaries appear only for measurements that verify a claim. Keep sensitive test names and run links out of the published evidence. Raw artifacts and benchmark samples stay in the local store. Treat the lock as a trusted build input and derive its expected hashes from your producer or CI configuration.
