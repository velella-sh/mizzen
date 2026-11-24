---
title: Internal behavior contracts
behavior:
  - id: parseWidget.returns-id
    title: parseWidget returns the lowercase widget id
    normative: parseWidget requires a non-empty name and returns its lowercase id.
    status: supported
    versions:
      introduced: 0.2.0
    surface: ["symbol:parseWidget"]
    tests:
      - file: tests/parse-widget.test.mjs
        name: parseWidget returns an id
        outcome: passed
    evidence:
      - url: https://example.org/evidence/parse-widget
        kind: test
        title: parseWidget behavior check
---

# Internal behavior contracts

This page is outside `surface.docs`, so it records the contract without documenting the API.
