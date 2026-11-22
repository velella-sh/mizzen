# Verifiable publishing

Publish a built site with a detached attestation so consumers can verify the
same files offline. Sign the exact directory you intend to distribute after
the build and any post-processing have finished.

## Attest a build

Use a dedicated Ed25519 key. Keep the private key, build provenance input,
and detached attestation outside the bundle directory.

```sh
openssl genpkey -algorithm ED25519 -out site-private.pem
openssl pkey -in site-private.pem -pubout -out site-public.pem
mizzen build ./site --out ./bundle
mizzen published-site attest ./bundle provenance.json --key site-private.pem > attestation.json
```

The publisher supplies the metadata from the build. Use the full source commit,
the identifier of the input snapshot, the actual Mizzen and theme versions, and
the build day in `YYYY-MM-DD`.

```json
{
  "site": "docs.example",
  "sourceCommit": "22e04def142c69dbf8278aee9b23d2c29bc8e29d7",
  "snapshot": "docs-v42",
  "engine": "0.2.7",
  "theme": { "name": "@velella/lateen", "version": "0.2.4" },
  "builtOn": "2026-11-22",
  "publicEvidence": {
    "snapshot": "docs-v42",
    "paths": ["evidence/test-results.json"]
  }
}
```

The evidence manifest lists only the explicitly allowed public evidence paths
and their SHA-256 hashes. Use an empty `paths` array for a build without public
evidence. Each listed path must be in the bundle, and the evidence snapshot
must match the build snapshot. Review the bundle itself before publishing it.
Attestation records relative file names and hashes and copies only the listed
provenance fields. It does not copy file contents, private metadata, or keys.

All regular files in the directory contribute to the attestation's bundle
hash, including HTML, Markdown, JSON, data, evidence, and Mizzen metadata.
Keep the directory stable while attesting or verifying it. Symbolic links
and other special entries cause verification to fail. Omitting `--key`
produces an attestation with algorithm `none` and a null signature.

## Verify a bundle offline

Obtain the signer's public key through a channel you trust. Store its complete
PEM text as a string in a local trust policy. The `\n` escapes in JSON
represent line breaks in the PEM.

```json
{
  "site": "docs.example",
  "snapshot": "docs-v42",
  "formats": [1],
  "keys": ["-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4UMLqA0MHVQsQ16G8TJ/HVVznnZP7yh+eFL9CKwNJsI=\n-----END PUBLIC KEY-----\n"],
  "minimumEvidence": 1,
  "unsigned": "reject",
  "freshness": { "notBefore": "2026-11-01", "stale": "reject" }
}
```

Replace the example public key with the trusted key for the site.

```sh
mizzen published-site verify ./bundle attestation.json trust-policy.json
```

- `site` pins the site identity. Optional `snapshot` pins the exact input snapshot.
- `formats` lists permitted attestation versions. This implementation reads version 1.
- `keys` supplies the permissible Ed25519 public keys. A signed attestation
  requires a matching key and a valid signature.
- `minimumEvidence` sets the minimum number of evidence files. Each entry
  must belong to the attested snapshot and match both the file manifest and
  the bundle bytes.
- `unsigned: "reject"` requires signer authentication. With `"allow"`, the
  report warns that the provenance is unauthenticated and still checks file
  integrity and the rest of the policy.
- Optional `freshness` compares the claimed build day to the supplied
  earliest acceptable date. An older build fails with `stale: "reject"`
  and produces a warning with `"allow"`. The verifier uses no clock or network.

The JSON report includes `ok`, `issues`, and `warnings`. Each finding has a
`code`, `path`, and `message`. Examples include `file-added`,
`file-missing`, `file-changed`, `evidence-changed`, `evidence-detached`,
and `evidence-snapshot-mismatch`. Exit codes are `0` for a passing policy,
`1` for a rejected bundle or attestation, and `2` for invalid CLI input or
trust policy. A successful signature authenticates the publisher's metadata
and file hashes. Consumers decide which signers and snapshots to trust.

## Version 1 wire format

The detached JSON has `payload` and `signature`. The payload contains
`format`, the six provenance fields from the example, `build` with
`hash` and `files`, `evidence` with `snapshot` and `files`, and
`signing` with `algorithm` and, for Ed25519, `keyId`. Both file maps
key SHA-256 digests by bundle-relative paths with slash separators.

The bundle hash is SHA-256 of lines in path order. Each line consists of path,
one NUL byte, lowercase hex SHA-256 of the file contents, and one LF byte.
The signing adapter signs the UTF-8 prefix `mizzen-site-attestation`, one NUL
byte, and the compact JSON payload whose object keys are sorted recursively by
UTF-16 code unit. Ed25519 signatures use standard padded Base64. The signer ID
is lowercase hex SHA-256 of the DER-encoded SubjectPublicKeyInfo public key.
