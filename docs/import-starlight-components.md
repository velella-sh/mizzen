# Importing Starlight components

The import turns Starlight pages written in MDX (`.mdx`) and Markdoc (`.mdoc`) into readable document
content: steps stay an ordered list, a file tree becomes a text block, a link card becomes a link, and
an unknown component is reported and unwrapped. This note fixes the two source samples, in
`fixtures/import-starlight/`, and the content each supported component must become. The converter and
its acceptance build come next.

Both samples carry the same page text, so their converted bodies can be compared. They are source
fixtures only: the current engine does not discover or build them.

## Supported equivalents

### Steps

MDX wraps an ordered list in `<Steps>`; Markdoc wraps the same list in `{% steps %}`. Both convert to
that list, unchanged: same items, same order, and nested content such as a code block or a link stays
inside its item. The wrapper, the Markdoc tags, and the MDX import are dropped.

### FileTree

MDX wraps an unordered list in `<FileTree>`; Markdoc wraps it in `{% filetree %}`. Both convert to one
fenced code block tagged `text`: one entry per line, two spaces of indentation per nesting level, and
list markers removed. Names and a trailing `/` are kept, and children stay under their directory in
source order.

### LinkCard

MDX writes `<LinkCard title href description />`; Markdoc writes the same attributes in
`{% linkcard ... /%}`. Both convert to one paragraph, `[title](href)`, followed by an em dash and the
description when one is set:

```markdown
[Deployment guide](/guides/deploy/) — Configure a host, a domain, and caching.
```

Other attributes are dropped. `href` is kept verbatim; a `.md` target goes through the same link
rewrite as any other Markdown link.

### Custom components

Every other component is a warning at the file and line of its opening tag, and its children become
ordinary Markdown so no text is lost. Attributes and the component itself are dropped. An MDX import
of the custom component is dropped with the other imports.

## Manual cases

| Case | Expected |
| --- | --- |
| Both samples | The converted bodies are identical; the front matter title matches. |
| Steps | Three items in source order, and the `sh` fence stays inside item 1. |
| FileTree | One `text` block with the same entries and nesting; `site/`, `guides/`, and `install/` keep the trailing `/`. |
| LinkCard | The paragraph above, with the description after the em dash. |
| Custom component | One warning per page naming the file and the opening tag's line; the sentence remains a paragraph and the build still succeeds. |
| Links | The inline deployment link and the card destination both point at `/guides/deploy/`. |
