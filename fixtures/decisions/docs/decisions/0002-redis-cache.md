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
  - cache-miss
pages:
  - guide/caching.md
validity:
  versions: [v2]
public: true
---

## Context

The working set outgrew one process, so an in-memory map misses across workers.

## Decision

Cache hits and misses in Redis, shared by every worker.

## Rationale

A shared cache gives one answer across workers, which the in-memory map could not.

## Alternatives

- **Keep the map** — rejected because each worker would answer differently.
- **Sticky sessions** — rejected because the balancer cannot guarantee a worker.
