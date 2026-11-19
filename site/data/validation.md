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

## SQLite and NDJSON

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.sqlite-query` | A SQLite source query is empty, is not a single read-only statement, or contains a write. | Use one `SELECT` or `WITH` statement; comments are allowed. |
| `data.sqlite-unavailable` | `node:sqlite` is unavailable, or the database cannot be opened. | Run Node 24 or later, and point the source at a readable local database. |
| `data.sqlite-column` | A query result has no columns, or the configured key or order column is missing or duplicated. | Alias repeated columns and name columns that `sqlite.key` and `sqlite.order` mention. |
| `data.sqlite-key` | A row has no value in the key column, or two rows share an id. | Set `sqlite.key` to a unique column, or add `sqlite.order` to make the result deterministic. |
| `data.sqlite-type` | A column holds a type other than null, number, text, or blob. | Convert the value in the query, or set `sqlite.binary` to `base64` or `error`. |
| `data.record-duplicate-id` | An extraction produced two records with the same id. | Choose a unique `sqlite.key` or fix the duplicate rows in the source. |
| `data.extraction-missing` | The build needs an extraction that the lock does not hold. | Run `mizzen data extract`. |
| `data.extraction-stale` | The lock's extraction no longer matches the source or query. | Run `mizzen data extract` again and commit `mizzen.lock.json`. |

## API fetch

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.api-url` | A source or followed URL is not an acceptable address: not `https://`, or plain `http://` outside the loopback interface. | Use an `https://` source. |
| `data.api-origin` | A next-page URL names an origin outside the allowlist. | Add the origin under `collections.<name>.pagination.origins`, or fix the API. |
| `data.api-http` | A page returned a permanent error status. | Fix the source URL, or run the fetch again after the service recovers. |
| `data.api-request` | A request failed after its retries, or the service could not be reached. | Check the network and `pagination.retries`. |
| `data.api-redirect` | A response redirects too many times or names no usable location. | Point the source at the final URL. |
| `data.api-invalid-json` | A page is not valid JSON. | Fix the API response, or the source URL. |
| `data.api-records` | A page has no record array at the configured `records` path. | Fix `collections.<name>.records`. |
| `data.api-auth` | The environment variable named by `pagination.auth.env` is unset or empty. | Set the variable before `mizzen data fetch`. |
| `data.api-cursor` | A response writes a cursor that is not a string. | Fix the API, or the `pagination.cursor` path. |
| `data.api-cursor-repeat` | The API returned a cursor it already returned. | Fix the API's cursor logic. |
| `data.api-next` | A response writes a next-page URL that is not a string, or not a URL. | Fix the API, or the `pagination.next` path. |
| `data.api-page-repeat` | A next-page URL repeats a page already read. | Fix the API's next-page link. |
| `data.api-too-many-pages` | A walk passed `pagination.maxPages`. | Raise `collections.<name>.pagination.maxPages`, or fix the end condition. |
| `data.api-too-large` | A walk passed `pagination.maxBytes`. | Raise `collections.<name>.pagination.maxBytes`, or split the API. |
| `data.api-source-too-large` | The combined records are larger than `limits.bytes`. | Raise `collections.<name>.limits.bytes`, or split the API. |
| `data.api-duplicate-id` | Two records on different pages share an id. | Make the API's ids unique. |

