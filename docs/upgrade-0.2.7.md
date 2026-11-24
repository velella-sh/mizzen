# Contracts and upgrade steps for 0.2.7

`0.2.7` adds contracts that let a site show what the product exposes, which behavior and evidence back each claim,
why a decision was made, what other repositories know, and whether a published site is what its publisher attested.
An existing `0.2.6` site needs no content migration: each contract is read only when you create its input.

Every schema is in `schema/` of the installed package and carries a `$id` under `https://velella.sh/mizzen/schema/`.
Each reports a `version` (or `format`) of `1`. A later change that adds a required field raises that number; a reader
must reject a version it does not know instead of guessing.

## Surface

- **Schema:** `surface-report.schema.json`. **Entry point:** `mizzen surface [dir] --json`.
- **Migration:** none. The report reads your package entry point, CLI, config schema, OpenAPI document, or public
  data fields. Add `--baseline <file>` to gate on coverage and `--min <percent>` to fail below a threshold.
- **Check:** an internal symbol or a duplicate re-export never appears as a gap.

## Behavior

- **Schema:** `behavior-report.schema.json`. **Entry point:** `mizzen behavior [dir] --json`.
- **Migration:** add `behavior` front matter to the page that documents a behavior: a stable id, a normative
  statement, the surface it describes, its tests, and its evidence. Pages without it are unchanged.
- **Check:** a behavior with a missing surface item, test file, or evidence pin is reported `unverified` with a reason.

## Evidence

- **Schemas:** `evidence-envelope.schema.json`, `evidence-lock.schema.json`, `evidence-report.schema.json`.
  **Entry point:** `mizzen evidence ingest <envelope.json> [dir]`, then `mizzen build --as-of <date>`.
- **Migration:** produce one envelope per test, CI, or benchmark result; `ingest` validates it and prints the digest to
  pin in `evidence.lock.json`. A build with a lock writes `.mizzen/evidence.json`; a build without one is unchanged.
  See [External evidence](external-evidence.md).
- **Check:** a changed payload, commit, or artifact hash is rejected, and a pinned envelope that is missing or edited
  fails the build before it replaces the previous output.

An envelope; its `payloadSha256` covers the canonical JSON of `payload`:

<!-- schema: evidence-envelope -->
```json
{
  "version": 1,
  "kind": "test",
  "id": "install-tests",
  "origin": "https://ci.example/evidence",
  "snapshot": "v1",
  "executedAt": "2026-11-20T02:23:01Z",
  "payloadSha256": "2b5cb8c9cdb4de1fd6b53b6ba00b8b96a86ec879bec962d8d9b00d6dc5d2f69f",
  "payload": {
    "schema": "test-json@1",
    "catalog": [{ "suite": "cli", "name": "install", "surface": "cli:install", "behavior": "install" }],
    "results": [{ "suite": "cli", "name": "install", "outcome": "passed" }]
  }
}
```

The lock that pins it, with one page claim:

<!-- schema: evidence-lock -->
```json
{
  "version": 1,
  "snapshot": { "id": "v1", "commit": "0123456789abcdef0123456789abcdef01234567", "configSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  "maxAgeDays": 14,
  "pins": { "install-tests": { "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } },
  "surfaces": ["cli:install"],
  "claims": [
    {
      "id": "install-guide",
      "subject": { "kind": "page", "id": "/install/" },
      "surface": "cli:install",
      "behavior": "install",
      "evidence": ["install-tests"]
    }
  ]
}
```

## Decisions

- **Schema:** `decision-report.schema.json`. **Entry point:** `mizzen decisions [dir]` and
  `mizzen decisions why <subject>`.
- **Migration:** write decision records with an id, title, status, rationale, alternatives, and the behaviors they
  explain. Private rationale is replaced with a placeholder in the public report.
- **Check:** a superseded or rejected decision is shown as such, never as the current one.

## Federation

- **Schemas:** `federation-lock.schema.json`, `knowledge-bundle.schema.json`.
  **Entry point:** `mizzen federation fetch|status|graph|query|pack|chain|resolve`.
- **Migration:** declare the projects in a federation manifest, run `federation fetch` once with network access to pin
  each bundle by SHA-256, and commit the lock. Builds and queries then read only the lock and the pinned bytes.
- **Check:** with the network off, a missing bundle is reported by project and an optional one carries its reason.

## Propagation

- **Schemas:** `propagation-manifest.schema.json`, `propagation-ledger.schema.json`.
  **Entry point:** `mizzen propagate check|diff|propose`.
- **Migration:** a consumer declares what it depends on in a manifest. A run proposes downstream tasks only; it never
  edits, merges, or publishes in another repository, and a replay does not duplicate a task.

## Attestation

- **Schema:** `site-attestation.schema.json`. **Entry points:** `mizzen published-site attest <bundle> <provenance.json>
  [--key <private.pem>]` and `mizzen published-site verify <bundle> <attestation.json> <trust-policy.json>`.
- **Migration:** none for an unsigned build. To attest, write the provenance and allowlisted public evidence, sign with
  an Ed25519 key, and give consumers a trust policy that names the site, formats, minimum evidence, and keys. Format `1`
  allows no extra field.
- **Check:** verification runs offline and exits `1` when a page or an evidence file changed.

Every example above is validated against its schema by `test/upgrade-guide.test.ts`; the schemas themselves are checked
against the real CLI output by `test/evidence-attestation-schemas.test.ts` and the contract tests named in
`release/scope.json`.
