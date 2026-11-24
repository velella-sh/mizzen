---
title: Executable examples
description: Mark fences as runnable, lock the environment, run them with bounded results, and publish the evidence.
---

A fence is an example when its meta contains the bare token `test`. Unmarked fences keep their existing behavior. An
example is opt-in: a normal build runs nothing unless the site turns execution on.

## Mark a runnable block

```text
```js test
console.log("hi");
```
```output
hi
```
```

Every attribute is optional and only refines what the example is.

| Attribute | What it does |
| --- | --- |
| `test` | Marks the fence as an example. Required. |
| `id="name"` | A stable id, lower-case, digits, and hyphens. Without it the id is the page order, `example-1`, `example-2`, … |
| `session="name"` | Runs this block in a shared session with the other blocks of the same name, in document order. |
| `role="setup"`, `role="teardown"` | A block that runs with the visible examples but produces no expected output. |
| `role="step"`, `runbook="name"` | A runbook step; see the runbook section. |
| `hidden` | Hides the block (and its expected output) from the public HTML but keeps it in the Markdown twin. |
| `snippet="file.ts:2-10"` | Takes the block's code from a source file and range instead of the fence. |
| `precondition="test -f file"` | A command that must exit zero before a runbook step runs. |
| `match="pattern"` | Compares the adjacent `output` fence as a regular expression. May also be written on the `output` fence. |
| `network="allow"` | Lets the block reach the network; the default is `deny`. |
| `timeoutMs="5000"`, `memoryMb="64"` | Per-block limits; each defaults to the site's. |

The expected output is the `output` fence directly after the example, and the expected stderr is an adjacent `stderr`
fence. Expected output is compared after CRLF is folded to LF, trailing spaces are removed from each line, and trailing
newlines are dropped; in pattern mode the expected text is a regular expression over the same normalized text.

## Lock the environment

```sh
mizzen examples lock site
mizzen examples lock site --check
```

`examples lock` writes `.mizzen-env.json`: the runtime (Node, engine, platform), the packages the site imports, the
fixture folders under `fixtures/` with their hashes, and the effective limits. `--check` compares the host with the lock
without writing and exits `1` on a difference. A run whose lock is missing or does not match the host reports one
`example-unlocked` finding and runs nothing, so a recorded result can never be mistaken for one from another
environment.

## Enable execution

```yaml
examples:
  execute: true
  failOnFailure: true
  timeoutMs: 15000
  allowlist: [echo, test]
```

`execute: true` runs the fences during the build, so `mizzen check` and `mizzen build` prove them and publish the
evidence. `pinned: true` instead reads `.mizzen-examples.json` and executes nothing. `lock` defaults to true when
`execute` is set. `typeCheck` defaults to true and compiles visible `ts`/`js` blocks against the files they import.

## Record results and the package test

```sh
mizzen examples lock site
mizzen examples record site --date "$(date -u +%F)" --commit "$(git rev-parse HEAD)"
git diff -- site/.mizzen-env.json site/.mizzen-examples.json
mizzen check site
```

`examples record` runs the fences, enforces the lock unless `--no-lock` is given, and replaces `.mizzen-examples.json`
atomically. It exits `1` when a fence fails or the environment is not prepared. A workflow that stops on failure
should upload the file from an always-run step to inspect failed runs.

## Sessions, setup, and teardown

Blocks that share a `session` run in one process in document order, so a later block sees what an earlier one wrote.
The declared order is the page order, so page order and a parallel build give the same result. A `setup` or `teardown`
block runs in the same session as the visible blocks around it. A `hidden` block is dropped from the HTML but kept in
the Markdown twin, with its `hidden` marker, so the contract a reader can check is preserved.

## Snippets from files

```text
```js test snippet="lib/greeting.js:3-3"
```
```output
from a snippet
```
```

The block's code is the named range of the file. The evidence records the file, the range, and the language, and the
block's hash covers the snippet text, so editing the source invalidates a recorded pass.

## Runbooks

A `step` block is one shell command of a runbook. Steps run in one session, in order, and each command must be in the
site's `examples.allowlist`; a step outside it is refused before it runs. A step may declare a `precondition` that must
exit zero first, and an expected output. The first step that fails — refused, a failed precondition, a non-zero exit, or
a wrong output — stops the runbook before the next step.

## Limits and isolation

Every block runs in a fresh folder with an allow-listed environment and a killed process group. The timeout, the V8
old-space limit, the output cap, the denied network, and the denied commands are enforced, and a violation is classified
as `timeout`, `memory`, `output`, `network`, `filesystem`, or `command` in the evidence. Where the host offers
`sandbox-exec` or `bwrap`, writes are confined to the folder too; the result's `sandboxed` flag says whether that
happened, so a passing example never implies an isolation the platform did not provide. This is a process sandbox, not
an OS sandbox: examples come from the site and are otherwise treated as trusted input.

## The cache

Set `MIZZEN_EXAMPLES_CACHE` to a folder (or `1` for `.mizzen/examples`) to keep session results under a content hash of
their inputs. A hit replays the stored outcome with the same evidence and runs nothing; changing any input misses the
entry.

## What the evidence contains

Each result in `.mizzen-examples.json` and `examples.json` keeps `status`, `file`, `line`, `language`, `exitCode`, the
`environment` hash, and `evidence`: the exit code, any violation, each expected output compared, the snippet it read,
and whether it was sandboxed. Nothing is a temporary path, a duration, or a clock, so the same run gives the same bytes.

## Theme contract and page JSON

Layouts and components receive `page.examples` with the page's recorded results, keyed by the `data-example-id` of the
rendered code element. Each page's `index.json` carries the same results under `examples`, so an agent reads the state
without parsing HTML. A changed fence is `status: "stale"` with its prior result in `recordedStatus`.

## File format

Version 1 of `.mizzen-examples.json` has a top-level `version: 1` and an `examples` object. Within `examples`, keys are
page routes without the deployment base. Each route maps fence IDs to records:

```text
{
  "version": 1,
  "examples": {
    "/guide/": {
      "greet": {
        "status": "passed",
        "file": "guide.md",
        "line": 12,
        "language": "js",
        "date": "2026-11-23",
        "commit": "<full lowercase Git commit ID>",
        "sha256": "<lowercase SHA-256 hex digest>",
        "exitCode": 0,
        "environment": "<lowercase SHA-256 of .mizzen-env.json>",
        "evidence": { "exitCode": 0, "outputs": [/* stdout, stderr */], "sandboxed": true }
      }
    }
  }
}
```

`status` is `passed`, `failed`, `skipped` for an unsupported language, or `sandbox-unavailable` for a supported
language skipped because there was no OS sandbox. The hash is over the UTF-8 bytes of the JSON array
`[language, code, expectedOutput]`, with `null` for absent expected output. A missing file gives no evidence, and a
malformed file is a build error.

The public `examples.json` keeps the `pages` totals and key order. In pinned or execution mode it also includes
`version: 1` and an `examples` object keyed by the published page URL, including `base`. Stale and unrecorded fences
count toward `skipped`.
