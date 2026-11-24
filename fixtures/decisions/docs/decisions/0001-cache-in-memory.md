---
id: ADR-0001
title: Cache every hit in memory
status: superseded
date: 2025-01-10
source:
  value: https://example.test/rfcs/1
  public: true
supersedes: []
behaviors:
  - cache-hit
pages:
  - guide/caching.md
validity:
  versions: [v1]
public: true
---

## Context

The cache is small and the working set fits in memory.

## Decision

Cache every hit in a process-local map.

## Rationale

An in-memory map is simple and fast, and the working set was small.

## Alternatives

- **Redis** — rejected because the team did not want another service to operate.
- **No cache** — rejected because every request would re-read the disk.
