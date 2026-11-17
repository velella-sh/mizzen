# Design note: documentation versions

Epic: docs-versions (#592). Status: accepted.

## Problem

A docs page is edited in place at one URL. A reader who bookmarks the install page is carried to the newest text, and a
release cannot be frozen: reading what `v1` said means finding the old commit. The engine already recognizes `vN`
folders. This note fixes the lifecycle those folders carry, the URL each state owns, and what a snapshot copies.

## The existing model, kept

`src/content/versions.ts` already decides what a version is and stays the base of the lifecycle:

- A version folder is the first source path segment, or the first after a configured root, never a URL segment.
- `v1`, `v1.2`, and `v1.2.3` are versions; another name counts only when a caller supplies the list.
- Pages outside every version folder are **current docs**. They are returned, not dropped.
- Version order is numeric; `versions.json` and `version-diff` read that model.

This note adds meaning to those folders. It does not change the detection rule, so an existing versioned site keeps its
pages, order, and URLs.

## Lifecycle

Four states, each with one meaning:

- **Current** — the working docs: page sources outside every version folder. An author edits these freely. They are not
  a release and may be published only as the default (see below).
- **Released** — a snapshot of the current docs and navigation in a new `vN/` folder. Its bytes are fixed when it is
  created; later edits to current docs never reach it.
- **Default** — the one release served at the site's canonical URLs. `current` is the default when the site names no
  release, so an unversioned site behaves exactly as it does today.
- **Old** — a released version that has been replaced. It keeps every versioned URL and is shown as old. It is not
  deleted by the lifecycle.

Default and old are dispositions of a release, not extra folders. A release that is neither is still published at its
versioned URLs; it is simply not the default and not marked old.

## The version file

The site root's `_data/versions.yml` records the dispositions. It is site data, so it needs no config-schema change and a
theme reads it as `site.data.versions`.

```yaml
default: v2   # a released version, or current; omitted means current
old: [v1]     # released versions replaced by the default
```

A missing file is a site with no version settings. A default that names no version folder, a version that is both
default and old, two defaults, or a repeated entry is a diagnostic at the file position; nothing is guessed. The CLI
edits this file, and a person may edit it directly.

## URL policy

Every page keeps its path inside its version. URLs are pretty URLs with the site `base`, as they are today.

| State | Canonical URL | Versioned URL | Written to the output |
| --- | --- | --- | --- |
| Current, default | `/path/` | — | yes |
| Current, not default | — | — | no |
| Released, not default | — | `/vN/path/` | yes |
| Default release | `/path/` | `/vN/path/` | yes, at both |
| Old release | — | `/vN/path/` | yes |

The rules these rows encode:

- **A versioned URL never moves.** A released page is always reachable at `/vN/path/`, including while its version is
  default and after it becomes old. Switching the default changes only which release owns `/path/`.
- **The default owns the canonical URL.** A page in the default release is written at both `/path/` and `/vN/path/`,
  and its canonical link is `/path/`. The other versioned URLs are unchanged.
- **Current docs are drafts while a release is default.** They stay in the model for editing, nav, and the next
  snapshot, but they are not written to the output: an unreleased edit must not be public at a URL that moves under it
  when the next default is chosen.
- **A versioned URL contains its version.** A page whose permalink removes the version folder has no stable versioned
  URL; a versioned site treats that permalink as a config error rather than inventing one.
- **`versions.json` keeps its meaning.** It lists the pages inside version folders and their versioned URLs, never the
  canonical alias and never a current page. The sitemap chooses one URL per page and does not list both.

## Snapshot boundary

A snapshot copies current content and navigation into a new version folder and nothing else:

- **Pages.** Every current page a build would publish, at the same relative path: `guide/install.md` becomes
  `v2/guide/install.md`. Front matter and Markdown are copied byte for byte, with LF endings.
- **Navigation.** The file at `config.navigation` is copied to the same relative path inside the version folder:
  `_data/navigation.yml` becomes `v2/_data/navigation.yml`. A link whose target is a snapshotted page is rewritten to
  that page's versioned URL, including `match`; external links, anchors, and links to files outside the snapshot stay as
  written. Each release therefore keeps the navigation it shipped with.

It does not copy the config, the theme, other `_data` files, data collections, lock files, build output, version
folders, or files that `include` and `exclude` keep out of the build. The version file is site state, not release
content.

Binary assets are shared, not versioned: `/assets/diagram.svg` keeps one URL in every release, so replacing it changes
every release. A site that needs frozen binaries must publish them under a versioned name of its own. This is the one
limit of the boundary, and it is deliberate: copying a whole repository would make a snapshot large and its diff
unreadable.

A snapshot is atomic and never overwrites:

- The new version name is unused and newer than every released version. A duplicate is refused before anything is
  written.
- The copy is staged in a temporary folder beside the target and renamed into place only when complete. A failure
  leaves the existing versions untouched and no half-written folder publishable.
- A released folder is immutable. A correction is a new release; the lifecycle never edits or deletes an old version.
  Removing one is a manual act and removes its URLs.

## Discovery on the fixture

`fixtures/docs-versions/` fixes these states and the discovery the engine already performs. Current docs live beside
`v1/` and `v2/`; `_data/versions.yml` makes `v2` default and `v1` old. `discoverVersions` returns the current pages with
`version: null` and the versioned pages as:

| Version | Path | Status |
| --- | --- | --- |
| `v1` | `guide/install.md` | — |
| `v1` | `guide/legacy.md` | `removed` |
| `v1` | `guide/upgrade.md` | — |
| `v2` | `guide/deploy.md` | `added` |
| `v2` | `guide/install.md` | — |
| `v2` | `guide/upgrade.md` | — |

The fixture already carries the per-version navigation a snapshot would produce. Until routing lands, a build writes
current pages at `/` and the versioned pages at `/v1/` and `/v2/`; the URL policy above is what later tasks make true.

## Pieces

| Piece | Where |
| --- | --- |
| Snapshot content and navigation | `src/versions/snapshot.ts` (#594) |
| Default selection and canonical routes | `src/versions/routing.ts` (#595) |
| Snapshot, default, and old commands | `src/cli/docs-version.ts` (#597) |
| End-to-end releases | `test/docs-versions/acceptance.test.ts` (#598) |
