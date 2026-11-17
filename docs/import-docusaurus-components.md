# Docusaurus components: input inventory and expected conversion

Epic: #573. Inventory for #574, before the converter in #575 and its report in #576.

The fixture is one real Docusaurus docs page, [`fixtures/import-docusaurus/docs/configure-a-token.mdx`](../fixtures/import-docusaurus/docs/configure-a-token.mdx).
It covers the four patterns the epic names: `Tabs` and `TabItem`, a `:::note` admonition, a titled `:::tip`, and a
custom `<Card>` with Markdown children. The imports are input shape, not a dependency: the importer never resolves or
executes them.

## What the engine does today

| Input | Today |
| --- | --- |
| `import … from '@theme/Tabs';` | Three plain paragraphs, one per line. |
| `<Tabs groupId="shell">` | Past through as raw HTML; the `groupId` attribute is kept. |
| `<TabItem value="bash" label="Bash" default>` | Raw HTML; its indented Markdown becomes a code block, and nested lists become literal text inside it. |
| `:::note` | Converted to the existing callout, unchanged. |
| `:::tip[Write it once]` | Converted to a callout; the title is kept as a paragraph. |
| `:::info` / `:::caution` | Written as `<sl-component name="info|caution">`; the title stays a paragraph. |
| `<Card title="Rotate a token">` | Raw HTML, passed through with no diagnostic. |

A `.mdx` file is treated as an asset, not a page, so nothing in the fixture builds as a site page today.

## Expected Markdown

- **Imports** are removed, not rendered. The file keeps no trace of `@theme/` or `@site/` sources.
- **`Tabs`/`TabItem`** become the existing tab containers: a `:::::tabs` group whose label comes from `label`, and one
  `:::tab` per `TabItem`. The `default` item comes first. Markdown inside a panel is parsed as Markdown, not as code:
  lists stay lists, fenced code keeps its language. `groupId` has no Markdown equivalent and is dropped.
- **Admonitions** keep the existing callout mapping. `:::note` is already correct; `:::info` maps to `note` and
  `:::caution` to `warning`, with the title kept as the callout title instead of a separate paragraph.
- **A custom component** keeps its children as Markdown when they are Markdown, and its opening tag and attributes
  become a visible report entry rather than silent raw HTML. The page stays readable; the component itself is not
  emulated.

## Diagnostics

| Code | Severity | Position | When |
| --- | --- | --- | --- |
| `import.component` | warning | the opening tag's line and column | a custom element that is not a known Markdown container |
| `import.mdx-unsupported` | warning | the JSX expression's position | a `{…}` expression, a `.map`, or a prop computed at runtime |
| `import.asset` | info | the `.mdx` file | the input stays an asset until #577 builds converted pages |

The report names every custom component once per page, keeps the source position stable across builds, and lists it
even when the page otherwise converts cleanly. A warning never fails the build; the epic's verification step makes the
custom case visible in the report without turning a readable page into an error.

## Limits

- No Vue, Svelte, or MDX runtime is executed; only the syntax the fixture shows is mapped.
- Unknown attributes are dropped, not guessed at. A prop that affects layout stays in the report.
- Nested custom components are reported once each, in document order.
