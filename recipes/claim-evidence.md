# Put a source next to each claim

A record page states a date, a number, or a line of text that came from somewhere else. Name the field that holds the
claims in the collection, then render one beside the value it backs. HTML and the page JSON read the same claims, so a
reader and an agent see the same source.

```yaml
collections:
  findings:
    source: _data/findings.yml
    template: _templates/finding.md
    permalink: /findings/{id}/
    evidence: claims
```

`evidence` names a top-level record field. Without it nothing changes: the field is ordinary data and no output gains an
`evidence` key. Inside that field, each key is a top-level field of the record, and each value is one claim mapping or a
list of them. A single mapping and a list of one mean the same thing.

```yaml
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

A claim has three public keys, all non-empty strings: `id`, `title`, and `url`. `url` is an absolute `https:` address
or a root-relative path. Every other key is private: the `note` above stays in the data file, and the raw `claims` field
is not published in `record.fields` or readable through `:field`.

## Render the source

```md
End of life: :field[eol] (:evidence[eol]).

Open workflows: :field[openWorkflows] (:evidence[openWorkflows]).
```

`:evidence[field]` writes one link per claim in list order, using `title` as the text and `url` as the target, separated
by `, `. It adds no label or wrapper; the surrounding words stay in the template. A field with no claim writes nothing.
A name the record does not have is `data.unknown-field`, as with `:field`.

The page JSON carries the same claims under `record.evidence`, grouped by the field they back and in record field
order. Only `id`, `title`, and `url` are written there; a private key never reaches either output.

`test/claim-evidence/parity.test.ts` builds one date claim and one number claim from different sources and checks that
the HTML links and the page JSON carry the same claims in the same order.
