# Audit: code snippets against the include directive

Epic: #562. Baseline task: #563. The measurements below are pinned by `test/code-snippets.test.ts` on
`fixtures/code-snippets/site`, using `src/content/includes.ts` as it stands.

## Fixture

| File | What it measures |
| --- | --- |
| `example.ts` | A small TypeScript source with six lines, included by range and not by copy. |
| `guide.md` | `::include[example.ts]{lines=2-4}` in prose: path, range, rendering, and source positions. |
| `fenced.md` | The same directive inside a `ts` fence: whether a fence can set the language of an include. |

## What `::include` already covers

| Requirement | Behaviour today | Reuse |
| --- | --- | --- |
| Path | Relative to the file that holds the directive; nested includes relative to the included file. Absolute and `..` spellings that leave the source folder are refused. | yes |
| Allowed-file boundary | Checked twice: the lexical path and the real path after resolving symbolic links, both against the real source folder. The read uses the real path. | yes |
| Line range | `lines=Start-End` or `lines=N`, 1-based and inclusive, so `lines=2-4` gives the function body in `example.ts`. A range past the end is an error. | yes, with the caveat below |
| Dependency tracking | The expander reports `{ from, path, pos, missing }` per directive, and `buildDependencyGraph` already turns `guide.md → example.ts` into an edge, so an edit to the source rebuilds the page. | yes |
| Failure reporting | Missing file, unreadable file, invalid range, out-of-range, outside the source folder, cycle, and too-deep nesting each produce an error at the directive's file and line. | yes |

The line-range caveat: `lines` counts the file **after front matter is stripped**. A Markdown snippet is fine, but a
source file that begins with `---` would lose those lines and shift every range by the stripped count.

## What needs a new reader

- **A language at the insertion point.** An include has no language attribute, and a fence cannot supply one: a
  directive inside a fence is an example, not an include. Wrapping `::include` in ` ```ts ` leaves the directive as
  literal code (`fenced.md`). A snippet needs its own language, from the source extension or an attribute.
- **Raw source, not Markdown.** Today the included text is parsed as page Markdown. `example.ts` becomes an HTML
  paragraph rather than a `<pre><code>` block, and its indentation is lost. A directive line inside the source would
  also expand, and a leading `---` would be read as front matter. A snippet reader must splice the text without
  Markdown parsing, front-matter stripping, or nested include expansion.
- **A source position distinct from the insertion point.** Every block's `data-src` names the page's line
  (`guide.md:7`), because the expander splices before the Markdown stage and the page keeps its own line count. A
  snippet needs the real `example.ts:<line>` for each rendered line, so a reader can go from the docs to the source.
- **Range semantics for source files.** Ranges must count the file as it is on disk, with no front-matter strip, and
  a change to the source must stay a dependency of the page even when the changed line is outside the range.

## What the next tasks must decide

The directive shape and its attributes, how language is chosen, whether ranges may be named or widened, and how the
source-position mapping is carried through the render host. This note does not change any of them: no engine code
changed for #563.
