---
title: Data findings
description: Every diagnostic a data collection can produce, what it means, and how to fix it.
---

# Data findings

A site built from data reports findings with the same envelope as every other finding: `mizzen check --format text`,
`--format json`, or `--format sarif`. Every id starts with `data.`, and an id is never reused for another meaning.
`mizzen doctor` adds its own `doctor.data-summary` line saying how many collections, records, and schemas it read.

A record that fails its schema is left out of the site; `collections.<name>.onInvalid` decides whether that fails the
build (`error`, the default) or only warns (`skip`). Either way the build ends with `data.records-skipped`.

A `data.record-invalid` finding may also carry a `fix`: a safe replacement of one source span. It names the value span
for a near-miss enum value, or for a number or boolean written as a string; it names the key — or the CSV header cell —
for a near-miss field name. A fix is offered only when the record still validates with the corrected value and the
replacement reads back the same in the source's format (a JSON string keeps its quotes, and a YAML string is quoted so
`true`, `null`, and `1` stay strings). Otherwise the finding carries `help` only, and a date never gets a guessed fix:
its help names the two accepted formats.

## Sources

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.source-missing` | The collection's source file does not exist. | Check `collections.<name>.source` in `mizzen.yml`, or run `mizzen data fetch` for a pinned source. |
| `data.source-unreadable` | The source file exists but cannot be read. | Point the collection at a readable file. |
| `data.source-kind` | The source has no supported extension. | Use a `.yml`, `.yaml`, `.json`, or `.csv` source. |
| `data.source-outside-root` | The source path resolves outside the site root. | Keep a collection source inside the site. |
| `data.source-scheme` | A remote source does not start with `https://`. | Use `https://`, or keep the file inside the site. |
| `data.source-too-large` | The source is larger than `limits.bytes`. | Raise `collections.<name>.limits.bytes`, or split the source. |
| `data.too-many-records` | The source holds more records than `limits.records`. | Raise `collections.<name>.limits.records`, or split the source. |
| `data.field-too-large` | One field is longer than `limits.field`. | Raise `collections.<name>.limits.field`, or shorten the value. |
| `data.invalid-json` | A JSON source cannot be parsed. | Fix the JSON syntax. |
| `data.invalid-yaml` | A YAML source cannot be parsed. | Fix the YAML syntax. |
| `data.collection-shape` | The source is neither a list of records nor a mapping of id to record. | Start the file with `- id: …` for a list, or `id:` followed by fields for a mapping. |
| `data.record-not-mapping` | An entry of the source is not a mapping of fields. | Write each record as `field: value` pairs. |
| `data.record-missing-id` | A record has no scalar field to use as its id. | Add the id field, or set `collections.<name>.id` to another field. |

## Templates

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.template-path` | A collection's `template` is not a `.md` or `.markdown` file under `_templates/`, or it resolves outside `_templates/` or the source folder, including through a symbolic link. | Point `collections.<name>.template` at a Markdown file under `_templates/`. |
| `data.template-missing` | The template a collection names does not exist. | Create the file under `_templates/`, or fix `collections.<name>.template`. |
| `data.template-unreadable` | The template exists but cannot be read. | Point `collections.<name>.template` at a readable Markdown file. |

## Record pages

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.frontmatter-missing-field` | A template's front matter names a field the record does not hold as a scalar. | Add the field to the record, or remove the placeholder. |
| `data.frontmatter-unknown-field` | A template's front matter names a field the collection's schema does not declare. | Use a declared field, or write `{{` for a literal brace. |
| `data.frontmatter-empty` | A front matter value is empty once filled. | Point it at a field with text, or set a literal value. |
| `data.field-path` | A `:field[…]` directive has no field name. | Write the name inside the brackets. |
| `data.unknown-field` | A `:field[…]` names a field the collection's schema does not declare. | Use a declared field, or add it to the schema and the data. |
| `data.block-field` | An `:::if` or `:::each` block has no `field` attribute. | Write `{field=<name>}`. |
| `data.each-not-list` | An `:::each` block names a field that is not a list. | Point it at a list field. |
| `data.block-nesting` | A template block is nested more than one level deep. | Nest one block inside another, not more. |
| `data.records-from` | A `:::records` block has no `from` collection. | Write `{from=<collection>}`. |
| `data.unknown-collection` | A `:::records` block names a collection the site does not have. | Name a collection the config declares. |
| `data.records-where` | A `:::records` block's `where` is not one `field=field` pair. | Write `where="parent=id"`, or remove it. |
| `data.records-limit` | A `:::records` block's `limit` is not a whole number of at least 1. | Write `limit=3`, or remove it. |
| `data.permalink-field` | A URL pattern names a field the record does not hold as a scalar. | Add the field, or change `collections.<name>.permalink`. |
| `data.permalink-filter` | A URL pattern names a filter that does not exist. | The only filter is `slug`, written `{name|slug}`. |
| `data.permalink-slug` | The `slug` filter turns a field into an empty string. | Give the record a value with a letter or digit, or drop the filter. |
| `data.permalink-disambiguator` | The collection's `disambiguate` field is missing or has no letters or digits. | Add the field to the record, or change `collections.<name>.disambiguate`. |
| `data.permalink-collision` | Two records of one collection build the same URL. | Set `collections.<name>.disambiguate`, or put another field in the URL pattern. |