## Join

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.join-missing-key` | A record has no value for the configured join key and `onMissingKey: error` is set. | Fill the key in the source, or set `onMissingKey: skip`. |
| `data.join-conflict` | A destination field receives different values from more than one source and `onConflict: error` is set. | Map the field to one source, or choose a precedence policy. |
| `data.join-many` | A secondary source has more than one record for a key that expects one and `many: error` is set. | Make the key unique, or set `many` to `first`, `last`, or `list`. |
| `data.join-cycle` | Join sources form a cycle. | Remove the cycle so each collection enriches from a lower source. |

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
| `data.field-format` | A `{format=…}` name is not `short`, `long`, or `full`. | Write one of those three names. |
| `data.field-not-date` | A `{format=…}` is on a field that does not hold a date. | Use a format only on a date field, or remove it. |
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

## Aggregate collections

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.aggregate-source` | An aggregate names a source collection that did not load or is itself an aggregate. | Point `collections.<name>.source` at a collection read from a file. |
| `data.aggregate-by` | An aggregate groups by the same field more than once. | Name each grouping field once. |
| `data.aggregate-timezone` | A `period` has no time zone, or names one the runtime does not know. | Add `timezone: UTC` (or another IANA zone) to the `by` entry. |
| `data.aggregate-id-field` | An aggregate groups by the field its summary id is written under. | Set `collections.<name>.id` to another field, or group by another field. |
| `data.aggregate-metric-name` | A metric has the same name as a grouping field or the id field. | Rename the metric. |
| `data.aggregate-metric-field` | A metric other than `count` names no field. | Add `field: <name>` to the metric. |
| `data.aggregate-reference` | A before/after filter has no reference date. | Set `collections.<source>.referenceDate` to a date, or the site's `asOf`. |
| `data.aggregate-key` | A grouping value is not text, a finite number, or a boolean. | Group by a scalar field, or remove it from `aggregate.by`. |
| `data.aggregate-period` | A value grouped by month or year is not a date or an ISO 8601 instant. | Write a date, or stop grouping the field by a period. |
| `data.aggregate-number` | A `sum` or `average` value is not a finite number. | Write a number, or cast the field in the source collection's `transform` rules. |
| `data.aggregate-distinct` | A `count-distinct` value is not a scalar. | Count distinct values of a scalar field. |
| `data.aggregate-bound` | A `min` or `max` value is not text or a number, or one group mixes the two. | Cast the field so every value in the group has one kind. |

