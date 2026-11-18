# First project samples

Three small sites that build with any theme that has a `doc` layout. They hold public data and configuration only:
every value is invented, and no layout code, styles, or theme code lives here.

| Sample | What it shows |
| --- | --- |
| `catalog/` | One data file, one template, one record page per sensor, and a list page. |
| `report/` | A current report and the previous one, each built from its own snapshot file, with a link to the source. |
| `mixed/` | A hand-written Markdown guide that links to a record and to a generated list. |

Build one from the repository root:

```sh
node bin/mizzen.ts build examples/first-project/catalog --out dist
node bin/mizzen.ts build examples/first-project/report --out dist
node bin/mizzen.ts build examples/first-project/mixed --out dist
```

`test/example-first-project.test.ts` builds each sample twice and checks both builds are byte for byte the same.

## Build them from the installed package

The release smoke test proves the samples work for a reader who installed the package, not only in this checkout.
From the repository root:

```sh
scripts/smoke-example.sh "$PWD" ../lateen
```

The script packs Mizzen and Lateen, installs both tarballs into an empty temporary project, copies each sample
there, sets `theme: name: "@velella/lateen"`, and builds it with `npx mizzen build sample-<name> --out out-<name>`.
A failed build exits the script. It ends with these lines:

```
the catalog first-project sample builds from the installed package
the report first-project sample builds from the installed package
the mixed first-project sample builds from the installed package
```

It also checks the files behind the guides' URLs: `catalog` writes `index.html`, `sensors/index.html`, and
`sensors/thermometer/index.html`; `report` writes `index.html` and `archive/index.html`; `mixed` writes
`guide/index.html`, `stations/index.html`, and `stations/riverside/index.html`.

`scripts/smoke-package.sh` calls this script, so CI and the release workflow run the same check against the
tarball they publish.

## The files

| File | What it is |
| --- | --- |
| `mizzen.yml` | The site config: the collections, their sources, and the record URLs. |
| `_data/` | The records, in YAML or JSON. |
| `_templates/` | The Markdown template of a record page. |
| `index.md` | A page. Some samples use a subdirectory for their list page. |

Every page sets `layout: doc`. A theme with record and list layouts can draw the pages itself: remove the `layout`
line and it receives `LayoutProps.record` and `LayoutProps.list`.
