# 0.2.0 compatibility baseline

`pages.json` records the SHA-256 of all 594 HTML files built from `fixtures/docs-site`
by Mizzen `v0.2.0` (`248c58277a9466f8741cba1f4bee9fff8b3dab61`), including the
404 page and the unchanged dashboard app. The docs fixture is byte-identical to
that tag; reuse it rather than copying its hundreds of source files.

The fixed test-only theme exercises page bodies, component props, titles, head
metadata, breadcrumbs, and previous/next links. It deliberately has no dependency
on the sibling Lateen checkout. This checks engine compatibility, not Lateen's
appearance, CSS, or client scripts.

The baseline was captured on Node 24 with the workspace dependencies, using the
old engine's `src/pipeline/build.ts` and these options:

```ts
await build({
  root: "<v0.2.0 checkout>/fixtures/docs-site",
  out: "<temporary folder>/site",
  themeRoot: "<current checkout>/fixtures/compat-0.2/theme",
  defaultLayout: "doc",
});
```

For each sorted `result.files` entry ending in `.html`, hash the file's raw bytes
with `createHash("sha256")`. The JSON records the engine version, source commit,
and the resulting path-to-hash map. No HTML is normalized before hashing.

Run the comparison with:

```sh
node --test test/compat-0.2.test.ts
```

There is currently **one intended difference**, for every page: the 0.2.6 head tags. The test removes the Open Graph
and Twitter meta tags, the JSON-LD scripts, and the canonical link (the 0.2.0 head had none) from the built HTML before
hashing; the page list and every other byte still match. Do not regenerate the baseline
to make this test pass. A reviewed change must instead add the affected path, its
new hash, and a reason to `intendedDifferences` in the test. A removed or moved
page always fails the page-list comparison.