## List pages

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.list-shape` | A `list` key is not a mapping, or `perPage`, `splitGroups`, or `fields` has the wrong shape. | Write `list: { collection: posts, perPage: 10 }`. |
| `data.list-collection` | A `list` names a collection the site does not have. | Name a collection the config declares. |
| `data.list-where` | A `where` value is not a scalar, a list, or a mapping of `exists`, `before`, or `after`. | Write `status: stable`, `tags: [a, b]`, or `date: { after: 2026-01-01 }`. |
| `data.list-sort` | A `sort` is not one field or a list of one or two fields, or its direction is not `asc` or `desc`. | Write `sort: date desc` or a list of two; a field name has no spaces. |
| `data.list-group` | A `group` is not a field name or a mapping with a valid `field`, `by`, and `order`. | Write `group: status`, or `group: { field: date, by: month }`. |
| `data.list-field` | A `where`, `sort`, `group`, `fields`, or `expand.field` names a field that no record of the collection holds. | Use a field the records hold, or remove the key. |
| `data.list-empty` | A list matches no record. | Change `where`, or leave the list out until the collection has records. |
| `data.list-expand` | An `expand` has no `field` and `permalink`, or its pattern does not name `{value}`. | Write `expand: { field: tags, permalink: /tags/{value|slug}/ }`. |
| `data.reference-date` | A date filter compares against `reference`, but the collection has no usable reference date. | Set `collections.<name>.referenceDate` to a date or a `_data` path. |
| `data.count-attributes` | A `:count` directive has no `from` collection. | Write `:count{from=<collection>}`. |
| `data.count-where` | A `:count` directive's `where` is not one `field=value` pair. | Write `where="status=stable"`, or remove it. |

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
| `data.schema-required-field-added` | A required field the recorded baseline did not have; records recorded before it lack the field. | Fill the field in those records, make it optional, or record the collection again after updating its data. |
| `data.schema-optional-field-added` | A field the recorded baseline did not have, added as optional; earlier records still validate. A warning. | Nothing, or record the collection again to make it the new baseline. |
| `data.schema-field-removed` | A field the recorded baseline had is gone from the schema. A warning. | Keep the field, or update the data and record the collection again. |
| `data.schema-field-renamed` | A `schemaRenames` entry maps a baseline field to its new name, so the change is read as a rename, not a removal and an addition. A warning. | Update the data to the new name and record the collection again. |
| `data.schema-type-change` | A field's declared JSON type differs from the baseline's, so earlier records may no longer validate. | Migrate the records to the new type, or restore the field's type. |
| `data.schema-enum-removed` | A schema `enum` no longer accepts a value the baseline accepted; a record may still hold it. | Keep the value, or update the records that use it and record the collection again. |
| `data.schema-rename-conflict` | A record holds both the old and the new name of a `schemaRenames` pair; the new value is kept. A warning. | Remove the old field from the record, or drop the rename. |
| `data.record-invalid` | A record fails its collection's schema. The message names the record and the field, and points at the field's value. | Fix the field the message names. |
| `data.records-skipped` | Info: how many records the build left out because they failed validation. | Fix each record's finding, or set `collections.<name>.onInvalid: skip`. |
| `data.duplicate-id` | Two records share an id. | Give each record its own id. |
| `data.duplicate-value` | Two records share a value in a field listed under `unique`. | Make the value unique. |
| `data.reference-missing` | A reference field names an id the target collection does not have. | Use an id from the target collection. |
| `data.reference-invalid` | A reference field holds something other than an id or a list of ids. | Write an id, or a list of ids. |
| `data.reference-unknown-collection` | A `references` entry names a collection the config does not declare. | Declare that collection, or point the reference at one that exists. |
| `data.date-invalid` | A field listed under `dates` is not `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, or a full ISO 8601 instant. | Write `YYYY-MM-DD` such as `2026-01-31`, `YYYY-MM` such as `2026-01`, `YYYY` such as `2026`, or a full instant such as `2026-01-31T09:00:00Z`. |
| `data.seo-title-long` | Record pages have a title over `seo.titleMax` characters (default 70). A warning; the text is never shortened. | Shorten the field the title is built from, or raise `collections.<name>.seo.titleMax`. |
| `data.snapshot-field` | A `:snapshot[field]` names a field a snapshot does not have, or the collection has no snapshot in the lock. | Use one of `source`, `ref`, `capturedAt`, `tool`, `toolVersion`, and run `mizzen data snapshot <name>` to record one. |
| `data.seo-description-long` | Record pages have a description over `seo.descriptionMax` characters (default 160). A warning; the text is never shortened. | Shorten the field the description is built from, or raise `collections.<name>.seo.descriptionMax`. |
| `data.seo-title-empty` | Record pages have no title once the template is filled. A collection without a `seo` key is reported only for a blank title. | Add a `title` that names a field with text to the template's front matter. |
| `data.seo-description-empty` | Record pages have no description once the template is filled. A collection without a `seo` key is reported only for a blank description. | Add a `description` that names a field with text to the template's front matter. |
| `data.seo-duplicate-title` | Record pages of one language share a title. The finding names five URLs and the count of the rest; languages are never compared. | Build the title from a field that tells the records apart. |
| `data.seo-duplicate-description` | Record pages of one language share a description. The finding names five URLs and the count of the rest. | Build the description from a field that tells the records apart. |
| `data.json-ld-type` | A collection's `seo.jsonLd` mapping has no `@type`, so its record pages get no structured data. | Add an `@type` such as `Product` to the mapping. |
| `data.history-line` | A line in a collection's `data-changes/<name>.jsonl` cannot be read as a change event. | Fix the line, or run `mizzen data changes` to append the events again. |
| `data.public-reference` | A published template, URL, SEO, search, index, API, or feed setting names a field the collection's `public` allowlist excludes. | Add the field to `public`, or stop referencing it in public output. |
| `data.evidence-shape` | The `evidence` field is not a mapping of field names to claims, or a field's value is neither a claim nor a list of claims. | Write `evidence: <field>` and one claim mapping or a list of them. |
| `data.evidence-field` | An evidence key names no top-level field of the record. | Use a field the record has. |
| `data.evidence-claim` | A claim is not a mapping, or is missing a non-empty string `id`, `title`, or `url`. | Write all three as non-empty strings. |
| `data.evidence-url` | A claim URL is not an absolute `https:` URL or a root-relative path. | Use `https:` or `/path`. |
| `data.evidence-duplicate-id` | Two claims in one field share an id. | Give each claim its own id. |
| `data.report-run-invalid` | A run record has no id, date, or commit, so it cannot name the inputs it scanned. | Add the three fields the run collection expects. |
| `data.report-run-duplicate-id` | Two records publish the same run id. | Give each run its own id. |
| `data.report-run-untracked-overwrite` | A run id is published with different pinned inputs than before. | Keep the run's inputs fixed, or publish it under a new id. |

