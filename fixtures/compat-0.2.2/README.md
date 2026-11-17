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
baseline. The only normalization is the engine version stamp in `agent.json`; every documented
public output is compared byte for byte. A page that is added, removed, or changed fails the test.
Do not regenerate the baseline to make it pass. A reviewed difference gets a reason in this file
and in the 0.2.3 upgrade guide first.

`scripts/release-compat.ts --candidate <tarball>` reproduces the comparison for a release tarball:
it installs the baseline from npm and the candidate tarball in separate empty projects, builds both,
and then builds the same site with the published theme package to check the base path, its assets,
the canonical links, redirects, and a rendered Mermaid diagram.
