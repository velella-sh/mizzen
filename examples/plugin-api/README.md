# Plugin API example

A two-page site whose behavior lives in `mizzen.config.ts`: a content validator, a Markdown transformation, and a
custom output. The three plugins import only the public `Plugin` type from `@velella/mizzen/contracts`.

Build it from the repository root, which finds the sibling Lateen checkout as its theme:

```sh
node bin/mizzen.ts build examples/plugin-api --out .tmp/plugin-api
```

## The files

| File | What it is |
| --- | --- |
| `mizzen.yml` | The site config. It sets no plugin key: plugins come only from the code file. |
| `mizzen.config.ts` | The code file: default-exports the three plugins in the order they run. |
| `plugins/check-descriptions.ts` | The `validate` example: warns when a doc page has no `description`. |
| `plugins/number-sections.ts` | The `markdown` example: numbers every `##` heading before parsing, keeping the line count. |
| `plugins/write-page-index.ts` | The `outputs` example: writes `plugin-api/pages.json` with every page's URL and title. |
| `index.md`, `guide/writing.md` | The two pages the plugins see. |

Every plugin declares `inputs: []` because none reads a file, so two builds share one cache entry. The recipe in
[`recipes/plugin-api.md`](../../recipes/plugin-api.md) walks through the same three hooks, and
[`docs/plugin-api.md`](../../docs/plugin-api.md) is the full contract.
