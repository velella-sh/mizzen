---
title: Downstream change propagation
description: "Diff two locked snapshots into versioned semantic events, match them to the consumers that declared them, and prepare evidenced downstream tasks without touching the upstream source."
---

Federated knowledge answers *what another project knows*. Downstream change propagation answers *who must act when it
changes*. A consumer declares the public surface, behavior, collection, page, symbol, decision, and evidence it depends
on, with a version policy and an approval policy. Two locked snapshots of the upstream project are diffed into semantic
events; an event reaches only a consumer that declared the dependency it names.

The whole feature is opt-in and offline. It reads verified `knowledge.bundle.json` files and one `propagation.json`
manifest; it never reads the network and never writes the upstream source.

## Declare what a consumer consumes

`propagation.json` is the consumer manifest. Each consumer names the upstream project and the dependencies whose change
affects it.

```json
{
  "version": 1,
  "consumers": [
    {
      "id": "docs",
      "project": "product",
      "policy": { "range": ">=1.0.0 <2.0.0", "channel": "compatible" },
      "approval": { "mode": "required", "approvers": ["docs-lead"] },
      "evidence": { "allow": ["claim-greet"], "deny": [] },
      "consumes": [
        { "kind": "surface", "id": "api:greet", "pages": ["guide/install.md"], "files": ["src/setup.ts"] },
        { "kind": "behavior", "id": "greet.returns-name" }
      ]
    }
  ]
}
```

A dependency is one of `surface`, `behavior`, `collection`, `page`, `symbol`, `decision`, or `evidence`. A page
dependency names a Markdown page inside the consumer; every other id is the stable id the upstream snapshot publishes.
An invalid kind, an escaping page or file path, a malformed range, a `compatible` channel without a range, a duplicate
consumer, or a duplicate dependency is refused whole, at its own JSON Pointer.

```bash
mizzen propagate check . --json
```

## Diff two locked snapshots

```bash
mizzen propagate diff . \
  --baseline locked/before --current locked/after --json
```

`--baseline` and `--current` each name one verified bundle or a folder of `*.bundle.json` files. An adjacent
`<name>.decisions.json` adds that snapshot's public decisions. The diff emits versioned events for:

- a surface item added, removed, or changed in signature, stability, version, parent, or area;
- a behavior added, removed, or changed in normative statement, status, version history, surface link, page, tests, or
  evidence;
- a public decision added, removed, or changed in status, text, links, or validity;
- a published evidence claim or link added, removed, or changed in digest.

Every event carries the upstream project, the stable `ref` a consumer declares, the source span, and a SHA-256 of the
changed record. A page body, a graph label, or a private rationale is not part of the public contract, so changing one
emits nothing external.

## Match, classify, and preview

```bash
mizzen propagate preview . \
  --baseline locked/before --current locked/after --json
```

Only a consumer that declared the changed dependency is matched. The consumer's policy then classifies each change:

| Change | Severity |
| --- | --- |
| an item, behavior, decision, or evidence was removed | `breaking` |
| an item was added | `compatible` |
| a signature, status, link, digest, or scope changed | `review` |
| the snapshot version is outside the declared range | `breaking` |

A version policy maps each severity to an action: `none`, `acknowledge`, `task`, `pull-request`, or `review`. The preview
names the downstream snapshots, the affected pages, the proposed task ids, and one sentence of reasoning for each
consumer, before anything is published.

## Propose a task without touching upstream

```bash
mizzen propagate propose . --baseline locked/before --current locked/after --json
```

A proposal carries the consumer-relative scope, executable acceptance criteria, the change rationale, the decisions that
explain the change, and only the evidence the consumer is authorized to read. Evidence ids outside `evidence.allow`, or
inside `evidence.deny`, are withheld and counted; they are never redacted in place. The upstream project's files are not
part of the scope and are never written.

## Apply under the consumer's approval policy

```bash
mizzen propagate apply . --baseline locked/before --current locked/after --json
mizzen propagate apply . --baseline locked/before --current locked/after --approve docs-lead
```

A receipt is derived from the consumer, the upstream snapshot, and the change set. Reprocessing the same snapshots finds
the earlier receipt and creates no second task or pull request. With `approval.mode: "required"`, the first apply records
`pending-approval` and creates nothing; a later apply that names an accepted approver advances the same receipt.

```bash
mizzen propagate receipt <receipt-id> . --json   # read an earlier receipt
mizzen propagate verify <receipt-id> .           # mark it verified after the task passes
```

After verification, the same snapshots are still a no-op: the verified receipt is returned unchanged. Receipts live in
`.mizzen/propagation.json` and contain no timestamp, so an unchanged run writes the same bytes.

## Partial results

A consumer whose current or baseline bundle is missing is recorded as `missing-bundle`; one whose private snapshot the
caller may not read is recorded as `permission`. Both stay with that consumer, and every other consumer still gets its
preview, receipt, and task. A run with any failure reports `partial: true` and exits `1`.

## Public formats

| File | What it is |
| --- | --- |
| `propagation.json` | The consumer manifest, validated at `schema/propagation-manifest.schema.json`. |
| `.mizzen/propagation.json` | The deterministic receipt ledger, validated at `schema/propagation-ledger.schema.json`. |
| `*.bundle.json` | A verified knowledge bundle from [Federated knowledge](federated-knowledge.md). |
