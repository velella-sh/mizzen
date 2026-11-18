# Monthly report

A small installed-package example: raw sales rows, an aggregate collection that summarizes them by month, a summary
page, an archive page, and the same summary through the static API.

```bash
npm install @velella/mizzen
npx mizzen check .
npx mizzen build .
```

`_data/sales.yml` is the raw input. `monthly` reads it through `source: sales` and publishes one record per month; nothing
is written back to the raw file. `index.md` shows the newest months, `archive/index.md` keeps every month in reverse order,
and `/api/v1/monthly.json` carries the same counts for a machine reader.

The time zone is explicit. `2026-01-31T23:30:00Z` belongs to February in `Europe/Berlin`, while `2026-02-01T00:30:00Z`
also belongs to February: the report is the same on every machine and in every host zone.

Change the raw file, rebuild, and both the pages and the API move together. A record that moves between months updates
both months because the aggregate depends on its source collection as a whole, not only on the group it is in now.
