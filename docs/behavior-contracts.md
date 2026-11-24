# Product behavior contracts

Status: implemented for 0.2.7 (`027-behavior-contracts`, #1316, #1347 to #1356). This note fixes the reference
contract.

A product behavior is a normative statement of what the product does, tied to the public surface it describes, the
tests that prove it, the evidence that supports it, the versions it passed through, and the environments it covers.
Two axes stay apart: the **support status** is authored (what the product promises), and the **verification status**
is computed (what the evidence policy can prove). A supported behavior without the evidence its status requires is
`unverified`, never `verified`.

## The behavior record

A page declares one behavior with the `behavior` front matter key, as one mapping or a list of mappings:

```yaml
---
title: Greeting
behavior:
  - id: greet.returns-name
    title: Greeting returns the supplied name
    normative: A greeting includes the supplied name.
    status: supported
    versions:
      introduced: 1.0.0
      changed: [1.4.0]
    surface: ["symbol:greet", "command:greet"]
    environments:
      - os: linux
        runtime: node>=24
    tests:
      - file: test/greet.test.ts
        name: greet returns the name
        outcome: passed
    evidence:
      - url: https://ci.example.org/runs/4821
        kind: ci
        title: CI run 4821
    public: true
---
```

Every record carries:

| Field | Meaning |
| --- | --- |
| `id` | The stable identity, unique across the site and unchanged by a source move. |
| `title` | A short human title. |
| `normative` | The normative statement the tests and evidence must support. |
| source span | The exact `behavior` entry, not the whole front matter; a finding points at the entry. |
| `status` | `supported`, `experimental`, `deprecated`, or `removed`. |
| `versions` | `introduced` (required), and optionally `changed`, `deprecated`, `removed`. |
| `replacement` | The behavior that replaces a deprecated or removed one, when specified. |
| `environments` | `os`, `language`, or `runtime` limits; empty means everywhere. |
| `surface` | Public-surface item ids the behavior describes. |
| `tests` | Test files, optional names, and the outcome each test is expected to have. |
| `evidence` | Public `https:` or `/path` links, or ids pinned in `evidence.lock.json`. |
| `public` | `false` keeps the whole behavior out of public output. |

A duplicate `id` is rejected with every source location named, such as
`Behavior id "greet.returns-name" is declared more than once, at docs/a.md:4:5-14:20 and docs/b.md:4:5-14:20.`
An entry with any malformed field is rejected whole; the other entries on the page are kept.

## Public surface links

`surface` names the same ids `mizzen surface` inventories: `symbol:greet`, `command:build`, `config-key:title`,
`operation:getPet`, and the rest. Each link resolves to the item's area, kind, stability, declaration span, and
signature. A link that the surface no longer publishes is `missing`, is counted in `coverage.surface.missing`, and
leaves the behavior unverified with `missing-surface`. A changed signature is behavior drift.

## Tests and expected outcomes

Each test names a repository-relative file and an expected `outcome`. The file must exist, and when a `name` is given
the text must appear in it. A behavior with no test, a missing file, a name the file does not contain, or a found test
whose expected outcome is not `passed` is unverified (`missing-test` or `nonpassing-test`). The report records the
file's SHA-256, so a changed test is drift.

## Evidence policy

The policy is published in every report under `policy` and shown here:

| Status | Tests | Evidence | Evidence kinds |
| --- | --- | --- | --- |
| `supported` | 1 | 1 | `test`, `ci`, `benchmark` |
| `experimental` | 1 | 0 | `test`, `ci`, `benchmark` |
| `deprecated` | 0 | 1 | `test`, `ci`, `benchmark`, `document` |
| `removed` | 0 | 0 | — |

An evidence entry is resolved when it is an `https:` URL or a root-relative path, or when its `id` is pinned in
`.mizzen/evidence.lock.json`. A document link does not satisfy a `supported` claim. An unresolved reference is
`unresolved-evidence`; a missing required kind is `missing-evidence`. Verification reasons appear in this fixed order:
`missing-surface`, `missing-test`, `nonpassing-test`, `missing-evidence`, `unresolved-evidence`,
`invalid-replacement`.

## Versions, statuses, and replacements

`versions.introduced` is required. `changed` lists versions in which the behavior changed. A `deprecated` behavior
needs `versions.deprecated`; a `removed` behavior needs `versions.removed`. Versions must be at or after the
introduction, and a removal must not precede a deprecation. A `supported` or `experimental` behavior cannot already
name a deprecated or removed version.

`replacement` is allowed only on a deprecated or removed behavior. It must name a declared behavior, cannot name
itself, cannot name a removed behavior, and must not form a cycle; every invalid link is rejected and the behavior is
unverified with `invalid-replacement`.

A versioned query returns the contract at that product version:

```bash
mizzen behavior site --version 2.1.0 --status deprecated --json
```

A behavior introduced after the query is absent; at or after its removal version it is returned as `removed`; at or
after its deprecation version it is `deprecated`; otherwise it is `supported` or `experimental`. Each returned record
carries `statusAtVersion`.

## Environments

A behavior with no `environments` applies everywhere. Otherwise each result is scoped to the environments it covers,
and an environment names at least one of `os`, `language`, or `runtime`. A query matches when every dimension it names
agrees with one declared environment; a dimension the declaration leaves out covers every value on that dimension.
`mizzen behavior site --os linux --runtime node` returns only behaviors that cover both.

## Behavior drift

Comparing two reports keys on the stable behavior id. A change to any linked surface signature, surface item
presence, test file or expected outcome, evidence reference or pinned digest, or the behavior contract itself
(title, normative statement, status, versions, replacement, environments, or page) flags that behavior. The drift
entry shows the documentation and the tests together:

```json
{
  "behavior": "greet.returns-name",
  "kinds": ["signature"],
  "documentation": { "title": "Greeting returns the supplied name", "normative": "...", "source": { "...": "..." }, "page": { "...": "..." } },
  "surface": { "before": [{ "item": "symbol:greet", "signature": "function greet(name:string): string" }], "after": [{ "item": "symbol:greet", "signature": "function greet(name:string, lang:string): string" }] },
  "tests": { "before": [{ "file": "test/greet.test.ts", "outcome": "passed", "state": "found" }], "after": [{ "file": "test/greet.test.ts", "outcome": "passed", "state": "found" }] },
  "evidence": { "before": [], "after": [] }
}
```

`test/behavior-drift.test.ts` changes only `greet`'s signature and proves that `farewell` is unchanged.

## Public matrix

A site with any behavior writes two files:

- `behavior.json`, the versioned report validated by `schema/behavior-report.schema.json`;
- `behavior/index.html`, a self-contained matrix with one row per public behavior: id and source span, title and
  normative statement, documentation link, support status, version history, environments, surface links, tests,
  evidence links, and verification.

Every evidence URL is an `https:` address or a root-relative path written under the site `base`. A behavior with
`public: false` and an evidence entry with `public: false` are removed before either file is written; private
behaviors appear only as the `coverage.private` count, and a private evidence value is replaced with
`{ "kind": ..., "state": ..., "redacted": true }`. The page is deterministic: rows sort by id, text is escaped, and no
clock, random id, or theme asset is read.

## Decision Memory integration

The stable reference another feature stores is:

```ts
interface BehaviorReference {
  readonly kind: "behavior";
  readonly id: string;
  readonly version?: string;
}
```

Two functions make the public lookup shape explicit:

```ts
behaviorReferenceOf(record, version?): BehaviorReference;
queryBehaviors(report, { version?, status?, environment? }): {
  version: 1;
  query: BehaviorQuery;
  behaviors: BehaviorRecord[];   // each with statusAtVersion when version is set
};
lookupBehavior(report, reference): BehaviorRecord | undefined;
```

A decision can store the reference and resolve it against the behavior report at the version it was made for. The
lookup returns the same stable id, the support status at that version, the normative statement, and the public
surface, test, and evidence links, so a Decision Memory consumer never parses a page or guesses a source path.

## CLI and output

```bash
mizzen behavior [dir] --json --version <v> --status <s> \
  --os <os> --language <language> --runtime <runtime> \
  --baseline <file> --out <file> --min-verified <percent>
```

The text form prints the counts, every unverified behavior with its reasons, the structural findings, and an optional
drift comparison. `--min-verified` exits `1` below the verified percentage. The `behavior` output is switched off by
`outputs.behavior: false` like any other output. Tests: `test/behavior-contract.test.ts`,
`test/behavior-report.test.ts`, `test/behavior-drift.test.ts`, `test/behavior-matrix.test.ts`,
`test/behavior-cli.test.ts`, and the `behavior-contracts` acceptance case.
