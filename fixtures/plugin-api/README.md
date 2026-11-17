# Plugin API fixture

A two-page site whose `mizzen.config.ts` adds behavior through the public plugin contract in `docs/plugin-api.md`.

| Plugin | Hook | Adds |
| --- | --- | --- |
| `require-description` | `content` | A validation rule: a doc page without a `description` fails the hook. |
| `reading-time` | `content` | `frontMatter.readingTime`, derived from the page's Markdown. |
| `inventory` | `model` | `site.data.pluginApi`, the list of pages fixed once on the assembled model. |
| `write-inventory` | `outputs` | `plugin-api/inventory.json`, a custom output file. |

The plugins are listed in that order, so the validator sees a page before `reading-time` changes it, and the model
pass fixes the list the outputs hook writes. All pages pass the validator, so a build is clean.
