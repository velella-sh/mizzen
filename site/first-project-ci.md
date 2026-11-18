---
title: Review a data change in CI
description: Change one row of a CSV collection, build twice, and turn the difference into a Markdown impact summary a reviewer can read in the pull request.
layout: doc
permalink: /first-project-ci/
---

# Review a data change in CI

A data change is one row, but it can edit a page, change a record, and rewrite the machine files that list the
records. `mizzen diff --format markdown` turns two builds into one table that names the page and the record, and links
each page at its published URL.

Run the commands from your site folder. They use `npx mizzen`; in a checkout of this repository the same arguments
work with `node bin/mizzen.ts` and the site folder named.

## The data

```csv
# _data/sensors.csv
slug,name,summary,status
thermometer,Thermometer,A thermometer reports the temperature of a probe.,stable
barometer,Barometer,A barometer reports air pressure.,beta
```

```yaml
# mizzen.yml
collections:
  sensors:
    source: _data/sensors.csv
    id: slug
    template: _templates/sensors.md
    permalink: /sensors/{slug}/
```

A CSV source has a header row and one record per row. `id: slug` names the id column; without it the first column is
the id. The template is ordinary Markdown:

```md
---
title: "{name}"
layout: doc
---
# :field[name]

:field[summary]

Status: :field[status]
```

## Reproduce the change locally

```sh
npx mizzen build . --out _site-before
```

Edit the one status cell in `_data/sensors.csv`, from `beta` to `stable`, then build and compare:

```sh
npx mizzen build . --out _site-after
npx mizzen diff _site-before _site-after --format markdown --link-base https://example.com
```

`--link-base` is the published origin; every page row becomes a link. The same comparison against a git ref builds
both sides for you:

```sh
npx mizzen diff --base main . --format markdown --link-base https://example.com
```

## The impact summary

The run on the two rows above, with the theme and search rows left out:

```markdown
<!-- mizzen-diff -->
### Site diff

pages: 1 changed; 13 other files changed; 1 record changed.

| Page | Change | Details |
| --- | --- | --- |
| [/sensors/barometer/](https://example.com/sensors/barometer/) | changed | edited Barometer (lines 1-5) |
| `data/sensors.csv` | file changed | data |
| `data/sensors.raw.json` | file changed | data |
| `data/sensors.sha256` | file changed | data |
| sensors/barometer | record changed | status |
```

Read it in three rows:

- The page row names `/sensors/barometer/` and says which block changed: the name and the status line.
- The `data/` file rows are the collection's own output, so a reviewer can see the source and its copies moved
  together.
- The record row names `sensors/barometer` and the field that changed, `status`.

The `<!-- mizzen-diff -->` marker lets a later run find and edit the same comment instead of adding another. The
`pages:` line is the summary to read first; the table is the evidence behind it.

## The workflow

Set `BASE_REF` to the branch a pull request compares against and `SITE_URL` to the published origin. This snippet
keeps the report on the run itself; the job has a read-only token and posts nothing.

```yaml
name: data-change-review

on:
  pull_request:

permissions:
  contents: read

env:
  BASE_REF: origin/main
  SITE_URL: https://example.com

jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: Write the impact summary
        run: >-
          npx mizzen diff --base "$BASE_REF" .
          --format markdown --link-base "$SITE_URL" > data-diff.md
      - run: cat data-diff.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        with:
          name: data-diff
          path: data-diff.md
```

`fetch-depth: 0` makes the base branch available for `--base`. The reviewable output is the run's **Summary** tab,
under Actions; the `data-diff` artifact is the same Markdown. To post it as a pull request comment instead, copy
`recipes/site-diff.yml`, which has the two-job split a write token needs. Add
`--fail-on removed-pages,broken-urls` to the command to fail the job when the change stops answering an old URL,
rather than only reporting it.

## Where next

[Compare two builds](/site-diff/) covers every kind of change and the JSON format,
[Try a migration on a branch](/first-project-trial/) exercises the same diff on a whole section, and
[Data sites](/data/) covers collections and record pages.
