# Docusaurus import fixture

One Docusaurus docs page as a real site hands it to the importer: the `.mdx` source, its theme imports, and its
site import. It is an input, not a Mizzen site, so it has no `mizzen.yml` and nothing builds it.

`docs/configure-a-token.mdx` covers the patterns in epic #573:

- `Tabs` and `TabItem`, with labels, `value`, `default`, and Markdown panels;
- a `:::note` admonition and a titled `:::tip`;
- a custom `<Card>` with Markdown children and an attribute.

The imports are never resolved or executed by the importer, so no `Card` source or Docusaurus theme is here.

Read-only, like every fixture. A later task that needs another pattern adds a page here and says why in its pull
request. What each pattern should become is in [`docs/import-docusaurus-components.md`](../../docs/import-docusaurus-components.md).
