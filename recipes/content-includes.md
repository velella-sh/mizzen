# Share one fragment between two pages

The case: two documentation pages explain the same install step with different products. Keep the sentences in one
Markdown file, pass a value per page, and let the build keep the fragment's file and line as the origin of its text.
The contract is in [`docs/content-includes.md`](../docs/content-includes.md); `fixtures/content-includes/` is a
working example of the two pages below.

## 1. Write the fragment

`_snippets/install.md` declares its parameters in front matter and uses them in the body. A parameter with no
default is required:

```md
---
params:
  product: Beacon
  package: "@acme/beacon"
  support:
---
## Install {{product}}

Run `npm install {{package}}`.

Questions go to {{support}}.
```

## 2. Call it with a value on each page

`::include` is a whole line. A key other than `path` and `lines` is a parameter value:

```md
::include[_snippets/install.md]{support="the Beacon team"}
```

```md
::include[_snippets/install.md]{product="Orbit" package="@acme/orbit" support="the Orbit team"}
```

The first page takes `product` and `package` from the defaults; the second overrides every value. Build the site as
usual with `mizzen build`; `mizzen check` reports the findings without writing output.

## What the build keeps

- The rendered paragraphs and code come from `_snippets/install.md`, at the line after its front matter, and their
  `data-src` names that file and line on both pages. A nested include keeps its own file, never the fragment that
  called it.
- A substituted value is part of the fragment's line for `data-src`; its exact placeholder span is kept for
  diagnostics and cache keys.
- A parameter error points at the call site: the whole directive line in the file that holds it.
- Editing the fragment re-renders both pages and nothing else. Editing one call site re-renders only that page.

A missing required value fails the build with `include.param-missing` at the directive line and leaves `{{support}}`
visible. A misspelled value is `include.param-unknown`; a bad declaration is `include.param-reserved` or
`include.param-invalid` in the fragment's front matter.
