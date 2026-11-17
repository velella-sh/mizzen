# Recipe: code blocks from a source file

A code block can be built from a real file and line range instead of copied into the page. The reader and renderer
live in `src/content/code-snippets/read.ts` and `src/markdown/plugins/code-snippets.ts`; a caller with the site root
uses both, because the Markdown stage does not know the source folder.

```ts
import { readSourceRange } from "../src/content/code-snippets/read.ts";
import { renderSnippet } from "../src/markdown/plugins/code-snippets.ts";

const result = await readSourceRange({
  sourceDir,
  path: "src/example.ts",
  lines: "2-4", // `2-4` or `4`; omit for the whole file
  pos, // the directive's span, so a diagnostic points at the page
});
if (result.snippet !== undefined) {
  const { node, sourceMap } = renderSnippet({ snippet: result.snippet, pos });
  // node.value is the three lines, node.lang is "ts" from the extension.
  // sourceMap = { file: "example.ts", start: 2, end: 4, lines: [2, 3, 4], insertion: pos }
}
```

## Source folder boundary

`path` is relative to `sourceDir` and `/`-separated. It is refused when it leaves the folder lexically or through a
symbolic link, before anything is read, and the read itself uses the real path. A snippet may therefore read a file
that discovery skips, such as one in an `_` folder, but never one outside the site.

## Line ranges

`lines` is 1-based and inclusive and counts the file on disk, so a leading `---` is a line rather than front matter
(unlike `::include`). `lines=4` is one line; omitting it reads the whole file. A missing file, an unreadable file, an
invalid range, and a range past the end each return one `snippet.*` error diagnostic and no snippet, so the build
reports the page line instead of throwing.

## Source map

`data-src` on the rendered `<pre>` names the real file and the block's last character (`example.ts:2:1-4:1`), while
`node.data.snippet` carries `file`, `start`, `end`, and the 1-based source line of each rendered line. The insertion
point stays apart from the code's own source, so the block points at the file, not at the page.

## Change invalidation

`snippetSources` lists every file under the source folder that discovery did not, and the whole-build cache key hashes
their bytes. Editing, moving, or deleting a source file therefore misses the cache, and the previous output folder is
not restored. The whole file is an input, not only the rendered range.

`test/code-snippets/acceptance.test.ts` edits one line and checks both outputs and the preserved source range.
