# Audit: cross-site links to a renamed record

Epic: #509. Baseline for #510, recorded before the epic's engine changes. The baseline test is
`test/record-links/baseline.test.ts`.

## Fixture

Two projects in one `network.lock.json`:

| Project | Path | Locked pages |
| --- | --- | --- |
| Ebb | `ebb` | `items.ebb` at `/items/ebb/`, plus another record |
| Offing | `offing` | its own pages |

Ebb builds `collections.items` with `permalink: /items/{name|slug}/`, sets `url: https://example.org`, and therefore
publishes the record at `/ebb/items/ebb/`. Offing writes `[[ebb:/items/ebb/]]`. The record is renamed to `Ebb Renamed`,
the slug becomes `ebb-renamed`, and Ebb accepts the change with `mizzen build --update-urls`.

## What already works

- A cross-project link is matched by the locked page path, not by a record: `[[ebb:/items/ebb/]]` renders as
  `/ebb/items/ebb/`, and a path missing from Ebb's locked page list is `network.link-missing-page` with the link's file
  and line.
- `urls.json` maps the stable record id to the page URL: `collections.items.ebb` stays the key after the rename and its
  value follows the new slug. With `url` set, the value is absolute.
- `urls.lock.json` keeps the id and its earlier URLs. Once `--update-urls` accepts the rename, `Page.record.previousUrls`
  carries `/ebb/items/ebb/`, and the redirects output writes a redirect page there plus a `_redirects` line. Every later
  ordinary build serves the same redirect, so the owner side of the goal already holds without engine changes.

## Confirmed gaps

1. **A cross-project link names a path, not a record.** After `network update` replaces the locked path with
   `/items/ebb-renamed/`, Offing's existing link is an error and must be rewritten by hand. There is no
   `[[project:collection/id]]` form.
2. **`urls.json` stops at the site boundary.** No engine part reads another project's `urls.json`, and `network update`
   stores only paths, titles, and hashes from `manifest.json`; record ids never reach the referring site, so Offing
   cannot look up `items.ebb`.
3. **The link check does not follow the owner's redirects.** Ebb still answers `/ebb/items/ebb/` with a redirect, but
   that fact lives only in Ebb's `urls.lock.json` and output. The locked page list holds current pages, so Offing's link
   to the old path is an error even though a browser would reach the new page.

## Verdict

The current settings are sufficient for the publishing site but not for the referring site: the old URL survives, but
the cross-site link itself breaks on a rename. #511 and #512 add record reads and resolution from locked inputs, #513 is
the two-site acceptance test, and #514 the recipe.
