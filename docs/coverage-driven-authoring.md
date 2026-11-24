# Coverage-driven authoring

Status: implemented for 0.2.7 (`027-coverage-driven-authoring`, #1322, #1407 to #1416). This note fixes the reference
contract.

A documentation gap becomes an authoring task with the public surface item, its introduction version, the evidence a
draft must cite, a recommended page type, and an evidence-first outline. An external agent exports the task and its
context pack, returns a draft, and Mizzen validates the draft's citations, explicit unknowns, location, preview,
checks, and pull-request proposal before a person writes anything. The engine never calls a model, never generates
prose, and never merges a pull request.

```text
mizzen surface ──► gaps ──► author tasks ──► export ──► external agent ──► draft
                                                                          │
   write ◄── approval ◄── preview ◄── citations/unknowns/location ◄────────┘
     │
     └──► verify (examples, behaviors, links, coverage, build) ──► proposal ──► person merges
```

## From gaps to tasks

`mizzen author tasks [dir]` reads the surface report and creates one registered task per gap (#1407). An item the
configuration excludes is never a gap, so it never becomes a task: the exclusion appears under `skipped` with the
author's reason. An item that is already completely documented is skipped with that reason too.

```json
{
  "version": 1,
  "item": "symbol:parseWidget",
  "surface": { "id": "symbol:parseWidget", "area": "api", "kind": "symbol", "stability": "stable", "introduced": "0.2.7", "source": { "file": "src/index.ts", "line": 6, "...": "..." } },
  "gap": "undocumented",
  "requiredEvidence": [
    { "kind": "surface", "ref": "symbol:parseWidget", "detail": "The public surface declaration." },
    { "kind": "behavior", "ref": "parseWidget.returns-id", "detail": "Behavior `parseWidget returns the lowercase widget id`." },
    { "kind": "test", "ref": "tests/parse-widget.test.mjs", "detail": "Test `tests/parse-widget.test.mjs` is expected to passed." },
    { "kind": "evidence", "ref": "https://example.org/evidence/parse-widget", "detail": "Evidence for `parseWidget.returns-id`." },
    { "kind": "source", "ref": "src/index.ts:6", "detail": "The declaration span src/index.ts:6:17-6:27." }
  ],
  "pageType": { "kind": "reference", "purpose": "lookup", "reason": "...", "rules": ["surface.lookup-kind", "purpose.derived", "page-type.lookup"] },
  "outline": ["..."],
  "location": { "url": "/reference/parse-widget/", "source": "docs/reference/parse-widget.md", "block": "parse-widget", "nav": { "list": "docs", "title": "parseWidget", "parent": "Reference", "after": "documented" } },
  "unknowns": ["..."],
  "questions": ["..."],
  "limitations": ["..."],
  "conflicts": [],
  "task": { "id": "...", "state": "draft", "...": "..." }
}
```

The task is registered through the ordinary task contract. Its snapshot pins the page content, data, config, and
tooling; its acceptance criteria name one check each:

| Criterion | Check | What it proves |

| --- | --- | --- |
| `citations` | `authoring-citations` | Every normative claim cites the surface, a behavior, or evidence. |
| `examples` | `authoring-examples` | Every runnable example prints its recorded output. |
| `behaviors` | `authoring-behaviors` | Every cited behavior is verified by the evidence policy. |
| `links` | `authoring-links` | Every site-local link and citation resolves. |
| `coverage` | `authoring-coverage` | The simulated merge leaves the item completely documented. |
| `build` | `authoring-build` | The site builds and writes the page. |

`--item <id>` narrows the run to one surface item.

## Page type

The purpose decides the page type (#1408). The purpose comes from the surface kind and the gap, unless the caller
states one:

| Purpose | Page type | Default rule |

| --- | --- | --- |
| `lookup` | `reference` | `symbol`, `operation`, `parameter`, `response`, `config-key`, `collection`, `field`, `version`, `flag`, and `argument` |
| `describe` | `guide` | A partial gap, or a command that is not an operational procedure |
| `demonstrate` | `example` | An explicit `demonstrate` purpose |
| `operate` | `runbook` | An operational command such as `build`, `check`, `doctor`, `verify`, `watch`, `migrate`, or `deploy` |

Every choice carries the matched rule ids and one sentence that names the item, the purpose, and the page type, so a
reviewer can disagree with a rule instead of guessing.

## Evidence-first outline

Every task has five sections in this order (#1409): behavior, prerequisites, an example, limitations, and references.
Each section lists the evidence it has and `needsEvidence`. A section without a behavior contract, a test or example,
or a settled unknown says what still has to be established and why. The behavior section uses the normative
statements of the behavior contracts whose `surface` names the item.

## Export to an external agent

`mizzen author export <item> [dir] --out <file>` writes one JSON document with the task, the compiled context pack,
its accounting and answerability, the omissions and requests, the sourced fragments, and the exact evidence the draft
must cite (#1410). `@site/` is not part of the export; the verifier rewrites that prefix in an example, so a draft
stays portable.

The export is deterministic: the same task and site give the same bytes. Draft generation happens in the external
agent; Mizzen validates the returned file through `schema/authoring-draft.schema.json`.

## The draft

```json
{
  "version": 1,
  "item": "symbol:parseWidget",
  "pageType": "reference",
  "title": "parseWidget",
  "description": "Return the lowercase widget id for a name.",
  "slug": "/reference/parse-widget/",
  "block": "parse-widget",
  "body": "# parseWidget {#parse-widget}\n\n`parseWidget` returns the lowercase widget id for a name. [[surface:symbol:parseWidget]]\n",
  "limitations": ["..."],
  "unknowns": [{ "id": "version-introduced", "statement": "...", "evidence": "..." }],
  "questions": [{ "id": "audience-version", "question": "..." }]
}
```

### Citations

A citation is an inline marker in the body:

```text
[[surface:symbol:parseWidget]]
[[behavior:parseWidget.returns-id]]
[[test:tests/parse-widget.test.mjs]]
[[example:test/authoring-e2e.test.ts]]
[[evidence:https://example.org/evidence/parse-widget]]
[[source:src/index.ts:6]]
```

A paragraph is normative when it uses a verb such as `must`, `returns`, `requires`, `supports`, `rejects`, `throws`,
`writes`, `reads`, `resolves`, `defaults`, `cannot`, or `always`. Every normative paragraph must carry at least one
citation to evidence the task requires (#1411). A citation to anything else, an uncited normative claim, or a
normative claim that cites only an unverified behavior is refused. Fenced code and headings are not claims.

### Unknowns, limitations, and reviewer questions

The task's explicit unknowns, reviewer questions, and limitations must appear in the draft unchanged (#1412). Dropping
one, or rewriting its statement, is a problem. An unknown a draft cannot settle stays in the draft and reaches the
proposal, so a person sees it before merging.

### Location

The draft must use the task's URL, source path, block id, and page type (#1413). The first heading declares the block
id, `# Title {#block}`. A URL a page already publishes, a block id the site records, a navigation URL that already
exists, a missing parent group, or the same location proposed by two tasks is a conflict and is rejected before
anything is written.

## Preview and the write gate

`mizzen author preview <draft.json> [dir]` validates the draft, computes the unified diff, and builds the page in a
temporary copy of the site (#1414). It prints or returns the built HTML, the diff, the citations, the uncited claims,
the unknowns, and the questions. It never writes the working tree.

The write gate is one of:

- `denied`: the draft is invalid, or the repository policy denies write;
- `requires-approval`: no policy allowed the write, or the policy requires an approval;
- `allowed`: the policy allows the path and scope, and the approval, when required, is valid.

`--policy <file>` reads the ordinary access policy. `--approval <file>` supplies an approval made under that policy
and the task snapshot. `--approve` is a person's explicit approval on the command line. `mizzen author write` re-runs
the preview and writes only when the gate is `allowed`.

## Verification and the proposal

`mizzen author verify <draft.json> [dir]` runs the fixes in a fixed order (#1415):

1. **examples**: every `js`, `mjs`, or `ts` fence marked `test` runs in the bounded Node runner with the network
   denied; an adjacent `output` fence is compared exactly, and `@site/` imports the temporary merged site.
2. **behaviors**: every cited behavior exists and is verified by the published evidence policy.
3. **links**: every site-local link names a page the merged site builds.
4. **coverage**: the simulated merge makes the surface item `complete`, and the gap disappears.
5. **build**: the merged site builds with no error and writes the page.

A proof records the citations, the checks, the snapshot, and whether the gap closed, with its SHA-256. The proposal is
prepared only when the verification is `proved`; it carries the branch, title, body, authorized file and hash, the
remaining unknowns and questions, and permissions that include neither publish nor merge. A draft that fails any
check yields a no-op proposal with the failures named.

```bash
mizzen author tasks site --json --version 0.2.7
mizzen author export symbol:parseWidget site --out export.json
mizzen author draft draft.json site --json
mizzen author preview draft.json site --json --out preview
mizzen author verify draft.json site --json
mizzen author propose draft.json site --json --out proposal.json
mizzen author write draft.json site --policy policy.json --approval approval.json
```

## Fixture

`fixtures/authoring/site` is one repository with a documented export and an undocumented `parseWidget` export, a
behavior contract outside `surface.docs`, the test it names, a navigation file, and a theme.
`fixtures/authoring/draft.json` is the returned draft. `test/authoring-e2e.test.ts` traces the API from the initial
gap through task, export, validation, preview, example execution, verification, proposal, and the write, then rebuilds
the surface report and asserts that the gap is closed. The `coverage-driven-authoring` acceptance case runs the same
path through the installed CLI.

## Tests

- `test/authoring-tasks.test.ts` (#1407)
- `test/authoring-page-type.test.ts` (#1408)
- `test/authoring-outline.test.ts` (#1409)
- `test/authoring-export.test.ts` (#1410)
- `test/authoring-citations.test.ts` (#1411)
- `test/authoring-unknowns.test.ts` (#1412)
- `test/authoring-location.test.ts` (#1413)
- `test/authoring-preview.test.ts` (#1414)
- `test/authoring-verify.test.ts` (#1415)
- `test/authoring-e2e.test.ts` (#1416)
