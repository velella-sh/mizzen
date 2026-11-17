# Math in Markdown

Epic: #587. Syntax contract for #588, before parsing in #589 and styling in #590.

Math is part of a page's text, so it goes through the same source positions, diagnostics, Markdown twin, and
deterministic build as everything else. It is rendered to MathML by the engine; no runtime, stylesheet, or font is
downloaded.

## Syntax

| Form | Source |
| --- | --- |
| inline | `The area is $a^2$.` |
| block | a `$$` line, the body, and a closing `$$` line |

```markdown
$$
\frac{a}{b} = c
$$
```

- Inline math opens with `$` and closes with the next unescaped `$` on the same line. There is no space directly after
  the opening `$` or before the closing `$`.
- A block opens with a line that holds only `$$`, ends at the next line that holds only `$$`, and may contain blank
  lines. Its body is the TeX source, trimmed of the surrounding newlines only.
- `\$` is a literal dollar. `\\` is a literal backslash. A `$` inside a code span, a fenced code block, raw HTML, or
  front matter is text, never math.
- Math is not parsed for Markdown: `*` and `_` inside `$…$` are TeX, not emphasis.
- Labels, references, and numbering are not part of this contract.

## Output

- Inline math is a `<math display="inline">`; block math is a `<math display="block">` inside the page flow, not a
  script or an image.
- Every `<math>` carries `dir="ltr"`, even on a right-to-left page, and an `alttext` attribute with the TeX source for
  a reader that cannot use the MathML tree.
- The TeX source is also kept in `<annotation encoding="application/x-tex">` inside `<semantics>`, so the twin and a
  later tool can recover it exactly.
- The serialization is engine-owned and fixed: the same TeX writes the same bytes on every machine. No generated ids,
  no timestamps, no external CSS or font.
- The Markdown twin keeps the original `$…$` or `$$` block unchanged.
- Block math is reachable and readable in order: the equation, then its annotation, then the surrounding text.

## Diagnostics

| Code | Severity | Position | When |
| --- | --- | --- | --- |
| `math.unclosed-block` | error | the opening `$$` line | a block with no closing `$$` |
| `math.empty` | warning | the `$$` line or the empty pair | no TeX between the delimiters |
| `math.syntax` | warning | the math's source span | a TeX command outside the supported subset or an unbalanced brace |
| `math.unsupported` | info | the math's source span | a construct kept as literal text on purpose |

A `math.syntax` or `math.unsupported` warning keeps the page readable: the raw TeX is written in a `<code>` element at
the same position, and the page still builds. An unclosed block is an error because everything after it would be
misread.

## Supported subset

Numbers, identifiers, `+ - = / < >`, `\frac`, `\sqrt`, `^`, `_`, `\sum`, `\int`, `\left`/`\right`, and common Greek
letters. Anything else is reported as `math.unsupported` and kept literal until #589 says it is supported.

## Fixture

[`fixtures/math/`](../fixtures/math/) has a healthy page (inline, block, escaped dollar, code span, RTL page) and a
broken page (unclosed block, empty pair, unsupported command). It is an input, not a snapshot.

## Limits

- No equation numbering, cross-references, or per-page lists of equations.
- No user CSS or macros; a macro would have to be defined in the site config and is out of scope here.
- The exact MathML tree for a construct is implementation-defined until #589; the accessibility attributes above are
  fixed.
