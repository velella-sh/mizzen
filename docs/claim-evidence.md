# Claim evidence

Status: accepted for 0.2.3 (`claim-evidence`, #527). This note fixes the reference contract; #529 to #532
implement it.

A record page states a date, a number, or a line of text that came from somewhere else. A reader needs the
source that backs it, and an agent reading the page JSON needs the same source. The link between a value and
its source is site data, never theme code: one map in the data file, carried unchanged to HTML and JSON. The
fixture below is the whole contract.

## Terms

- **Claim** is one field's value together with the source that backs it. A field backed by two sources has two
  claims, each with its own id.
- **Source** is the document or run a claim points at: a readable title and a URL.
- **Evidence field** is the top-level record field a collection names with `evidence`. It maps a field name to
  one claim, or to a list of claims.
- **Public** means written to an output: HTML, the page JSON, or the Markdown twin. **Private** means kept in
  the data file; the build never writes it to an output or hands it to a template as evidence.

## The minimal fixture

One collection, two records, one template. The date is Ebb's and the number is Offing's, so the date and the
number lead to different sources with no shared vocabulary.

```yaml
# mizzen.yml
title: Claim evidence fixture
collections:
  findings:
    source: _data/findings.yml
    id: id
    template: _templates/finding.md
    permalink: /findings/{id}/
    evidence: claims
```

```yaml
# _data/findings.yml
- id: ebb-node-18
  statement: Node 18 reaches end of life.
  eol: 2025-04-30
  claims:
    eol:
      - id: node-18-schedule
        title: Node.js release schedule
        url: https://nodejs.org/en/about/previous-releases#release-schedule
      - id: node-18-announcement
        title: Node.js 18 release announcement
        url: https://nodejs.org/en/blog/announcements/v18-release-announce
- id: offing-checkout-v3
  statement: Workflows still pin actions/checkout v3.
  openWorkflows: 1204
  claims:
    openWorkflows:
      id: workflow-inventory
      title: Workflow inventory, 2026-03-01
      url: https://offing.example.org/runs/2026-03-01/workflows.json
      note: Counted by scripts/inventory.ts; not published.
```

```md
<!-- _templates/finding.md -->
---
title: "{statement}"
layout: record
---
:field[statement]

:::if{field=eol}
End of life: :field[eol] (:evidence[eol]).
:::

:::if{field=openWorkflows}
Open workflows: :field[openWorkflows] (:evidence[openWorkflows]).
:::
```

Here `eol` is a date claim and `openWorkflows` is a number claim; the value's own type is the claim type. The
engine adds no `type` key and keeps no fixed list of source kinds. A primary document and a raw run are what
the site says in the title and URL, not what a setting classifies.

## The reference contract

1. A collection turns the feature on with `evidence: <field>`, a top-level record field. Absent, nothing
   changes: nothing is read, no output key is written, and the site keeps its bytes.
2. The named field is a mapping. Its key is a top-level field of the same record; its value is one claim
   mapping or a list of claim mappings. A single mapping and a list of one mean the same thing.
3. A key that names no top-level field of the record is invalid. Nested field names are not read in this
   contract.
4. Every claim has three public keys, all required non-empty strings: `id`, `title`, `url`.
5. `id` is stable and unique within one field's list, compared by code point. Two fields may point at one
   source; the duplicate check does not compare across fields.
6. `title` is the readable label. The build never derives one from the URL or the value.
7. `url` is an absolute `https:` URL or a root-relative path such as `/reports/2026-03.json`. Any other
   absolute scheme (`http:`, `javascript:`, `data:`, `file:`), a protocol-relative `//host/…`, or anything
   that parses as neither is disallowed. The build checks the form only; it never opens the URL.
8. Every other key is private. `note` above stays in the data file: it is not rendered, not published, and
   not handed to a template as evidence.
9. The raw evidence field is not a public field. The engine replaces it with the public claims and leaves the
   mapping in the YAML as the only place a private key lives. That is the trust boundary: a template that
   prints every field cannot print a private note, and `json.fields` cannot publish one either.

## What a page carries

A template puts evidence beside the field it backs with `:evidence[<field>]`. The directive writes one link
per claim in list order: `title` is the link text, `url` is the target, and links are separated by `, `. It
writes no wrapper, label, or punctuation of its own, so the surrounding words stay in the template and a field
with no claim writes nothing. A field the record does not have is `data.unknown-field`, as with `:field`.

The page JSON carries the claims under the record:

```json
{
  "record": {
    "collection": "findings",
    "id": "ebb-node-18",
    "fields": {
      "statement": "Node 18 reaches end of life.",
      "eol": "2025-04-30"
    },
    "evidence": {
      "eol": [
        {
          "id": "node-18-schedule",
          "title": "Node.js release schedule",
          "url": "https://nodejs.org/en/about/previous-releases#release-schedule"
        },
        {
          "id": "node-18-announcement",
          "title": "Node.js 18 release announcement",
          "url": "https://nodejs.org/en/blog/announcements/v18-release-announce"
        }
      ]
    }
  }
}
```

Only `id`, `title`, and `url` are written, in that key order. Field groups follow the record's field order and
each list keeps its order; the map's own key order is not an output order. A record with no evidence has no
`evidence` key, never `{}` or `[]`. The Markdown twin carries the same pairs as links. HTML and JSON name the
same title and URL for every claim; the JSON alone carries the id.

## Data without evidence

No evidence is the normal case, not a warning:

- no `evidence` key, no evidence field, or an empty map: no HTML, no JSON key, no diagnostic;
- a field with no entry, or an empty list: the same, beside that field;
- a record the collection's schema would otherwise accept keeps building.

Existing data without evidence settings is valid before and after the change, and a site that turns the key on
for some collections leaves the others untouched.

## Diagnostics

A broken claim is a content problem with a position, not a crash. The ids are:

| Id | Reported when |
| --- | --- |
| `data.evidence-shape` | the evidence field is not a mapping, or a field's value is neither a claim nor a list of claims |
| `data.evidence-field` | a key names no top-level field of the record |
| `data.evidence-claim` | a claim is not a mapping, or `id` or `title` is missing or not a non-empty string |
| `data.evidence-url` | `url` is missing, empty, or not the https/root-relative form above |
| `data.evidence-duplicate-id` | two claims in one field's list share an id |

Each carries the file and the span of the value that caused it, counted like every other data position.
`onInvalid` decides whether a record with one is kept: `error` by default, `skip` for a warning.

## Limits

- **A pointer, not a proof.** The build checks the form of a source, not whether the source supports the value.
  It does not fetch, hash, quote, or compare the page with it; a broken link still builds.
- **Record pages only.** List pages, feeds, and the data API do not carry evidence. A list of records has no
  claim beside a value.
- **Top-level fields only.** A nested value has no evidence path in this contract; a later change may add one.
- **No clock and no network.** Nothing records when a source was read. A private `note` may say it, but is not
  published, so two builds of the same data are byte for byte the same.
- **An id is page-local.** It is unique per field list, not per site. A consumer reads it with its field, which
  the JSON grouping provides.
