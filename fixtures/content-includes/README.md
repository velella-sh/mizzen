# Content includes fixture

Input for the content-includes epic (#606) and issue #607. The contract is in
[`docs/content-includes.md`](../../docs/content-includes.md); this folder is the two-page case the later tasks build
against.

| Path | What it is |
| --- | --- |
| `_snippets/install.md` | The shared fragment: three defaults and one required parameter, plus a nested include. |
| `_snippets/upgrade.md` | The nested fragment, so the result has two fragment origins. |
| `guide/beacon.md` | Takes the defaults and passes the required `support` value, which contains Markdown emphasis. |
| `guide/orbit.md` | Overrides every value. |

## Calls

`guide/beacon.md`:

```md
::include[../_snippets/install.md]{support="the *Beacon* team"}
```

`guide/orbit.md`:

```md
::include[../_snippets/install.md]{product="Orbit" package="@acme/orbit" edition="Team" support="the Orbit team"}
```

## Expected expansion

The Markdown body of `guide/beacon.md` after the include:

~~~md
Beacon runs on Node 24.

## Install Beacon

The Standard edition installs with:

```sh
npm install @acme/beacon
```

> Upgrades keep the same package name for every edition.

Questions go to the *Beacon* team. Write `\{{product}}` to show the literal placeholder.
~~~

The Markdown body of `guide/orbit.md` after the include:

~~~md
Orbit runs on Node 24.

## Install Orbit

The Team edition installs with:

```sh
npm install @acme/orbit
```

> Upgrades keep the same package name for every edition.

Questions go to the Orbit team. Write `\{{product}}` to show the literal placeholder.
~~~

## Origins

| Text | Final origin |
| --- | --- |
| `Beacon runs on Node 24.` | `guide/beacon.md:4` |
| `## Install Beacon` or `## Install Orbit` | `_snippets/install.md:8` |
| `The Standard edition...` or `The Team edition...` | `_snippets/install.md:10` |
| The `npm install` code block | `_snippets/install.md:12` |
| The blockquote | `_snippets/upgrade.md:1` |
| `Questions go to ...` | `_snippets/install.md:18` |
| A parameter error | The call-site directive line, `guide/beacon.md:6` or `guide/orbit.md:6`, column 1 |

The `*Beacon*` in Beacon's `support` value is Markdown emphasis, not escaped: a value is Markdown source. The
backslash in `\{{product}}` is the escape that keeps a declared placeholder literal.

Until #608 and #609, the build ignores `params` and leaves `{{...}}` in place, and a heading from a fragment still
gets the page's line in `data-src`. This fixture fixes the input and the expected result for those tasks.
