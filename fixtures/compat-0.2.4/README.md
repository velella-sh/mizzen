# 0.2.4 compatibility baseline

`baseline.json` records the output of the published `@velella/mizzen@0.2.4` for the site in
`site/`, built with the fixed test theme in `../compat-0.2/theme`. It records every public file's
SHA-256, each HTML page's canonical link, the `_redirects` file, and the sitemap URLs.

The site is the 0.2.2 compatibility site, unchanged: two collections, record and list pages, a
feed, search filters, Markdown twins, page JSON, a base path, a canonical URL override, config
redirects, and a Mermaid block. The 0.2.4 release built it without changing a public byte.

The baseline was captured with:

```sh
node scripts/release-compat.ts --write-baseline fixtures/compat-0.2.4/baseline.json
```

The release workflow runs `scripts/release-compat.ts --candidate <tarball>` with no `--baseline`,
so it compares the published 0.2.4 package with the 0.2.5 tarball by default. The only
normalizations are the engine version stamp in `agent.json` and the two
`pagefind/wasm.*.pagefind` binaries, which Pagefind builds per platform and are compared by
presence only. Every other documented public output is compared byte for byte.

Do not regenerate the baseline to make it pass. A reviewed difference gets a reason here and in the
upgrade guide first.
