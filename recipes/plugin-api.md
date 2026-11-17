# Recipe: a content validator, a Markdown transformation, and a custom output

The runnable site is [`examples/plugin-api/`](../examples/plugin-api/README.md): two pages and three plugins that use
only `@velella/mizzen/contracts`. The full contract is [`docs/plugin-api.md`](../docs/plugin-api.md).

The site's code file is `mizzen.config.ts` at the site root. It lists the plugins in the order they run and sets no
`mizzen.yml` key:

```ts
import { checkDescriptions } from "./plugins/check-descriptions.ts";
import { numberSections } from "./plugins/number-sections.ts";
import { writePageIndex } from "./plugins/write-page-index.ts";

export default { plugins: [checkDescriptions, numberSections, writePageIndex] };
```

`loadCodeConfig()` reads the file before the model is built. A file Node cannot import, or a default export without a
`plugins` list, is one `plugin.load-failed` or `plugin.invalid-code-config` error and no plugin runs. An entry that is
not a plugin is dropped with `plugin.invalid-plugin`, a later entry with a repeated name with `plugin.duplicate-name`,
and the sound entries still run.

## Validate a page

`validate` runs once per final page, after every `content` hook. It returns findings, not a page; each keeps its own
`id`, `severity`, `message`, and position, and a warning does not fail the build.

```ts
import type { Diagnostic, Plugin } from "@velella/mizzen/contracts";

export const checkDescriptions: Plugin = {
  name: "check-descriptions",
  inputs: [],
  validate(page) {
    if (page.kind !== "doc" || page.frontMatter.description !== undefined) return [];
    const finding: Diagnostic = {
      id: "example.missing-description",
      severity: "warning",
      message: `${page.source.file} has no description.`,
      pos: page.source,
    };
    return [finding];
  },
};
```

A hook that throws, returns something that is not a list of diagnostics, or misses its 10-second deadline is
`plugin.hook-failed` or `plugin.hook-timeout`, positioned at the page source and naming the plugin and the stage. The
plugins after it still run.

## Transform Markdown

`markdown` runs once per page after includes and before parsing. It returns the body to parse, and the body must keep
its line count, so heading and diagnostic positions stay those of the source. This example numbers every second-level
heading:

```ts
import type { Plugin } from "@velella/mizzen/contracts";

export const numberSections: Plugin = {
  name: "number-sections",
  inputs: [],
  markdown(source) {
    let section = 0;
    return source.markdown.replace(/^## /gmu, () => {
      section += 1;
      return `## ${section}. `;
    });
  },
};
```

Rendered HTML, headings, and the Markdown twin all come from the transformed body, so they agree.

## Write a custom output

`outputs` runs once with every file the enabled outputs produced and with the assembled site. Append a file to add
one, remove a file to drop it, and return the list:

```ts
import type { OutputFile, Plugin } from "@velella/mizzen/contracts";

export const writePageIndex: Plugin = {
  name: "write-page-index",
  inputs: [],
  outputs(files, site) {
    const pages = site.pages.map((page) => ({ url: page.url, title: page.title }));
    const file: OutputFile = { path: "plugin-api/pages.json", contents: `${JSON.stringify(pages, null, 2)}\n` };
    return [...files, file];
  },
};
```

A path is relative to the output folder, uses `/`, and never leaves it. A path outside the folder or one another
output already writes is `output.bad-path` or `output.duplicate-path`, and that file is dropped while the rest are
written. The site's own files win at the same path with no diagnostic.

## Cache: declare what the plugin reads

The build cache key includes the code file and every plugin's `version`, `settings`, and `inputs`. A plugin that reads
no file declares `inputs: []`; one that reads a site file lists it, with `/` separators:

```ts
export const fromFile: Plugin = {
  name: "from-file",
  version: "1",
  inputs: ["_data/glossary.yml"],
  content(page) {
    /* ... */
  },
};
```

Bump `version` when behavior changes without the code or a declared input changing. A plugin that omits `inputs` cannot
be tracked, so a site that lists it always builds cold. A declaration the engine cannot honor, such as an absolute path
or one outside the site, also builds cold. The hooks do not run on a cache hit, but the code file is imported to read
its declarations, so its top-level code runs.

## Determinism boundary

The engine promises byte-identical output, in the same order, for fixed input and a deterministic plugin. A plugin
keeps its side by deriving results only from the values it is handed; by not reading the clock, randomness, the
environment, the network, git, or an absolute path; by ordering every list it returns; by returning new values instead
of mutating its input; and by keeping no state between hook calls. The engine cannot detect a plugin that breaks these
rules. It copies each hook's input, checks the returned shape, and stops waiting after the deadline, but none of that
makes a nondeterministic plugin deterministic or sandboxes it.

## Run the example

```sh
node bin/mizzen.ts build examples/plugin-api --out .tmp/plugin-api
```

Two builds write the same bytes, and so does a build served from the cache. `test/plugin-api/acceptance.test.ts` runs
the example, checks all three hooks reach the output, and compares repeated and incremental builds with a full one.