## Quality rules

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.quality-baseline` | `data-quality.json` is missing, is not JSON, is the wrong shape, or has no entry for a rule's scope. | Run `mizzen data quality --write` and commit `data-quality.json`. |
| `data.quality-collection` | A quality rule names a collection the config does not declare or could not load. | Point the rule at a loaded collection. |
| `data.quality-field` | A freshness rule has no `field`. | Write `field: <date field>` in `mizzen.yml`. |
| `data.quality-max-age` | A freshness rule has no `maxAgeDays`. | Write `maxAgeDays: <days>` in `mizzen.yml`. |
| `data.quality-date` | A record has no valid date in the freshness field. | Write `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, or a full ISO 8601 instant. |
| `data.quality-bounds` | A threshold or outlier rule has neither `min` nor `max`. | Write `min`, `max`, or both. |
| `data.quality-max-drop` | A coverage or count rule has no `maxDrop`. | Write `maxDrop`: percentage points for coverage, records for count. |
| `data.quality-exception` | A dated exception has expired, or it held back no finding. | Remove the exception, move its `until` date, or fix the rule/record/field it names. |

## Transformation

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.transform-step` | A rule names an unsupported date format or time zone, or an operator this engine does not know. | Fix the step under `collections.<name>.transform.steps`. |
| `data.transform-cast` | A value cannot reach the type a `cast` step asks for. | Write a value of that type, or change the step's `to`. |
| `data.transform-normalize` | A `normalize` step reads a field that is not text. | Point the step at a text field, or convert it first with `cast`. |
| `data.transform-map` | A `map` step meets a value its `values` does not name, while `unknown` is `error`. | Add the value to the mapping, or set `unknown` to `keep` or `default`. |
| `data.transform-date` | A value does not match a `date` step's format, names no real day, or is not text. | Write the date in the rule's format, or change the format. |
| `data.transform-unit` | A `unit` step reads a value that is not a finite number. | Write a number, or convert the field first with `cast`. |
| `data.transform-rename-conflict` | A `rename` step's destination already holds a value, and `onConflict` is `error`. | Remove the destination field, or set `onConflict: overwrite`. |
| `data.record-invalid-input` | With `validate: before-and-after`, the raw record does not match the collection's schema. The record is still transformed. | Fix the source value, or make the schema match the raw data. |
| `data.record-invalid-output` | The transformed record does not match the collection's schema; the finding names the step that last touched the field. | Fix the rule, or change the schema to the shape the rules produce. |

## Page directives

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.unknown-path` | A `:data[…]` path resolves to no value. | Name a path the site's data holds. |
| `data.not-a-scalar` | A `:data[…]` path resolves to a list or mapping, which a page cannot show as text. | Point the directive at a string, number, or boolean. |
| `data.table-attributes` | A `::data-table{…}` directive has a bad or unknown attribute. | Check the attribute names: `from`, `columns`, `sort`, and `where`. |
| `data.table-unknown-source` | A `::data-table` names a source that is no collection and holds no records. | Use a collection name or a path to a list in `_data`. |
| `data.table-unknown-column` | A `::data-table` names a column the records do not have. | Use a field path the records hold. |
| `data.table-where` | A `::data-table` filter is malformed. | Write one pair with its value quoted, such as `where="status=stable"`. |

## Blocks

| ID | Meaning | Fix |
| --- | --- | --- |
| `data.blocks-lock-invalid` | `blocks.lock.json` is not JSON or does not match its schema. | Fix the file, or run `mizzen build --update-blocks` to write it again. |
| `blocks.invalid-id` | A declared block id is not a lower-case slug, so the block falls back to an automatic id. | Write the id as lower-case letters, digits, and hyphens. |
| `blocks.marker-unused` | A `<!-- {#id} -->` marker has no block after it. | Move the marker directly above the block it names, or remove it. |
| `blocks.duplicate-id` | Two blocks share an id. | Give each block its own id; the message names both files and lines. |
