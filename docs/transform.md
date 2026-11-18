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
