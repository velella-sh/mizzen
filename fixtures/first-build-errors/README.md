# First build errors

Three small sites, each with one mistake a first build reports. Run `check` from the repository root with the Lateen
checkout from [Setup](../README.md) beside it:

```sh
node bin/mizzen.ts check fixtures/first-build-errors/data-path --theme ../lateen
node bin/mizzen.ts check fixtures/first-build-errors/schema --theme ../lateen
node bin/mizzen.ts check fixtures/first-build-errors/base-path --theme ../lateen
```

| Folder | Finding | Fix |
| --- | --- | --- |
| `data-path/` | `data.source-missing` | Point `source` at `_data/sensors.yml`, the file that exists. |
| `schema/` | `data.record-invalid` | Change `status: retired` to a value in the schema's enum. |
| `base-path/` | `config.invalid` | Write `base: /docs`, with a leading slash and no trailing one. |

Each folder is a working site once its one line is fixed; nothing else in it needs to change. The guide is
`site/first-project-errors.md`.
