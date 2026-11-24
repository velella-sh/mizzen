# 0.2.5 compatibility baseline

`baseline.json` records the output of the published `@velella/mizzen@0.2.5` for the compatibility site in
`../compat-0.2.4/site`, built with the fixed test theme in `../compat-0.2/theme`. It records every public file's
SHA-256, each HTML page's canonical link, the `_redirects` file, and the sitemap URLs.

The baseline was captured with:

```sh
node scripts/release-compat.ts --baseline @velella/mizzen@0.2.5 \
  --write-baseline fixtures/compat-0.2.5/baseline.json
```

`test/compat-0.2.5.test.ts` builds the same site from this checkout and requires every byte to match. The 0.2.6 release
workflow also installed the published `0.2.5` package beside the candidate tarball and compared them live, with the
published `@velella/lateen@0.2.3` theme. From 0.2.7 the workflow's default baseline is `0.2.6`; the
`0.2.6` baseline and its preliminary review live in `../compat-0.2.6`.

The only normalizations are the engine version stamp in `agent.json` and the two `pagefind/wasm.*.pagefind` binaries,
which Pagefind builds per platform and are compared by presence only.

Do not regenerate the baseline to make it pass. A reviewed difference gets a reason here and in
`docs/upgrade-0.2.6.md` first.

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
