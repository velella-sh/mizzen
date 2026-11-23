---
title: Explicit unknowns
description: "Declare what a page or record does not establish, limit the claim to a surface, behavior, platform, or version, and keep the status through the graph, context packs, proofs, and evaluations."
---

# Explicit unknowns

Documentation that says nothing about a case and documentation that says the case is *unknown* are different things. Mizzen makes the difference explicit: an author can declare that a page, a record, or one of its fields is `unknown`, `unsupported`, `unverified`, `not-applicable`, or `out-of-scope`, and the status travels into the graph, the context packs an agent reads, the proofs a task rests on, and the evaluation that answers a question.

## The five statuses

Each status has its own meaning and its own schema value. A subject that declares nothing is `missing`, which is never one of the five.

| Status | Means |
| --- | --- |
| `unknown` | Nothing establishes the answer either way. The engine never presents it as known. |
| `unsupported` | The engine or the site cannot represent or perform the thing at all — different from not knowing it. |
| `unverified` | A claim exists but no evidence has confirmed it. |
| `not-applicable` | The question does not apply to this subject, because it has no such facet. |
| `out-of-scope` | The answer is known to sit outside what this site declares it is responsible for. |

The taxonomy is `schema/knowledge-status.schema.json`.

## Declare a status on a page

Write a `knowledge` block in front matter. The declaration keeps its exact source span, so every finding points at the line it was written on.

```yaml
---
title: Windows support
knowledge:
  status: unknown
  scope:
    - platform:windows
  rationale: The maintainers have not tested Windows and will not claim it works.
  citation:
    value: https://github.com/example/repo/issues/42
    public: true
  expires: 2026-06-01
---
```

- `status`: one of the five statuses. A block with no `status` is read as `unknown`.
- `scope`: a list of `surface`, `behavior`, `platform`, or `version` limits, written `kind:value` or as `{ kind, value }`. Empty means the claim applies everywhere.
- `rationale`: why the subject has this status. Private unless `public: true`.
- `citation`: where the evidence is, written as a string or `{ value, public }`. A private value is redacted in public output.
- `expires`: a `YYYY-MM-DD` day after which the declaration must be reviewed.
- `evidence`: the evidence the declaration was written against; when the current value differs, the declaration needs review.
- `public`: `true` publishes the rationale.

A value outside the five statuses, an unknown scope dimension, or a date that is not a real day is refused with a diagnostic at the declaration's span.

## Declare a status on a collection field

Name the record field that holds a declaration in the collection's `knowledge` key. The field is read once, then dropped from the record's fields, so no page, feed, API response, or download can publish it.

```yaml
collections:
  hardware:
    source: _data/hardware.yml
    knowledge: support
```

```yaml
# _data/hardware.yml
- id: printer-200
  name: Printer 200
  support:
    status: unsupported
    scope: [platform:windows]
```

Usage is checked by `mizzen check`; an invalid value is an error at the field's span.

## Review against a fixed date

A declaration expires and its evidence changes, but the build never reads a clock. `mizzen knowledge --as-of YYYY-MM-DD` measures review against that date, and a declaration is flagged when it has expired or when its `evidence` differs from the current value. Two runs on the same input give the same report.

```bash
mizzen knowledge --as-of 2026-11-23
mizzen knowledge --json --out knowledge.json
mizzen knowledge --baseline knowledge.json --fail-on unknown
```

The report keeps three cases apart, each with a count and a location:

- an explicit `unknown` (or `unsupported`) a subject declares;
- a `documentation-gap` for a subject that declares nothing;
- an `unsupported` case the site cannot handle.

`--baseline` compares with an earlier report and names each added, removed, or changed subject. The report is `schema/knowledge-report.schema.json`.

## Status in the graph and context packs

`mizzen graph` carries a node's status, scope, and public citations. A query names the scope it is asking about with `--scope platform:windows`; a node whose declaration does not cover that scope, or that needs review, is returned with `"definitive": false` rather than as a definitive answer.

```bash
mizzen graph --from page:windows.md --scope platform:linux
```

A context pack publishes each selected page's status in its JSON and its Markdown twin, plus a `knowledge` summary with counts, the items that declare nothing, the items to review, and the items limited to a scope. The two files never disagree.

## Proof and evaluation

A task criterion can rest on an `unknown` or `unverified` claim. Such a criterion is never proved — a passing check or an approval cannot turn an unknown into a verified claim — and its claim names the evidence or human review that would settle it, so the task stays actionable.

An evaluation case can give an agent a question whose answer the evidence does not establish. The reference suite's `answer.bounded-unknown` case does exactly that: the answer must stay within the evidence and cite the declaration that says the case is unknown, and a definitive answer without evidence fails.
