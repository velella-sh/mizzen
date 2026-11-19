# Documentation readiness

Mizzen's readiness report scores a **built folder**, not a source tree: a passing report means the artifact an agent
downloads actually carries the structure, navigation, context, examples, and proof the rubric asks for. The rubric is
version `1.0.0`; changing a rule, a weight, or a threshold bumps that version, and a comparison between two rubric
versions says so instead of hiding it.

Run it with `mizzen readiness <built folder>` after a build:

```bash
mizzen build --out dist
mizzen readiness dist --report readiness.json --badge readiness.svg --evidence https://ci.example/actions/runs/7
```

A report is versioned JSON plus a text rendering of the same value. `schema/readiness-report.schema.json` describes it,
and the `digest` field is a SHA-256 over the report with that field left out, so a hand-edited score fails verification.
A badge is only produced from a report whose digest verifies.

## Statuses and scoring

Every rule is `pass`, `fail`, or `unknown`.

- `pass` and `fail` are facts the scan measured in the artifact.
- `unknown` means the evidence needed to decide is absent, unreadable, or belongs to another build. Unknown points are
  excluded from dimension and overall scores and listed in `unknowns`; they are never counted as a pass.
- A dimension with no known points has no score and is `unknown`.

Each dimension's rules sum to its weight, and the weights sum to 100. A dimension marked **critical** fails the gate
when any of its rules fails, whatever the average score says.

| Dimension | Weight | Critical | Why an agent needs it |
| --- | ---: | :---: | --- |
| Structure | 20 | | An agent can find a page's source, its stable blocks, and the exact span behind every built block. |
| Navigation | 15 | | Every index and internal link leads to a file that exists, so an agent can walk the site without guessing. |
| Context | 15 | | A page carries machine-readable context, edit instructions, and packs an agent can paste without reading the site. |
| Examples | 15 | | Code fences are labelled and runnable examples are checked, and task results come from a matching evaluation suite. |
| Verification | 15 | yes | The artifact is the build it claims to be, and trust evidence names the same pages. |
| Permissions | 10 | yes | Every page names the file an agent may edit, and a generated page points at its real source. |
| Maintenance | 10 | | Review coverage is recorded and no page is silently overdue. |

## Rules

`Prerequisite` is what the scan needs before it can decide. A rule whose prerequisite the site does not have is
`unknown`, not `fail`: a site with no stable block ids is not broken, but it does not earn those points either.

### Structure (20)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `structure.manifest` | 5 | | Every page entry names a relative source file, its outputs, and two hashes. |
| `structure.markdown` | 4 | | Every rendered page has a non-empty Markdown twin listed in its manifest entry. |
| `structure.sourcemap` | 5 | | `sourcemap.json` names every page, and every section and block has a real source span. |
| `structure.blocks` | 3 | Stable block ids (`mizzen build --update-blocks`). | `blocks.json` agrees with the page HTML and the source map about every stable block id. |
| `structure.ids` | 3 | | Block ids are unique across the site and heading anchors are unique within a page. |

### Navigation (15)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `navigation.llms` | 5 | | `llms.txt` exists and every internal link in it resolves to a built file. |
| `navigation.links` | 5 | | Every internal link in the built HTML resolves to a built file. |
| `navigation.agents` | 5 | | `AGENTS.md` exists, has a Pages section, and its page count matches the build. |

### Context (15)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `context.page-json` | 5 | | Every page has a JSON twin whose URL and source match the manifest. |
| `context.agent-json` | 5 | A page with an `agent:` front-matter block. | Agent instruction files parse, name a real page, and carry a source or notes. |
| `context.packs` | 5 | A `_data/context-packs.yml` topic. | Every context pack parses, names known pages, and carries a source span per item. |

### Examples (15)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `examples.fences` | 5 | | Every code fence in a Markdown twin declares a language. |
| `examples.report` | 4 | The `examples-report` output. | `examples.json` exists, covers the build's pages, and reports no failed example. |
| `examples.evaluation` | 6 | A matching evaluation report. | Task results come from an evaluation suite whose version and build snapshot match this report. |

### Verification (15, critical)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `verification.digest` | 8 | | Hashing the built folder again gives the hash in its manifest. |
| `verification.trust` | 7 | The `trust` output and an as-of date. | `trust.json` parses, covers every page, and names this build shape. |

### Permissions (10, critical)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `permissions.edit-target` | 6 | | Every page JSON names the source file an agent would edit. |
| `permissions.generated` | 4 | | A generated page that forbids edits names the file to edit instead. |

### Maintenance (10)

| Code | Points | Prerequisite | Passing |
| --- | ---: | --- | --- |
| `maintenance.review` | 5 | The `review-coverage` output. | `review-coverage.json` exists and names every page of the build. |
| `maintenance.state` | 5 | A build with `--as-of` and git review history. | No page is overdue for review; an unmeasured review state is unknown, never a pass. |

## Gate

Thresholds are opt-in, and a failed critical rule always fails the gate:

```bash
mizzen readiness dist --min-overall 90 --min verification=100 --min maintenance=50
mizzen readiness dist --fail-on-unknown
mizzen check --agents
```

`--min` takes any dimension id and may repeat. Exit `0` is a passing report, `1` a failed rule or threshold, and `2` a
usage problem, a missing build, an unreadable evaluation report, or a comparison report whose digest does not verify.

## Compare and badge

```bash
mizzen readiness dist --compare last-release.json
mizzen readiness dist --badge readiness.svg
mizzen readiness dist --badge readiness.md --evidence https://ci.example/actions/runs/7
```

`--compare` reads only a report whose digest verifies and prints dimension, rule, and page changes; a rubric version
difference is stated and the results are not presented as directly comparable. The badge keeps the score, rubric
version, status, and unknown count. With `--evidence`, the report and badge link to public CI evidence; only `http:` and
`https:` links are kept.

## Evaluations

`examples.evaluation` is scored from an external report and is `unknown` until one arrives:

```bash
mizzen build --out dist
mizzen readiness dist --report readiness.json
mizzen eval my-readiness-suite --build "$(jq -r .build.hash readiness.json)" --out readiness-evals.json
mizzen readiness dist --evals readiness-evals.json
```

The file is either a `mizzen eval` report or a small summary.

A `mizzen eval` report counts only when:

- its suite is named `mizzen-readiness` at version `1`;
- its `pins.build` is the build hash this readiness run scores (recorded by `mizzen eval --build <sha256>`);
- every case passed. A failed or invalid case fails the rule; a report with no scored cases, or any unavailable case, leaves the rule `unknown` rather than a pass.

A summary is an object with:

- `suite`: `mizzen-readiness`
- `version`: `1.0.0`
- `snapshot`: the build's 64-character SHA-256 from the report
- `results`: an object of readiness rule codes to `pass` or `fail`

A different suite, version, or snapshot is refused with exit `2`; it is never merged into a score.

## Privacy

Reports are meant to be published. The command drops findings about private pages and sources, and removes absolute
paths, query tokens, bearer values, and credentials before writing; the digest is recomputed over the public form, so a
redacted report still verifies. Findings carry stable rule codes, scopes, and source positions, never page body text,
prompts, or secret values.

## Limits

- `maintenance.state` is `unknown` on a build made without `--as-of`, because the review window cannot be measured.
- The scan reads only the built folder. A missing output is a finding even when the source exists.
- `docs/readiness.md` is the public rubric of record; the code is `src/readiness/rubric.ts`, and version `1.0.0` is the
  only version so far.
