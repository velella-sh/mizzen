---
title: Federated knowledge
description: "Query independent, locked knowledge snapshots across repositories and assemble attributable context offline."
layout: doc
permalink: /federated-knowledge/
---

Mizzen can read the knowledge of independent projects — a product, its documentation, and a consumer — without
joining their repositories and without a network call at build time. Each project publishes a versioned *bundle* of
its knowledge graph, public surface, behavior contracts, and authorized evidence. A fetch pins every bundle by SHA-256
in `federation.lock.json`; a build reads only that lock and the local bundle bytes.

The whole feature is opt-in. A site without a `federation` key reads no other project and its output is byte-identical.

## The manifest

`federation.json` lists the projects, each with a namespace, a snapshot role, and where it publishes its bundle.

```json
{
  "version": 1,
  "projects": [
    { "id": "product", "namespace": "velella-product", "role": "product", "source": { "url": "https://product.example.com/knowledge.bundle.json" } },
    { "id": "docs", "namespace": "velella-docs", "role": "docs", "source": { "path": "../docs/knowledge.bundle.json" } },
    { "id": "consumer", "namespace": "velella-consumer", "role": "consumer", "source": { "path": "../consumer/knowledge.bundle.json" }, "version": { "range": ">=1.0.0 <2.0.0", "channel": "compatible" } }
  ]
}
```

A duplicate project id, namespace, or source is refused, because a federation whose identities collide cannot keep two
projects' same-named nodes apart. A source is exactly one of an `https:` URL or a path relative to the manifest's
folder, and a path may not leave that folder.

## Publish a bundle

A repository publishes `knowledge.bundle.json`: its graph, its public surface items, its public behavior contracts, its
authorized evidence, and its explicit cross-project references. The bundle carries the tool version, the snapshot
identity, the access policy, and a SHA-256 over its own body, so a reader can prove it was not edited after it was
published. Every private node, surface item, behavior, and evidence value is left out here, never redacted in place.

## Fetch and lock before a build

```bash
mizzen federation fetch . --check   # compare only
mizzen federation fetch .           # write federation.lock.json and the bundle bytes
```

The lock records the manifest's own hash and every bundle by SHA-256. A normal build reads only these files: it never
downloads, and it re-verifies every pin on every read, so a tampered bundle is refused rather than used.

## Fully qualified identities

Every node is named by its project, its snapshot, and its own local id: `product/snap-1/page:guide.md`. Two projects
that both document `guide.md` stay distinct. A cross-project edge exists only where a bundle declares an explicit
reference; nothing is inferred from a matching label. The composed graph and its digest do not depend on the order the
bundles were read in.

## Query across repositories

```bash
mizzen federation query . --from docs/snap-1/page:install.md --depth 2 --json
mizzen federation query . --from product/snap-1/page:guide.md --to docs/snap-1/behavior:install.runs
```

The answer carries fully qualified citations, a `partial` marker when a bound stopped it or an optional bundle was
missing, and `definitive: false` when a returned node's knowledge does not cover the scope you asked about.

## Compile a context pack

```bash
mizzen federation pack . --goal "install the product" --budget 2000 --json
```

One shared budget, an equal-turn admission that lets no project take another's share, and every omission attributed to
its project. A missing bundle is a `missing` omission and makes the pack `partial`.

## Resolve a stable reference

```json
{ "kind": "federation", "project": "docs", "id": "behavior:install.runs", "version": "1.1.0", "channel": "pinned" }
```

A `pinned` reference names exactly one snapshot. A `compatible` reference accepts a pinned snapshot in the same major
version that satisfies the declared range, so an unrelated later snapshot is never chosen in place of the pinned one.
Selection reads only the lock and the version rules, never the publishing time. A removed target is reported `removed`
with the version it was recorded at; a mismatched one `incompatible`; and a project the caller may not read is
`withheld`, never resolved to something else.

## Trace evidence across projects

```bash
mizzen federation chain . --claim consumer/snap-1/claim-install --json
```

A claim in one project leads, through its own links, to a test or data node in another project. Every link's digest is
carried unchanged and re-verified, and a link whose digest no longer matches is marked rather than followed.

## Access policy

A bundle publishes who may read it: public, or a list of audiences an authorized reader must hold. One policy governs
the bundle, the query, and the pack. A project the caller may not read is left out whole — not in a node, not in an
edge, and not in the omissions — so its name never discloses that it exists. A bundle with no audience is readable by
nobody but an explicit audience list.

## Refresh one project

A project's snapshot change invalidates only the units that depend on it: its own unit, and any unit that points at it
through an explicit reference. Reusing every other unit whole and recomposing the rest produces exactly the graph and
digest a full recomposition would, which the tests assert directly.

## The public contract

The types are in `src/contracts/federation.ts`. A consumer that only reads the result imports `FederatedGraph`,
`FederatedCitation`, `FederatedQuery`, `FederatedQueryResult`, `FederatedPack`, `FederatedReference`,
`FederatedReferenceResolution`, and `LoadedFederation`; a publisher that writes one imports `KnowledgeBundle` and
`FederationLock`. `bundleDigest` and `federationLockHash` are the two identities a stored reference pins.
