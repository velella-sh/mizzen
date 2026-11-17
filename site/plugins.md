---
title: Plugins
description: Change pages, the site model, or the written files from mizzen.config.ts.
layout: doc
permalink: /plugins/
---

A site adds behavior from `mizzen.config.ts` at its root. The file default-exports its plugins and nothing else:

```ts
import type { Plugin } from "@velella/mizzen/contracts";

export default {
  plugins: [
    /* Plugin objects, in the order they run. */
  ],
};
```

A site without the file is an ordinary site: no plugins, no diagnostics. A file Node cannot import, or a default export without a `plugins` list, is one error naming the file. An entry that is not a plugin is dropped with an error and the sound entries still run.

A plugin is a `name` for diagnostics and any of five hooks. Each hook receives a value and returns the value the next plugin receives; none mutates its input. A hook may be async, and it is awaited before the next plugin runs.

| Hook | Runs | Receives | Returns |
| --- | --- | --- | --- |
| `markdown` | Once per page, after includes and before Markdown is parsed. | `MarkdownSource` | `string`, with the same line count |
| `content` | Once per page, after its Markdown is parsed and before the site model is assembled. | `Page` | `Page` |
| `validate` | Once per final page, after the `content` hooks. | `Page` | `readonly Diagnostic[]` |
| `model` | Once, after the site model is assembled and before anything is rendered. | `Site` | `Site` |
| `outputs` | Once, with the files the outputs produced and the site they came from, before the files are written. | `readonly OutputFile[]`, `Site` | `readonly OutputFile[]` |

A hook that throws, returns something the stage cannot use, or misses its 10-second deadline is `plugin.hook-failed` or `plugin.hook-timeout`; the message names the plugin and the stage. The value the stage carried before that plugin is kept and the plugins after it still run, so one bad plugin costs its own work and nothing more.

The runnable example is `examples/plugin-api/` in the engine's repository. `recipes/plugin-api.md` walks through the same hooks, and `docs/plugin-api.md` is the full contract.

<!-- readme-example: plugin -->
```ts
import type { Plugin } from "@velella/mizzen/contracts";

const banner: Plugin = {
  name: "banner",
  content(page) {
    return { ...page, frontMatter: { ...page.frontMatter, banner: true } };
  },
};

export default { plugins: [banner] };
```

The loader is `loadCodeConfig()` and the hook runners are `runMarkdownHooks()`, `runContentHooks()`, `runValidateHooks()`, `runModelHooks()`, and `runOutputsHooks()` in `src/plugins/`. Each runner returns `{ value, diagnostics }` and never fails the stage. `build()` loads `mizzen.config.ts` and runs every hook in the order above, once per stage, before anything is written. The file itself is never copied into the output.

A plugin also declares its cache inputs: `version`, `settings`, and `inputs`, the site-relative files its code reads. A site whose plugins all declare `inputs` is cached, and a change to a declared version, setting, declared file, or the code file misses. A plugin that omits `inputs` declares that its inputs cannot be tracked, so a site that lists it always builds cold; `inputs: []` declares that it reads no file.
