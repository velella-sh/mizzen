# Baseline: test documented commands in CI

Epic: #533. Baseline for #534, before the association in #535 and the CI gate in #537.

## Fixture

The real Offing Quickstart, copied to
[`test/docs-command-check/fixtures/offing/quickstart.md`](../test/docs-command-check/fixtures/offing/quickstart.md),
with its five `bash` fences marked `test`. The test runs the current report with a stub runner: four commands succeed
and `offing explain` exits 1.

## What already worked

- `examples-report` finds every `test` fence on a doc page, runs `js`/`mjs`/`ts` through Node and `bash`/`sh` through
  the shell, and compares the adjacent `output` fence when the page has one.
- `examples.json` has a fixed shape: one entry per page, sorted by URL, with `total`, `passed`, `failed`, and
  `skipped`; pages without examples are present with zeros. Bytes do not contain a time, duration, or machine name.
- A failing example is one `example-failed` warning at the fence's source position, naming the page, the file and line,
  the expected output, and the exit code. The build still succeeds.
- An unsupported language is `skipped`, not failed, and is never handed to a runner.
- An app page is present with zeros and its body is never parsed for examples.

## Confirmed gaps

1. **The report is counts, not evidence.** `examples.json` says four passed and one failed; it does not list the
   command, its line, or its output, so a reader cannot tell which block ran.
2. **A broken command does not fail CI.** The failure is a warning. #537 has to gate on it without turning every
   existing warning into an error.
3. **A fence has no CI identity.** Nothing ties a block to the job, container, or setup it needs; the runner is chosen
   from the language alone.
4. **The test proves the wiring, not the real command.** The stub runner answers by code, so a command that is wrong
   for a reader's shell still "passes" here; only a real run proves the guide.
5. **Unmarked blocks never run.** The guide's `text` and `yaml` blocks are not examples, and a fence that loses its
   `test` token silently stops being checked.
6. **Source positions live only in the diagnostic.** There is no line-bearing field in the JSON for a report or an
   editor to consume.

## How to run the baseline

```bash
node --test test/docs-command-check/baseline.test.ts
```

The second test is the broken-command case; the guide itself is unchanged between the two runs.

## The CI gate

`examples: { failOnFailure: true }` makes a failed `test` fence an `error` at the fence's file and line, so
`mizzen check` exits `1`. Every other finding keeps its severity, and a page without a `test` fence is untouched.
Without the key the same failure stays a warning and the build succeeds.

`docs/recipes/docs-command-check.yml` copies to `.github/workflows/`. It runs the selected repository tests and then
`npx mizzen check site`; either a failing test or a broken example fails the job. Replace the test path with the tests
that prove your own guide's commands.

For an Offing guide: mark each command fence `test`, keep the test that runs the command, and set
`examples.failOnFailure` in `mizzen.yml`. `test/docs-command-check/acceptance.test.ts` proves both cases: the healthy
guide passes, and the broken `offing explain` block fails at line 42 of the fixture while the same failure without the
key is only a warning.
