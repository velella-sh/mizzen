---
title: Upgrade to 0.2.7
description: Upgrade a 0.2.6 site without changing its Markdown, config, URLs, or output, and adopt surface coverage, behavior contracts, evidence, decisions, federation, propagation, and attestation when you need them.
layout: doc
permalink: /upgrade/
---

# Upgrade to 0.2.7

An existing `0.2.6` docs or data site needs no content migration. Every new key, contract, and command is opt-in:
keeping your Markdown, `mizzen.yml`, navigation, and theme as they are builds the same pages at the same URLs. A build
still opens no network connection unless you configure one.

If you are coming from `0.2.5` or earlier, read the [0.2.6 upgrade notes](https://github.com/velella-sh/mizzen/blob/v0.2.6/site/upgrade.md) first.

## Update and check

After `0.2.7` is published, update the engine in the site's project:

```sh
npm install --save-dev @velella/mizzen@0.2.7
npx mizzen check .
npx mizzen build . --out dist
npx mizzen verify dist
```

Commit `package.json` and `package-lock.json`. Keep your existing theme. Lateen `0.2.3` is the published theme the
release workflow tests with; Lateen `0.2.5` is the current published theme, so read [Lateen 0.2.5](/theme/) before
you bump it. Node 24 or later is still required.

## New contracts

Each contract has a versioned JSON Schema in `schema/` of the installed package. Read the schemas from the package
rather than copying an older set. Every schema below is new or unchanged in meaning; no field of an earlier schema was
removed.

| Contract | Schema | Entry point | Opt in with |
| --- | --- | --- | --- |
| Public surface | `surface-report.schema.json` | `mizzen surface` | nothing; reads your package |
| Behavior | `behavior-report.schema.json` | `mizzen behavior` | `behavior` front matter |
| Evidence | `evidence-envelope`, `evidence-lock`, `evidence-report` | `mizzen evidence ingest` | `evidence.lock.json` |
| Decisions | `decision-report.schema.json` | `mizzen decisions` | decision records |
| Federation | `federation-lock`, `knowledge-bundle` | `mizzen federation` | a federation manifest |
| Propagation | `propagation-manifest`, `propagation-ledger` | `mizzen propagate` | a consumer manifest |
| Attestation | `site-attestation.schema.json` | `mizzen published-site attest` and `verify` | a signing key and trust policy |

The [0.2.7 contract and migration guide](https://github.com/velella-sh/mizzen/blob/main/docs/upgrade-0.2.7.md) gives
the migration step and a checked example for each row. The installed-package tests run each entry point offline.

## What stays the same

- Existing CLI commands and flags keep their meaning and exit codes.
- Markdown pages, front matter, navigation, and their URLs keep working.
- Report formats keep their `version`: a consumer reads the engine revision from `version` in `@velella/mizzen`.
- Evidence, attestation, and federation inputs are read only when you create their files. Without them a build
  writes no `.mizzen/evidence.json`, attestation, or federation output.

## Compatibility evidence

The published baseline is `@velella/mizzen@0.2.6`. `scripts/release-compat.ts` builds the committed compatibility site
with that package and with the candidate tarball and reports URL, effective-configuration, CLI, contract-surface, and
public-output differences in one review report. The committed `fixtures/compat-0.2.6/` records the baseline and a
preliminary review against a tarball built from main; the release workflow reruns the comparison on the exact
candidate tarball and uploads the report. The published `0.2.6` package predates the page-head wiring, so only the head
tags the candidate adds are normalized.

`release/scope.json` records, for each of the 100 features of this release, the public acceptance case or test that
proves it. The release workflow runs those cases from the installed tarball and again from the exact npm version.
