# Code line annotations

Epic: #557. Syntax contract for #558, before rendering in #559 and the accessible theme in #560.

An annotation is a note attached to one line of a fenced code block. It lives in the fence's meta, so it travels with
the block through the Markdown twin without a second syntax.

## Syntax

```ts annotations={2: reads the token | 4-5: retries once}
const token = read();
const client = connect(token);
// ...
const result = await client.scan();
log(result);
```

- `annotations={…}` is a fence meta key, beside the existing `title` and `test`.
- Entries are separated by ` | `. An entry is `<line>: <text>` or `<start>-<end>: <text>`.
- Line numbers are 1-based over the fence body, counting blank lines and comment lines. The closing fence is not a
  line. A range includes both ends.
- One entry per line; ranges may not overlap. Entries may appear in any order and are rendered in line order.
- `\|` is a literal pipe and `\\` a literal backslash. A `}` inside the text is invalid; write it in the note after the
  block if needed. `|` and `\` are the only escapes.
- The text is inline Markdown: emphasis, code spans, and links, but no block markup.

## Rendering

- Each annotated line gets an anchor (`#L2`) and a visible line number. The note is a list item after the block,
  linked to the line, not absolute-positioned over the code.
- The block stays readable with JavaScript off: the note is normal text, and the link is ordinary HTML.
- The line number and the note are separate from the `<code>` element, so a screen reader reads the code without the
  note interrupting it. The note is reachable by keyboard and names its line in text.
- The Markdown twin keeps the fence meta byte for byte, including `annotations={…}`; no HTML is added there.
- Highlighting, line numbers, and copy keep working; an annotation never changes the code bytes.

## Diagnostics

| Code | Severity | Position | When |
| --- | --- | --- | --- |
| `code.annotation-syntax` | warning | the fence meta | a missing colon, an empty note, or a `}` in the text |
| `code.annotation-range` | warning | the fence meta | a number below 1 or above the body's line count |
| `code.annotation-overlap` | warning | the fence meta | two entries cover the same line |

A warning keeps the block and drops only the bad entry, so one typo never hides the code. The diagnostic is emitted
once per fence with the first offending entry named, and the same input gives the same diagnostic in the same order.

## Fixture

[`fixtures/code-annotations/`](../fixtures/code-annotations/) has a valid page (single line, range, inline Markdown,
escaped pipe) and an invalid page (zero, out of range, overlap, malformed entry). It is an input, not a snapshot.

## Limits

- No annotations on inline code, headings, or prose. The feature is scoped to fenced code blocks.
- No markdown blocks inside a note; a long explanation belongs after the block.
- The exact HTML around a note is implementation-defined until #559; the anchor and the reading order above are fixed.
