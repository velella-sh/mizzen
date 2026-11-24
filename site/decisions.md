---
title: Decision memory
description: "Read versioned decision records (ADRs), follow their lifecycle, and ask why a behavior or page exists, with the current decision, its rationale, and the rejected alternatives, each with a citation."
---

# Decision memory

A decision record says *why* something is the way it is: the context, the decision, the reasoning, and the alternatives that were rejected. Mizzen reads those records, follows their lifecycle, and answers "why does this behavior or page exist" with the decision in effect, its rationale, the rejected alternatives, and the decisions that came before, each with a citation.

## Turn it on

Name the folder that holds the records. The defaults read `docs/decisions`.

```yaml
decisions:
  dir: docs/decisions
  behaviors:
    - cache-hit
```

## Write a record

A record is a Markdown file with front matter naming five keys: `id`, `title`, `status`, `date`, and `source`. A file missing any of them is refused with a diagnostic at the exact key.

```markdown
---
id: ADR-0002
title: Replace the in-memory cache with Redis
status: accepted
date: 2025-03-02
source:
  value: https://example.test/rfcs/2
  public: true
supersedes: [ADR-0001]
behaviors:
  - cache-hit
pages:
  - guide/caching.md
validity:
  versions: [v2]
public: true
---

## Context

The working set outgrew one process.

## Decision

Cache hits and misses in Redis, shared by every worker.

## Rationale

A shared cache gives one answer across workers.

## Alternatives

- **Keep the map** — rejected because each worker would answer differently.
- **Sticky sessions** — rejected because the balancer cannot guarantee a worker.
```

- `status`: `proposed`, `accepted`, `superseded`, `deprecated`, or `rejected`.
- `date`: an explicit `YYYY-MM-DD` day. The clock is never read.
- `source`: where the decision was made. `{ value, public: true }` publishes it; a plain value stays private.
- `supersedes`: the ids this record replaces. A supersession cycle is refused.
- `behaviors`, `pages`, `collections`, `apis`, `surfaces`, or `links`: the stable ids a decision affects.
- `validity`: the versions or snapshots the decision applies to.
- `public`: `true` publishes the rationale, the decision text, and the rejected alternatives.

The `Context`, `Decision`, `Rationale`, and `Alternatives` sections are read by name (with common synonyms such as `Background`, `Why`, and `Options`). Each section keeps its exact text and source span, so a citation quotes the bytes the author wrote.

## Follow the lifecycle

A record's `supersededBy` is every record that names it in `supersedes`. A supersession cycle — `A` supersedes `B` supersedes `A` — is refused with an error, and the records in the cycle are never presented as the decision in effect.

## Ask why

```bash
mizzen decisions why behavior:cache-hit
mizzen decisions why /guide/caching/ --version v1
mizzen decisions why collection:users --snapshot build-123
```

The answer names the current decision, its rationale, the rejected alternatives, and the decisions it superseded, each with a citation. At `v1` the answer is the decision in effect then; at `v2` it is the replacement, with the earlier one as history.

## Access and citation

A record with an `audience` is left out unless the caller may read it. `--policy` applies an access policy to the records *and* to their citations: a record whose citation names a page the policy refuses is left out, so a citation is never a way around the policy. A private rationale, source, or alternative is replaced with a fixed placeholder.

## Inside an agent's context

The context compiler adds the decisions in effect for the pages and collections a task edits, as active rules with a citation. A superseded, rejected, or deprecated decision is history, never an active rule, so an agent does not follow a rule that was replaced. See [Command line](/cli/).

## The report and the page

`mizzen decisions` prints the versioned report: every record in public form, the counts by status, the evidence a build could not resolve, and the lifecycle problems. The `decisions` output writes `decisions.json` and a `decisions/index.html` matrix from the same public projection.
