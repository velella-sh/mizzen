# 0.2.2 compatibility baseline

`baseline.json` records the output of the published `@velella/mizzen@0.2.2` for the site in
`site/`, built with the fixed test theme in `../compat-0.2/theme`. It records every public file's
SHA-256, each HTML page's canonical link, the `_redirects` file, and the sitemap URLs.

The site started as `examples/data-site` at `v0.2.2`: two collections, record and list pages, a
feed, search filters, Markdown twins, page JSON, a base path, and a canonical URL override. The
fixture adds config redirects and a Mermaid block so the theme check can follow both.

The baseline was captured with:

```sh
node scripts/release-compat.ts --write-baseline fixtures/compat-0.2.2/baseline.json
```

`test/compat-0.2.2.test.ts` builds the same site with the current source and compares it with the
baseline. The only normalizations are the engine version stamp in `agent.json` and the two
`pagefind/wasm.*.pagefind` binaries, which Pagefind builds per platform and are compared by
presence only. Every other documented public output is compared byte for byte. A page that is
added, removed, or changed fails the test.
Do not regenerate the baseline to make it pass. A reviewed difference gets a reason in this file
and in the 0.2.3 upgrade guide first.

`scripts/release-compat.ts --candidate <tarball>` reproduces the comparison for a release tarball:
it installs the baseline from npm and the candidate tarball in separate empty projects, builds both,
and then builds the same site with the published theme package to check the base path, its assets,
the canonical links, redirects, and a rendered Mermaid diagram.

## Intended difference: page head tags (0.2.6)

The page head now comes from one function that also writes Open Graph, Twitter, canonical, and JSON-LD tags. The
comparison removes exactly these from the *candidate* before hashing, and nothing else, so any other head or body
change still fails:

- every `<meta property="og:…">` and `<meta name="twitter:…">` tag;
- every `<script type="application/ld+json">` block;
- the `<link rel="canonical">` on a page whose baseline had none (the baseline's own canonicals are kept and compared);
- the `<meta name="description">` of `index.html`, which now falls back to the site description;
- `trust.json`'s `build.id`, a hash of the rendered HTML, which is replaced by the baseline's id.

The same pages, bodies, tag order, hreflang links, redirects, and sitemap still match byte for byte. A candidate page
with two canonical links throws.
