---
title: First build errors
description: The three findings a first data build usually reports, a missing data file, a schema mismatch, and a malformed base path, with the exact output and the one-line fix.
layout: doc
permalink: /first-project-errors/
---

# First build errors

Three small sites under `fixtures/first-build-errors/` each hold one mistake a first build reports. Run the checks
from the repository root, with the Lateen checkout from [Install and quickstart](/install/) beside it:

```sh
node bin/mizzen.ts check fixtures/first-build-errors/data-path --theme ../lateen
```

A finding is `file:line:column`, a code, and one sentence. The `help` line under it says what to change. `check` exits
`1` when there is an error, so the command is safe to put in a pre-commit hook or CI, and `--format json` gives the
same findings to a script.

## 1. The data file is not where the config says

```text
mizzen.yml:5:13  data.source-missing  Collection "sensors" reads _data/sensor.yml, which does not exist.
  help: Check `collections.<name>.source` in mizzen.yml.
1 error, 0 warnings
```

The path in `source` is relative to the site root. Here the file is `_data/sensors.yml` and the config says
`_data/sensor.yml`, so the collection has nothing to read. Fix the one line:

```yaml
# fixtures/first-build-errors/data-path/mizzen.yml
collections:
  sensors:
    source: _data/sensors.yml
```

Run the same check again; it prints `0 errors, 0 warnings` and the record page is built at `/sensors/thermometer/`.
A source outside the site root is reported as `data.source-outside-root`, so keep the file under the site folder.

## 2. A record does not match its schema

```text
_data/sensors.yml:3:11  data.record-invalid  Field "status" of record "thermometer" in "sensors" must be one of "stable", "beta". The record was skipped.
data.records-skipped  Skipped 1 record that failed validation.
  help: Fix each record's finding, or set `collections.<name>.onInvalid: skip` to keep building without it.
1 error, 0 warnings, 1 info
```

The position points at the value, not the file: line 3 is `status: retired`, which the schema allows neither as
`stable` nor as `beta`:

```json
"status": { "type": "string", "enum": ["stable", "beta"] }
```

The record is left out of the site, so the page for it is not built. Change the value to one the schema allows:

```yaml
# fixtures/first-build-errors/schema/_data/sensors.yml
- slug: thermometer
  name: Thermometer
  status: stable
```

The error and the `data.records-skipped` info line both disappear. If one bad record should not stop the whole build,
set `collections.sensors.onInvalid: skip`; the record is still left out, and the info line still names how many were
skipped.

## 3. The base path is not a path

```text
mizzen.yml:3:7  config.invalid  `base` must match pattern "^(/.*[^/])?$".
1 error, 0 warnings
```

`base` is the folder the site lives under on its domain: empty at a domain root, otherwise it starts with `/` and has
no trailing slash. `docs/` breaks both rules, so the config is rejected before any page is built. Fix it to:

```yaml
# fixtures/first-build-errors/base-path/mizzen.yml
url: https://example.com
base: /docs
```

Every URL the engine writes now starts with `/docs`, so the home page is `/docs/` and the sitemap names
`https://example.com/docs/`. At a domain root, remove the line instead of setting it to `/`.

## The three in one run

```sh
for dir in data-path schema base-path; do
  node bin/mizzen.ts check "fixtures/first-build-errors/$dir" --theme ../lateen
done
```

Each folder is a working site once its one line is fixed. The fixture's `README.md` holds the same table, and
[Data findings](/data/validation/) lists every collection diagnostic with its meaning and fix.

## Where next

[From a data file to a page](/first-project/) shows the data, collection, template, and list page that make these
checks pass. [Configuration](/config/) covers `base`, and [Collections](/data/collections/) covers `source`, `schema`,
and `onInvalid`.
