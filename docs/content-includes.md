# Shared content: parameters and source positions

Epic: content-includes (#606). Status: accepted for 0.2.3. Plain `::include`, `lines`, nesting, and the source-folder
boundary already ship; this note fixes what parameters mean and where shared text and parameter errors point. #608 to
#611 implement it.

Two pages should be able to consume one fragment with two sets of values, while the engine still knows which file and
line each piece of the result came from.

## At the call site

```md
::include[_snippets/install.md]{product="Orbit" package="@acme/orbit"}
```

The existing forms keep working:

```md
::include[_snippets/install.md]
::include[_snippets/install.md]{lines=2-10}
::include{path="_snippets/install.md" lines="2-10"}
```

A key in the braces other than `path` and `lines` is a parameter value. The value uses the directive's existing
attribute grammar: `key=value`, `key="value"`, or `key='value'`. A value is one line, it needs quotes when it contains
a space, and it cannot contain the quote that delimits it or a `}`. A repeated key uses its last value, as the
directive grammar already does. Values are text: they are never resolved as paths, URLs, or directives.

A fragment that declares no `params` (see below) ignores extra attributes exactly as today, so an existing include
with an unused attribute keeps building. A fragment that declares parameters is strict: every attribute other than
`path` and `lines` must name one of them.

## In the fragment

A fragment declares its parameters in front matter:

```md
---
params:
  product: Beacon
  package: "@acme/beacon"
  edition: Standard
  support:
---
## Install {{product}}

The {{edition}} edition installs with `npm install {{package}}`.

Questions go to {{support}}.
```

- `params` maps a parameter name to its default value. `support:` with no value is a required parameter: the call
  site must supply it.
- A name matches `[A-Za-z][A-Za-z0-9_.-]*`, the same grammar as a code placeholder. `path` and `lines` are reserved.
- A default is a string. Quote a value that YAML would read as another scalar, such as `version: "2"`; a number,
  boolean, list, or mapping default is an error.
- `params` absent, `null`, or `{}` means the fragment takes no parameters. This is what keeps every existing include
  working.
- The declaration comes from the whole front matter. `lines` slices only the body, after the front matter and before
  substitution, and a placeholder on the first line of a slice still points at its real line in the file.

## Placeholders and escaping

Write `{{name}}`, with optional spaces inside the braces, where the value goes. Only a name the fragment declares is
replaced. A declared name is replaced inside code too, so a command can use a parameter. An undeclared `{{...}}` is
left exactly as written, so a fragment that shows code placeholders keeps working.

Substitution is one pass from left to right and the result is never scanned again: a value that itself contains
`{{name}}` stays literal.

A backslash escapes the braces: `\{{product}}` stays literal. An odd run of backslashes escapes; an even run leaves
one backslash and substitutes. That is the rule the code-placeholder plugin already uses, and the backslash itself is
removed by Markdown outside code or by that plugin inside code.

A value is Markdown source. It may add emphasis, code, or a link to the fragment, but it cannot add a line, and it
never becomes a directive: directive lines are found before values are inserted. Escape Markdown punctuation with a
backslash when a value must show it literally outside code; inside code, punctuation is already literal. A value
that begins a line can begin a block, like any Markdown source at the start of a line.

## Order

1. Read the fragment, strip its front matter, and apply `lines` to the body.
2. Find the fragment's own directive lines and expand the nested includes they name. A nested include passes its own
   values and never inherits the outer ones.
3. Replace this fragment's placeholders in its remaining lines. Text that came from a nested fragment is not visited
   again.
4. Send the assembled page body to Markdown.

## Source positions

Every character of the assembled body has one origin.

| Text | Origin |
| --- | --- |
| The page's own text | The page file and line, as today. |
| A fragment's literal text | That fragment's file, at the original line after its front matter and `lines`. |
| Text from a nested fragment | The nested fragment's file, never the fragment that included it. |
| A substituted value | The placeholder's span in the fragment, from its first `{` to its last `}`. |

The value's span at the call site is kept on the include record for diagnostics and cache keys, but it is not the
origin of the rendered text: the text lives in the fragment, and a reader who wants to change the sentence around a
value edits the fragment. A block's `data-src` follows the same rule and names the file that holds the block's first
character.

Parameter errors point at the call site, as the epic requires. The position is the whole directive line in the file
that holds it: the page for a top-level include, the including fragment for a nested one, column 1 to the line's last
character, exactly like today's include diagnostics. A finding about a declaration names the line that declares it,
or the `params:` line when the block itself is wrong.

| Code | Severity | Position | Meaning |
| --- | --- | --- | --- |
| `include.param-missing` | error | call site | A declared parameter has no value and no default. Its placeholder stays as written, so the gap is visible. |
| `include.param-unknown` | error | call site | An attribute names no parameter of a fragment that declares parameters. The value is ignored. |
| `include.param-reserved` | error | fragment front matter | A declared name is `path` or `lines`. |
| `include.param-invalid` | error | fragment front matter | `params` is not a mapping, a name is invalid, or a default is not a string or null. |

## What does not change

- A fragment without `params` behaves exactly as today: front matter stripped, text spliced, extra attributes
  ignored.
- `lines`, nesting, cycle detection, the source-folder boundary, fences, and the include dependency records keep
  their current meanings.
- No config key, file extension, or new source file type: a fragment is an ordinary Markdown file.

## Limits

- No expressions, conditionals, loops, or defaults that read another parameter.
- No multi-line values, no pass-through to a nested include, and no parameter in a directive's path or attributes.
- A placeholder in front matter or in a directive's own `path` or `lines` is not substituted.
- A declared parameter that the body never uses is not an error.

## Where it is implemented

| Task | Piece |
| --- | --- |
| #608 | `src/content/include-params.ts`, wired from `src/content/includes.ts` |
| #609 | `src/content/include-spans.ts`, wired into the source map and `data-src` |
| #610 | Include dependencies and the page cache |
| #611 | Acceptance test and recipe |

The input for those tests is `fixtures/content-includes/`; its README gives the two pages and the expected expansion.
