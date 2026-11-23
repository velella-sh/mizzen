# Publish check reports

Enable `outputs.check-report: true` in `mizzen.yml`, place a reviewed public report set in
`_data/report-set.json`, and run `mizzen build`. Set
`schemaVersion` to 1 and give the report a `title` and a slash-delimited `route`, such as
`/checks/`. The build writes the overview at that route, one linked document per run and
configured comparison, and `data.json` under the same route. Report-aware themes render
findings, comparisons and trends. Each document also links to the JSON.

See [report-set.schema.json](../schema/report-set.schema.json) for the input contract. This file
is an explicit publication input. Include only approved public data. Each producer maps its
own results into the contract. Give each finding an id stable across comparable runs. Severity
and check outcome are independent. Use `unknown` when the source makes no severity claim.

Order runs chronologically within each tool and scope, and supply explicit dates to plot their
measurements. Each comparison names two existing runs with `base` and `head`. Different tools
or scopes make a pair incomparable. Partial or unavailable coverage suppresses inferred
changes and creates a gap in the trend. A change in a metric's unit creates a separate series.
Findings and comparisons paginate after 50 rows.

## Collect a doctor run

The optional `@velella/mizzen/reports` export collects one real doctor run. Supply the same
scope for runs that check the same project with comparable inputs and settings.

```js
import { collectDoctorRun } from "@velella/mizzen/reports";

const run = await collectDoctorRun(
  { root: "docs", themeRoot: "node_modules/@velella/lateen" },
  { id: "release-1", scope: "public-docs", date: "2026-11-23" },
);
```

Review the resulting object before adding it to `runs`. Doctor keys findings by rule, relative
file, message and occurrence. A line move keeps the key when the occurrence stays the same.
A changed diagnostic message can appear as a new finding and a resolved finding.

## Contract change

The additive contracts are `ReportSet`, `PreparedReport`, `ReportView`, `Site.checkReport`
and `Page.reportView`. They connect model construction, the JSON output and report-aware
doc layouts. Each ordinary build without a report input uses its existing page and site shape.
