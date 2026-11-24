---
title: Downstream change propagation
description: Diff two locked snapshots into versioned semantic events, match them to the consumers that declared them, and prepare evidenced downstream tasks without touching the upstream source.
layout: doc
permalink: /change-propagation/
---

[Federated knowledge](https://github.com/velella-sh/mizzen/blob/main/docs/federated-knowledge.md) answers what another project knows. Downstream change propagation answers
who must act when it changes. A consumer declares the public surface, behavior, collection, page, symbol, decision, and
evidence it depends on, with a version policy and an approval policy. Two locked snapshots of the upstream project are
diffed into semantic events; an event reaches only a consumer that declared the dependency it names.

The feature is opt-in and offline. It reads verified `knowledge.bundle.json` files and one `propagation.json` manifest;
it never reads the network and never writes the upstream source.

## The consumer manifest

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

## Diff and preview

```bash
mizzen propagate diff . --baseline locked/before --current locked/after --json
mizzen propagate preview . --baseline locked/before --current locked/after --json
```

Each path names one verified bundle or a folder of `*.bundle.json` files; an adjacent `<name>.decisions.json` adds that
snapshot's public decisions. The diff emits versioned events for a surface, behavior, public decision, or evidence
change, each with the stable `ref`, the source span, and a SHA-256 of the changed record. A page body, a graph label, or
a private rationale is not part of the public contract, so changing one emits nothing external.

Only a consumer that declared the changed dependency is matched. Its policy classifies the change:

| Change | Severity |
| --- | --- |
| an item, behavior, decision, or evidence was removed | `breaking` |
| an item was added | `compatible` |
| a signature, status, link, digest, or scope changed | `review` |
| the snapshot version is outside the declared range | `breaking` |

The preview names the downstream snapshots, the affected pages, the proposed task ids, and one sentence of reasoning
for each consumer, before anything is published.

## Propose and apply

```bash
mizzen propagate propose . --baseline locked/before --current locked/after --json
mizzen propagate apply . --baseline locked/before --current locked/after --approve docs-lead
```

A proposal carries the consumer-relative scope, executable acceptance criteria, the change rationale, the decisions that
explain the change, and only the evidence the consumer is authorized to read. Evidence ids outside `evidence.allow`, or
inside `evidence.deny`, are withheld and counted, never redacted in place. The upstream files are not part of the scope
and are never written.

A receipt is derived from the consumer, the upstream snapshot, and the change set, so reprocessing the same snapshots
finds the earlier receipt and creates no second task or pull request. With `approval.mode: "required"`, the first apply
records `pending-approval` and creates nothing; a later apply that names an accepted approver advances the same receipt.

```bash
mizzen propagate receipt <receipt-id> . --json
mizzen propagate verify <receipt-id> .
```

After verification, the same snapshots are still a no-op: the verified receipt is returned unchanged. Receipts live in
`.mizzen/propagation.json` and contain no timestamp.

## Partial results

A consumer whose current or baseline bundle is missing is recorded as `missing-bundle`; one whose private snapshot the
caller may not read is recorded as `permission`. Both stay with that consumer, and every other consumer still gets its
preview, receipt, and task. A run with any failure reports `partial: true` and exits `1`.

The full guide, including the public formats and their JSON Schemas, is
[`docs/change-propagation.md`](https://github.com/velella-sh/mizzen/blob/main/docs/change-propagation.md).
