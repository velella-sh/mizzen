# Transforming data

A collection's `transform` key rewrites every record before it is validated and published. The rules are data
configuration, not code: they keep the source file as the system of record and give the site a stable, validated shape.

```yaml
collections:
  products:
    source: data/products.yml
    id: sku
    transform:
      steps:
        - id: price-number
          op: cast
          field: price
          to: number
        - id: price-cents
          op: unit
          field: price
          factor: 100
          round: 0
        - id: drop-internal
          op: remove
          fields: [warehouse, cost]
```

A collection without `transform` publishes its records exactly as the source writes them. Adding the key is opt-in,
and the output of an unchanged site does not move.

## Order

`steps` run in the order they are written. Each step reads the record the step before it wrote, so a `cast` followed by
a `unit` multiplies a number, and a `rename` followed by `normalize` normalizes the new path. A step that meets an
absent path does nothing, so a rule can target only the records that have the field.

`id` names the rule in diagnostics and events. Without it the rule is `step-<position>`, counting from 1.

## Operators

Every step has an `op`. The other keys are the ones that operator reads; other keys are ignored.

| `op` | Keys | What it does |
| --- | --- | --- |
| `select` | `fields` | Keep only the named dot paths, such as `author.name`; every other field is left out. |
| `remove` | `fields` | Remove the named dot paths; every other field keeps its value and position. |
| `rename` | `from`, `to`, `onConflict` | Move a value. `onConflict` is `error` (default: report the destination and leave the record) or `overwrite`. |
| `default` | `field`, `value`, `when` | Fill a field. `when` is `missing` (default), `null`, or `missing-or-null`; zero is never missing. |
| `cast` | `field`, `to` | Convert to `string`, `number`, `integer`, or `boolean`. A value that cannot reach the type is a diagnostic naming the record. |
| `normalize` | `field`, `trim`, `case` | Trim (default true) and write `lower`, `upper`, or `none` (default). Casing is locale-independent; Unicode whitespace is trimmed. |
| `map` | `field`, `values`, `unknown`, `default` | Replace a recognized value written as text. `unknown` is `keep` (default), `error`, or `default`. |
| `date` | `field`, `format`, `timezone`, `output` | Read `YYYY`, `MM`, `DD`, `HH`, `mm`, and `ss` with literal separators in an IANA zone. `output` is `iso` (default) or `date`. |
| `unit` | `field`, `factor`, `round` | Multiply a finite number or numeric string by `factor`, then round to `round` decimal places. |
| `filter` | `where` | Keep records that match every condition. A list value matches any item; an absent path does not match. |
| `dedupe` | `by`, `keep` | Keep one record per composite key; `keep` is `first` (default) or `last`, in source order. |

A path is a dot path into nested mappings: `author.name`. A record's top-level field positions are kept through the
rules, so a diagnostic still points at the data file line to edit.

Date conversion never reads the clock or the host time zone. The format and the configured zone decide the instant, so
two machines and two environments write the same string.

## Validation

Records are usually validated once, after every rule, so a rule may repair a raw value the schema would reject.
`validate: before-and-after` adds a second pass over the raw record:

```yaml
transform:
  validate: before-and-after
  steps:
    - op: cast
      field: price
      to: number
```

The raw finding has id `data.record-invalid-input` and the record is still transformed. The output finding has id
`data.record-invalid-output`, skips the record, and names the step that last touched the failing field. A collection
with `transform` and no schema has no validation pass.

## Events and the build key

Every field a rule changed is reported to an internal consumer as an event with the rule id, the input path, the output
path, and both values. `mizzen data transform --json` prints them; a programmatic `loadCollections` caller can pass
`onTransformEvent`.

The rules live in the loaded config, which is part of both the whole-build key and the per-page render settings key.
Changing a rule therefore refreshes the affected output, and an incremental build writes the same bytes as a full one.

## Preview

`mizzen data transform [name] [dir] --limit 5 --json` loads the site exactly as a build does and prints a sample of the
records each collection's rules produce, plus every finding. It writes nothing: no cache, no lock, no output folder.
Without `name`, it previews every collection that declares rules. The command exits `1` when a finding is an error.

## Comparing two rule versions

`mizzen data transform-diff <baseline> <proposed> [dir] [--collection <name>] [--format text|json] [--check]`
runs two configurations over the same collection input and reports what the rules would change. The baseline is
usually `mizzen.yml`; put the proposed file beside it, such as `rules/price-cents.yml`.

The command records the path and SHA-256 of each config and of the input, and refuses to compare when the two
configs read different input bytes: both versions must see the same locked input. It writes nothing — no lock, cache,
or output folder.

Records align by id and appear as `+` added, `-` removed, or `~` changed. Each changed field prints both values, with
`missing` kept apart from `null`, and a type change shown as `number 7 -> string "7"`. The steps that last wrote the
field are named per side, such as `(baseline price-cents (unit), proposed price-cents (unit))`; when no step wrote it,
the report says `unknown: no transformation step wrote this field`. Affected outputs come from the dependency graph
of the changed records, the same impact report a build uses.

A transform or validation error on either side is listed with its side and stage (`transform`, `validation-input`,
`validation-output`) and sets `complete: no`. Exit codes are `0` unchanged (or compared without `--check`), `1` a
record difference under `--check`, and `2` an invalid target or an incomplete comparison. An invalid target is a
config, collection, or input that cannot be read, or two inputs whose hashes differ.

### Reviewing a unit-conversion change

Change `factor` in a copy of the config, keep the baseline, and compare the two:

```bash
cp mizzen.yml rules/price-cents.yml
# edit factor in rules/price-cents.yml
mizzen data transform-diff mizzen.yml rules/price-cents.yml . --collection products
mizzen data transform-diff mizzen.yml rules/price-cents.yml . --collection products --format json --check
```

```text
rule diff: products
baseline mizzen.yml (sha256 4251eddbd581)
proposed rules/price-cents.yml (sha256 871461a59ff0)
input _data/products.yml (sha256 c071d5585ad9)
complete: yes
records: 0 added, 0 removed, 1 changed; 1 fields; 1 affected outputs

~ products/bolt
  ~ price: number 1200 -> number 12000 (baseline price-cents (unit), proposed price-cents (unit))

affected outputs:
  /products/bolt/ (page) [bolt]
```

The first command exits `0`; the second exits `1` because the record changed. Neither writes
`mizzen.lock.json`: reviewing a rule version does not move the project lock or the source data.
