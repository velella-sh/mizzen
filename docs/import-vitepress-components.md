# Import: VitePress containers and Vue components

Epic: [import-vitepress](#582). Task: #583. Status: accepted for 0.2.3.

A VitePress page is Markdown with Vue in it: built-in containers, theme components, components a page
imports for itself, and expressions inside any of them. The import reads the page as text. It never runs
Vue, loads a component, or evaluates an expression: it converts what has an exact Mizzen equivalent and
reports the rest.

## The three categories

| Category | VitePress input | Expected output | Reported |
| --- | --- | --- | --- |
| Container | `::: tip Title` | the matching built-in directive, `:::tip[Title]` | no |
| Explicitly mapped component | `<Badge text="Beta" />` | the mapped directive, `::badge{text="Beta"}` | no |
| Dynamic part | `<ReleaseNotes :version="version">…</ReleaseNotes>` | its Markdown children | yes, with file and line |

`fixtures/import-vitepress/` has one example of each and records the exact expected page.

## Containers

A container is VitePress's own Markdown syntax, not Vue: `:::` fences with one of five built-in names, an
optional title after the name, and Markdown children.

| VitePress | Mizzen | Title |
| --- | --- | --- |
| `::: tip` | `:::tip` | `:::tip[Title]` |
| `::: info` | `:::note` | `:::note[Title]` |
| `::: warning` | `:::warning` | `:::warning[Title]` |
| `::: danger` | `:::danger` | `:::danger[Title]` |
| `::: details` | `:::details{title="Title"}` | the `title` attribute |

`info` becomes `note` because Mizzen's callout has no `info` type and `note` has the same role. `details`
has no built-in callout; it becomes a plain directive, which renders only when the theme has a `details`
component.

The body is copied unchanged, so links, code fences, and nested Markdown survive. VitePress attributes
other than the title (`{open}`, `{no-title}`) are not converted. Custom container names registered in
`markdown.container.customContainers` are not guessed; they convert only through a mapping like a
component. Neither is in the fixture.

## Explicitly mapped components

A component is converted only when the import configuration names it and its target. The import does not
guess from the component's name, its props, or the theme, and it does not read `config.ts` or a theme's
`components/` folder. A component without a mapping is a dynamic part.

A mapping copies attributes by their written name: `text="Beta"` stays `text="Beta"`. A self-closing
component becomes a leaf directive (`::badge{…}`); a component with children becomes a container
directive whose body is its children converted as Markdown, so titles and nested content stay in order.
The mapping names the target directive; it does not translate VitePress props into a theme's vocabulary.
The fixture's only mapping is `Badge` → `badge`; the file format a real site writes it in is #584's.

## Dynamic parts

Anything that needs Vue to produce its final text is dynamic:

- a `{{ … }}` interpolation;
- a binding such as `:version="version"`, an event (`@click`), or a directive (`v-if`, `v-for`, `v-html`);
- a `<script>` or `<script setup>` block, an `import`, or a component with no mapping.

The import never evaluates any of them. It keeps the static text, headings, links, images, and code in
source order, including the Markdown children of a dynamic component, because those transfer by hand. It
drops the expression or the element that produced dynamic output and reports that place with the file and
line. The report, its id, and its message belong to #585; this note fixes only that the case is reported
and the remaining text is kept.

A bare expression in prose leaves a gap in the sentence. That is deliberate: filling it from front matter
or `site.data` would be an evaluation, and a guessed value is worse than a visible report.

## Fixture

`fixtures/import-vitepress/` holds:

| File | What it is |
| --- | --- |
| `source/deploy.md` | a VitePress page with a titled tip, an untitled warning, the mapped `Badge`, and a dynamic `ReleaseNotes` |
| `expected/deploy.md` | the page the import should produce |
| `README.md` | provenance, the assumed mapping, and the expected diagnostic position |

`expected/deploy.md` is a recorded answer, not generated output: do not regenerate it to make a
comparison pass. A real change edits the source and the expected page together, in one review. The same
source always gives the same page and the same report order.

## Limits

- **No Vue runtime.** Script blocks and imports are never read, so a page whose text lives entirely in
  Vue keeps only its Markdown shell and a report.
- **Built-in containers only.** A custom container name is data, not a known type; it converts only
  through a mapping.
- **No prop vocabulary.** VitePress-only attributes are dropped, not renamed, and a dynamic attribute
  value is reported like any other expression.
- **Not covered here:** front matter keys, `[[toc]]`, code groups, and snippet includes are other tasks.
  The fixture stays on the three categories above.
