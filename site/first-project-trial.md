---
title: Try a migration on a branch
description: Preview a data-driven section beside the current pages, read the check report, fix the one manual item, and compare the two builds before merging.
layout: doc
permalink: /first-project-trial/
---

# Try a migration on a branch

A trial keeps the current site as it is and adds one data-driven section beside it. You build the old site and the
new site into two folders, compare them, and merge only when the report is what you expect.

Run the commands from your site folder. They use `npx mizzen`; in a checkout of this repository the same arguments
work with `node bin/mizzen.ts` and the site folder named, for example `node bin/mizzen.ts check site`.

## Before and after

The trial moves the sensors section from pages written by hand to one data file:

| | Before | After |
| --- | --- | --- |
| Record page | `sensors/thermometer.md` | `_data/sensors.yml` + `_templates/sensors.md` |
| List page | a table kept by hand in `index.md` | `sensors/index.md`, built from the data |
| URL | `/sensors/thermometer/` | `/sensors/thermometer/`, unchanged |
| Second record | another Markdown file | one more item in the YAML file |

Before:

```text
handbook/
  index.md
  sensors/thermometer.md
```

After:

```text
handbook/
  index.md
  sensors/index.md
  _data/sensors.yml
  _templates/sensors.md
```

## 1. Branch and build the current site

```sh
git switch -c try-data-pages
npx mizzen check .
npx mizzen build . --out _site-before
```

`_site-before` is a preview of the site as it is now: open `_site-before/index.html` in a browser and follow a link.
It is a build folder, not a published one; keep both `_site-before` and `_site-after` out of git.

## 2. Move one section

Add the records:

```yaml
# _data/sensors.yml
- slug: thermometer
  name: Thermometer
  summary: A **thermometer** reports the temperature of a probe.
  interface: I2C
  range: -40 to 125 °C
  status: stable
- slug: barometer
  name: Barometer
  summary: A **barometer** reports air pressure.
  interface: SPI
  range: 300 to 1100 hPa
  status: stable
```

Add the page every record is built from:

```md
---
title: "{name}"
layout: doc
---
# :field[name]

:field[summary]

Interface: :field[interface] · Range: :field[range] · Status: :field[status]
```

Add the collection to `mizzen.yml`:

```yaml
collections:
  sensors:
    source: _data/sensors.yml
    id: slug
    template: _templates/sensors.md
    permalink: /sensors/{slug}/
    markdown: [summary]
```

Delete `sensors/thermometer.md`, and in `index.md` point at the list page instead of the single page:

```md
---
title: Handbook
layout: doc
---
# Handbook

This catalogue is built from one data file. Browse the [sensors](/sensors/).
```

The first two records now build at `/sensors/thermometer/` and `/sensors/barometer/`. The home page links to
`/sensors/`, which does not exist yet.

## 3. Read the report

```sh
npx mizzen check .
```

```text
index.md:7:56  link.missing-page  The link to "/sensors/" names no page or redirect on this site.
  help: Fix the link, or add the page or a redirect it names.
0 errors, 1 warning
```

Each finding is `file:line:column`, the diagnostic code, and one sentence. The `help` line says what to change.
`check` exits `0` when there are no errors, `1` when there is at least one error, and `2` on a usage problem; a warning
alone does not fail it. Pass `--format json` to read the same findings in a script.

The warning names the one thing the data cannot write: the list page. Add `sensors/index.md`:

```md
---
title: Sensors
layout: doc
list:
  collection: sensors
  sort: [name]
  fields: [name, interface, status]
---
# Sensors

::data-table{from=sensors columns="name,interface,status" sort=name}
```

Run `npx mizzen check .` again; it now prints `0 errors, 0 warnings`.

## 4. Preview and compare

```sh
npx mizzen build . --out _site-after
npx mizzen diff _site-before _site-after
```

The report on this example; your hashes, and the count of theme and search files, will differ:

```text
mizzen diff da3d2925a84e..847d75e0dc91: pages: 2 added, 2 changed; 30 other files changed; 1 record changed; 1 render-only.

Added pages:
  /sensors/  sensors/index.md
  /sensors/barometer/  _data/sensors.yml

Changed pages:
  /  index.md  [html] render-only
  /sensors/thermometer/  _data/sensors.yml  [source, text, html]
```

Read it as three answers:

- The two added pages are the list page and the new record.
- `/sensors/thermometer/` kept its URL. It changed because its source moved from Markdown to data, so the report lists
  `source`, `text`, and `html`.
- `/` changed as `render-only`: its Markdown only changed its link, but the built HTML changed too. `render-only` is
  the kind to review, because nothing in the Markdown explains it.

Open `_site-after/index.html` and compare it with `_site-before/index.html`.

## 5. Lock the URLs

```sh
npx mizzen build . --out _site-after --update-urls
npx mizzen urls check .
```

```text
2 records checked against urls.lock.json: 0 new, 0 changed, 0 removed.
```

`urls check` reads the same comparison without building and writes nothing. Commit `urls.lock.json` with the data and
the list page. A later edit that moves `/sensors/thermometer/` then fails the build with `urls.url-changed` instead of
publishing a broken link.

## 6. Build the branch against main

```sh
npx mizzen diff --base main .
```

This builds `main` and the current tree in the same run and removes both temporary folders afterwards. It is the
comparison to read before merging, and `--fail-on broken-urls` fails the command when a removed page, or a moved one
with no redirect at its old URL, leaves a published URL unanswered.

When the report is right, commit the data, template, list page, config, and lock file, then merge the branch. To stop
the trial instead, `git switch main`; `_site-before` and the branch are still there.

A collection backed by a snapshot has one more check: `npx mizzen data verify .` compares the data with the lock and
writes nothing.

## What stays manual

- One list page per collection; data cannot decide which URL lists the records.
- Links in existing pages that pointed at a hand-written record page still need their target checked.
- Fields the old page had but the data does not, such as a description or a date, need a column in the data file and a
  line in the template.
