# Design: the plugin contract

Status: accepted. Epic: plugin-api (#599). Audit issue: #600.

## Purpose

A site adds behavior in `mizzen.config.ts`: validate pages, transform Markdown, change the model, and add files. The
engine promises a deterministic build, so what a plugin may read, change, and return is a contract and not advice. This
note audits the hooks as they exist, fixes their public contract, and states the trusted-code policy. The sample site is
`fixtures/plugin-api/`.

## How plugins are enabled

The site's code file is `mizzen.config.ts` at the site root, beside `mizzen.yml`. It default-exports the plugins and
nothing else:

```ts
import type { Plugin } from "@velella/mizzen/contracts";

export default {
  plugins: [
    /* Plugin objects, in the order they run. */
  ],
};
```

`loadCodeConfig()` in `src/plugins/hooks.ts` reads it before the model is built. The rules:

- A site without the file has no plugins and no diagnostic.
- A file Node cannot import is one `plugin.load-failed` error, and no plugin runs.
- A default export that is not `{ plugins: [...] }` is one `plugin.invalid-code-config` error, and no plugin runs.
- An entry that is not an object with a non-empty `name`, or has a hook that is not a function, is one
  `plugin.invalid-plugin` error. That entry is dropped and the sound entries still run.
- A later entry with the same `name` as an earlier one is one `plugin.duplicate-name` error. That entry is dropped and
  the first one keeps the name, so a diagnostic always names one plugin.
- Other exports of the file are ignored. The file sets no `mizzen.yml` key and is never copied to the output.
- The module is imported once per build with a content hash in its URL, so an edited file is imported again.

A site with a code file always builds cold: what its imports read cannot be part of the cache key, so a cache hit
could restore stale output. The epic later replaces this with declared plugin inputs (#604).

## Stages and order

A build runs config, discover, front matter, Markdown, HTML, site model, render, and outputs. The five hooks sit at
four points:

| Hook | Stage | Runs | Input | Output |
| --- | --- | --- | --- | --- |
| `markdown` | Markdown | Once per page, after includes and before parsing. | `MarkdownSource` | `string` |
| `content` | Model assembly | Once per page, after the page's front matter, Markdown, HTML, title, URL, language, and headings are final, and before navigation is assembled. | `Page` | `Page` |
| `validate` | Model assembly | Once per final page, after the `content` hook. | `Page` | `readonly Diagnostic[]` |
| `model` | Site model | Once, after the model is assembled, before anything is rendered. | `Site` | `Site` |
| `outputs` | Outputs | Once, with the files every enabled output produced, before any file is written. | `readonly OutputFile[]`, `Site` | `readonly OutputFile[]` |

Plugins run in the order the code file lists them. Each hook receives the value the hook before it returned, and a
plugin that does not implement the hook is skipped. A hook may be synchronous or return a promise; it is awaited
before the next plugin runs.

`markdown` sees every page's body after includes and before parsing, as `{ path, markdown }`. The string a hook returns
is parsed instead, and the next `markdown` hook sees it. The returned text must have the same number of lines as the
body it replaces, so heading and diagnostic positions stay those of the source; a different line count is a
`plugin.hook-failed` at the page source and the text before that hook is parsed. Rendered HTML, headings, and the
Markdown twin all come from the transformed body, so they agree.

`content` sees every page, including app pages, record pages, and generated list pages. Pages are hooked one at a
time: a source page before the record and list pages built from it. The page order is deterministic for fixed input,
but a plugin should not depend on it. The page's `html` and `markdown` are already final here, so changing `markdown`
alone leaves the rendered page and its Markdown twin disagreeing; use `markdown` for a transformation of Markdown
itself.

`validate` reads each final page once, after every `content` hook, and returns the findings it made. Each hook reads a
copy of the page, so a mutation cannot reach the model. The findings are added to the build's diagnostics as returned,
with their own `pos`; a thrown or rejected hook, a missed deadline, or a return that is not a list of diagnostics is a
`plugin.hook-failed` at the page source, and the plugins after it still run.

`model` receives the assembled site: pages sorted by URL, the navigation tree, `_data`, and collections. The site it
returns is the one the theme and every output read, so a page it changes is rendered changed.

`outputs` receives every file of every enabled output, in output file-name order, together with the site they came
from. Returning an extra file adds a custom output; removing one drops it. The engine then checks each file: a path
relative to the output folder with `/` separators and no `..`, a path written by only one file, and contents that are
text or bytes. A path outside the output folder or a duplicate path is an `output.bad-path` or `output.duplicate-path`
error, and that file is dropped while the rest are written. A file the site itself owns wins over an output file at
the same path, with no diagnostic.

## Order, isolation, and failure

- The order of plugins is their order in `plugins`. The engine never sorts them.
- Each hook call gets a copy of the stage's value, so a mutation cannot reach the model or the next plugin. The value
  a hook returns is used as it is.
- A value that cannot be copied (site data holding a function, say) is passed by reference. Mutating such a value is
  outside the contract.
- A hook that throws, rejects, misses its deadline, or returns an unusable value is an error that names the plugin and
  the stage. The value the stage carried before that plugin is kept, and the plugins after it still run. One bad
  plugin costs its own work and nothing more.
- The engine checks what a hook returns before the next plugin sees it. A page must have a URL starting with `/`, a
  source position, a front matter object, a title, a language, a text direction, HTML and Markdown strings, a kind,
  and headings with a depth of 1 to 6, an id, text, and a position. A site must have a config object, a page list, a
  navigation tree, and a data object. A `markdown` hook must return a string whose line count is the body's, and a
  `validate` hook a list of diagnostics with an `id`, a `severity`, and a `message`. The check covers shape, not
  cross-page rules such as two pages sharing a URL.

| Diagnostic id | Cause |
| --- | --- |
| `plugin.load-failed` | Node cannot import the code file. |
| `plugin.invalid-code-config` | The default export is not `{ plugins: [...] }`. |
| `plugin.invalid-plugin` | One entry is not a plugin; that entry is dropped. |
| `plugin.duplicate-name` | A later plugin repeats an earlier name; that entry is dropped. |
| `plugin.hook-failed` | A hook threw, rejected, or returned an unusable value, including a Markdown body with a different line count; the value before it is kept. |
| `plugin.hook-timeout` | A hook missed the deadline; the value before it is kept. |

Every diagnostic in this table is an error. A `markdown`, `content`, or `validate` hook's diagnostic is positioned at
the page's source, and a model or outputs hook's at the first line of `mizzen.config.ts`; every message names the plugin
and stage in prose. Findings a `validate` hook returns keep their own severity and position. Duplicate names are
refused at load: the first plugin keeps the name and a later one is dropped with `plugin.duplicate-name`. The deadline
is 10 seconds per hook call, measured by the runner and not configurable from `mizzen.yml`. It stops the runner waiting,
not the hook: a synchronous hook cannot be preempted, and a timed-out asynchronous hook keeps running in the process
until it settles.

## Trusted-code policy

`mizzen.config.ts` is the site's own build code and is trusted exactly like its `package.json` scripts. The engine
imports and runs it in the build process with the CLI's permissions: the filesystem, the network, the environment, the
clock, and the process itself. There is no sandbox, worker or VM boundary, permission list, signature, or review step,
and none is planned. Running an untrusted plugin is arbitrary code execution with the user's permissions.

The bounds above are about predictability, not security. The deadline limits how long the engine waits; the copy
limits mutation; the return checks catch a malformed value. None of them stops a plugin from reading or writing any
file or opening a socket, and the engine cannot see what a plugin read. That is why a site with a code file builds
cold until declared inputs exist (#604).

## Determinism boundary

The engine guarantees that fixed input and a deterministic plugin give byte-identical output in the same order. A
plugin keeps its side of that promise by:

- deriving its result from the values it is handed, never from the clock, randomness, the environment, the network, a
  git history, or an absolute path;
- ordering every list it returns, and never relying on object iteration for output order;
- returning new values instead of mutating its input, and not keeping state between hook calls;
- using only site-relative paths in anything it reports or writes.

A plugin that cannot meet these rules makes the build non-deterministic, and the engine has no way to detect it. The
cache rules for declared plugin inputs follow in #604.

## Audit: gaps this epic closes

| Gap today | Issue |
| --- | --- |
| Two plugins may share a name; diagnostics then cannot say which one. | #601 |
| A hook failure points at the code file, not at the page that caused it. | #601 |
| A content hook had no finding channel and Markdown had no stage before parsing; `validate` returns diagnostics and `markdown` transforms the body with its positions kept. | #602 |
| A custom output is a file appended to the `outputs` list; it cannot be declared and its owner is not tracked. | #603 |
| A site with a code file always builds cold. | #604 |
| The executable examples live only in the README snippet. | #605 |

## The fixture

`fixtures/plugin-api/` is a small site with four plugins in its code file, one for each contract point:

| Plugin | Hook | What it shows |
| --- | --- | --- |
| `require-description` | `content` | A validation rule on every page. A missing description fails the hook. |
| `reading-time` | `content` | A page transformation. It sees the resolved Markdown and runs after the validator. |
| `inventory` | `model` | One pass over the assembled site. It fixes the list the custom output writes. |
| `write-inventory` | `outputs` | A custom file added to the build as `plugin-api/inventory.json`. |

The fixture's pages all pass the validator, so a build is clean. The inventory lists pages in the model's URL order
with a fixed key order and one final line feed, so two builds give the same bytes.
