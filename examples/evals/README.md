# Live agent evaluation example

The engine's evaluation suite scores an agent result; it never calls a model. This example supplies
the other half: a runner that starts one external program per case.

```sh
MIZZEN_EVAL_AGENT=/path/to/agent node examples/evals/run.ts fixtures/evals live-report.json
```

The program reads one JSON request on stdin — `{ case, fixtureRoot, suiteRoot }` — and writes one
`EvalAgentOutput` on stdout with `pages`, `symbols`, `toolCalls`, and `usage`, plus whichever of
`answer`, `edits`, `permission`, or `transaction` the case needs. A non-zero exit or malformed JSON
invalidates that case instead of scoring it.

The adapter records `live` as its id and the tool versions in `live-runner.ts`; a suite that pins a
different id or version reports the run as incomparable. Set `MIZZEN_EVAL_MODEL` to record the model
name. The request holds only the case, not credentials: the program owns its own configuration.

`node --test` and `.github/workflows/ci.yml` never import this folder. A live run happens by hand or
through `.github/workflows/evals-live.yml`, which is opt-in.
