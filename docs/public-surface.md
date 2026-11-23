# Public surface coverage

Status: implemented for 0.2.7 (`027-public-surface-coverage`, #1315, #1337 to #1346). This note fixes the reference
contract.

A product publishes a surface: the TypeScript symbols a package exports, the CLI's commands and flags, the
configuration keys it reads, the OpenAPI operations it serves, the data fields it publishes, and the versions it
carries. Every one of those is something a reader may depend on, so every one needs documentation. Mizzen inventories
the surface, matches it to the documentation, and reports what is documented, what is only half documented, and what is
missing — by area and by version.

## The adapter contract

An adapter reads one area and returns a versioned result. It is rejected whole when it is not the contract's shape, so a
report never counts an item an adapter did not actually read (#1337, #1338).

```ts
interface SurfaceAdapterResult {
  readonly version: 1;
  readonly area: "api" | "cli" | "config" | "openapi" | "data" | "version";
  readonly items: readonly SurfaceItem[];   // sorted by id
  readonly findings: readonly SurfaceFinding[];
}

interface SurfaceItem {
  readonly id: string;              // `<kind>:<name>`, stable across releases and source moves
  readonly area: SurfaceArea;
  readonly kind: SurfaceItemKind;   // symbol, command, argument, flag, config-key, operation, ...
  readonly name: string;
  readonly source: SourcePos;       // the exact place the item is declared
  readonly stability: "stable" | "experimental" | "deprecated" | "removed";
  readonly signature?: string;
  readonly parent?: string;
  readonly version?: { introduced: string; deprecated?: string; removed?: string; successor?: string };
}
```

`validateAdapterResult` checks the version, the area, the item shape, and a duplicate id, and throws
`SurfaceContractError` with every problem when the result is not the contract. A caller that catches it gets no items,
never the valid prefix.

## The built-in adapters

| Issue | Area | What it reads |
| --- | --- | --- |
| #1338 | `api` | The package entry point's exports and their signatures, from `surface.package`. Internal symbols and duplicate re-exports are dropped; `@deprecated` and `@experimental` in the declaration's JSDoc set the stability. |
| #1339 | `cli` | The running CLI: every command in `COMMANDS`, the subcommands, arguments, and options in the help, cross-checked against `parseArgs`. A command the help omits, a help line `COMMANDS` does not register, an unreachable command, and a flag accepted but not described are findings. |
| #1340 | `config` | Every key of `schema/config.schema.json` with its type and default, checked against the real resolver. A schema default the resolver does not apply is a finding. |
| #1341 | `openapi` | Each operation, parameter, and response of the pinned OpenAPI document, with the operation's own `operationId` as its stable id and `deprecated` kept on the operation and every parameter. |
| #1342 | `data` | Each collection and the fields its public policy allows. A field `public` or `raw.private` keeps private is never an item, so it never appears in the coverage. |
| #1345 (input) | `version` | Each data API version the config declares, with a deprecated version's sunset and successor. |

A site may add its own adapter for any area under `surface.adapters`.

## Documentation evidence and state

A page documents an item through a link whose text or target names it, inline code that names it (`build`,
`mizzen build`, `--report`), a `:field[…]`/`:::each{field=…}` directive that names a data field, or a `file:line` code
reference that points at the item's declaration (#1343). A heading that names the item only in prose is **weak**
evidence.

- **complete**: at least one strong reference;
- **partial**: only weak references;
- **missing**: no reference at all.

## Gaps and exclusions

Every item that is not `complete` is a gap that names its kind, id, source, and introduction version (#1344). An item
the config excludes carries a reason instead, is counted in `excluded`, is left out of `total`, and never appears as a
gap. A documented exclusion is therefore never mistaken for missing documentation.

```yaml
surface:
  package: src/index.ts
  docs: ["."]
  exclude:
    - id: command:internal
      reason: Not part of the public CLI; documented in AGENTS.md.
  minCoverage: 80
```

## Comparing versions

`mizzen surface --baseline <file>` compares two reports by item id and names the items added, removed, newly documented,
and no longer documented (#1345). Because the comparison keys on the id and never on the source file or line, renaming a
file or moving a declaration is not a change: a file rename alone never causes a coverage regression.

## Output

The report appears in three places, with the same counts and percentages by `api`, `cli`, `config`, `openapi`, `data`,
and `version` (#1346):

- `mizzen surface --json` prints the versioned report, validated by `schema/surface-report.schema.json`;
- `mizzen check` reports every adapter finding, so a drift fails CI the way any other diagnostic does;
- the `surface` output writes `surface.json`, and each page's `index.json` carries a `surface` summary — the counts, the
  gap total, and the exclusion total — when the config declares `surface`.

A fixture with a new public item and no documentation reports the expected gap; `test/surface-coverage.test.ts` proves
it end to end.
