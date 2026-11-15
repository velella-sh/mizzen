# data-site fixture

A small site built from three data files. It is the shared fixture for the data pipeline: the engine
tests read it, and a theme repository can copy it. Every value is invented; no field names a real
product, company, or release.

The site has one config file and three sources under `_data/`, thirty records in total.

| File | Kind | Records | What it is |
| --- | --- | --- | --- |
| `mizzen.yml` | config | — | The site, and one `collections` entry per source. |
| `_data/components.yml` | YAML list | 12 | Interface parts the catalogue describes. |
| `_data/releases.json` | JSON object | 10 | Releases, keyed by version; the key is the id. |
| `_data/regions.csv` | CSV | 8 | Regions, one row each, with a header row. |

## `collections` in `mizzen.yml`

| Collection | `source` | `id` | Why |
| --- | --- | --- | --- |
| `components` | `_data/components.yml` | `slug` | The id is a field, named by the config rather than the default `id`. |
| `releases` | `_data/releases.json` | — | The id is the mapping key. |
| `regions` | `_data/regions.csv` | — | The id is the `id` column. |

Templates, URL patterns, and schemas arrive with the epics that build pages and validate records; this
fixture only carries the sources and the config that reads them.

## `_data/components.yml`

A YAML list of mappings, in the order the pages should appear.

| Field | Type | Meaning |
| --- | --- | --- |
| `slug` | string | The record's id. Lowercase letters and hyphens. |
| `name` | string | Display name. |
| `summary` | Markdown | A block of prose: bold, a list, and inline code. |
| `status` | string | `stable`, `beta`, or `deprecated`. Not checked by a schema yet. |
| `released` | date | `YYYY-MM-DD`. |
| `region` | reference | The `id` of a record in `regions`. |

## `_data/releases.json`

A JSON object keyed by version. The key is the record's id; the value is its fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `date` | date | `YYYY-MM-DD`. |
| `status` | string | `stable` or `beta`. |
| `summary` | Markdown | One line, or two paragraphs separated by a blank line. |
| `component` | reference | The `slug` of a record in `components`. |

## `_data/regions.csv`

RFC 4180 CSV with a header row: `id`, `name`, `code`, `note`. One `note` is quoted because it holds a
comma; the cell row spans one line, so the fixture stays simple to read. `id` is the record's id.

## Rules

This folder is read-only once other work depends on it. A test that needs a different shape adds a
fixture of its own beside this one rather than editing these files.