## Stable URLs

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.urls-lock-invalid` | `urls.lock.json` cannot be read or does not have the expected shape. | Fix the file, or run `mizzen build --update-urls` to write it again. |
| `urls.url-changed` | A record page's URL differs from the one in the lock. | Run `mizzen build --update-urls` to keep the old URL redirecting, or restore the old URL. |
| `urls.url-updated` | Info: `--update-urls` accepted a changed URL and kept the old one as a redirect. | Nothing; the lock and the redirects now agree. |
| `urls.new-records` | Info: records the lock does not hold yet. | Run `mizzen build --update-urls` to write them to the lock. |
| `urls.removed` | A record the lock published is no longer in its collection, and the collection's `onRemoved` is `error` or unset. | Add the record back, or set `collections.<name>.onRemoved`. |
| `urls.id-reused` | A record takes the id of one that was removed from a published URL. | Give the record another id, or run `mizzen build --update-urls` to publish it under that id. |
| `urls.alias-unaddressed` | A record's `aliases` field names an earlier id, but the URL pattern does not use the id. | Name the id in the pattern, or write the earlier address as a path. |


## CSV

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.csv-missing-header` | The file has no header row. | Name every column on the first line. |
| `data.csv-empty-header` | A header cell is empty. | Give every column a name. |
| `data.csv-duplicate-header` | Two header cells name the same column. | Rename one of them. |
| `data.csv-row-length` | A row's cell count differs from the header's. | Match the header's count, and quote a cell that holds a comma. |
| `data.csv-unclosed-quote` | A quoted cell is never closed. | Close the quote on the same or a later line. |

## Pinned sources

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.lock-missing` | An `npm:` or `https:` source has no entry in `mizzen.lock.json`. | Run `mizzen data fetch`. |
| `data.lock-invalid` | The lock file cannot be read or does not have the expected shape. | Fix `mizzen.lock.json`, or run `mizzen data fetch` to write it again. |
| `data.lock-mismatch` | The installed package no longer matches its lock entry. | Run `mizzen data fetch` to pin the installed version again. |
| `data.store-missing` | A remote source's stored bytes are missing. | Run `mizzen data fetch`. |
| `data.store-unreadable` | A remote source's stored bytes cannot be read. | Run `mizzen data fetch`. |
| `data.store-mismatch` | A remote source's stored bytes no longer match the lock. | Run `mizzen data fetch` to restore the pinned bytes. |
| `data.package-bad-address` | An `npm:` address is malformed. | Write `npm:<package>/<path>`, such as `npm:@scope/data/items.yml`. |
| `data.package-missing` | The named package is not installed. | Install the package. |
| `data.package-version` | The package has no readable version. | Install a published version of the package. |
| `data.package-path-missing` | The named file is not in the package. | Point the collection at a file the package ships. |
| `data.package-escape` | The named path resolves outside the package. | Keep the path inside the package. |

## Records

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.schema-missing` | The schema file a collection names cannot be read. | Check `collections.<name>.schema` in `mizzen.yml`. |
| `data.schema-invalid` | The schema is not JSON, is not an object, or cannot be compiled. | Fix the schema; write out a remote `$ref` in the file, since a build reads no network. |
| `data.record-invalid` | A record fails its collection's schema. The message names the record and the field, and points at the field's value. | Fix the field the message names. |
| `data.records-skipped` | Info: how many records the build left out because they failed validation. | Fix each record's finding, or set `collections.<name>.onInvalid: skip`. |
| `data.duplicate-id` | Two records share an id. | Give each record its own id. |
| `data.duplicate-value` | Two records share a value in a field listed under `unique`. | Make the value unique. |
| `data.reference-missing` | A reference field names an id the target collection does not have. | Use an id from the target collection. |
| `data.reference-invalid` | A reference field holds something other than an id or a list of ids. | Write an id, or a list of ids. |
| `data.reference-unknown-collection` | A `references` entry names a collection the config does not declare. | Declare that collection, or point the reference at one that exists. |
| `data.date-invalid` | A field listed under `dates` is not `YYYY-MM-DD` or a full ISO 8601 instant. | Write `YYYY-MM-DD`, such as `2026-01-31`, or a full instant such as `2026-01-31T09:00:00Z`. |

## Page directives

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.unknown-path` | A `:data[…]` path resolves to no value. | Name a path the site's data holds. |
| `data.not-a-scalar` | A `:data[…]` path resolves to a list or mapping, which a page cannot show as text. | Point the directive at a string, number, or boolean. |
| `data.table-attributes` | A `::data-table{…}` directive has a bad or unknown attribute. | Check the attribute names: `from`, `columns`, `sort`, and `where`. |
| `data.table-unknown-source` | A `::data-table` names a source that is no collection and holds no records. | Use a collection name or a path to a list in `_data`. |
| `data.table-unknown-column` | A `::data-table` names a column the records do not have. | Use a field path the records hold. |
| `data.table-where` | A `::data-table` filter is malformed. | Write one pair with its value quoted, such as `where="status=stable"`. |
