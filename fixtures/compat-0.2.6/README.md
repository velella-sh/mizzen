# 0.2.6 compatibility baseline

`baseline.json` records the output of the published `@velella/mizzen@0.2.6` for the compatibility site in
`../compat-0.2.4/site`, built with the fixed test theme in `../compat-0.2/theme`. It records every public file's
SHA-256, each HTML page's canonical link, the `_redirects` file, and the sitemap URLs.

The baseline was captured with:

```sh
node scripts/release-compat.ts --baseline @velella/mizzen@0.2.6 \
  --write-baseline fixtures/compat-0.2.6/baseline.json
```

`test/compat-0.2.6.test.ts` builds the same site from this checkout and requires every byte to match. The release
workflow installs the published `0.2.6` package beside the candidate tarball and compares them live, with the
published `@velella/lateen@0.2.3` theme.

The only normalizations are the engine version stamp in `agent.json` and the two `pagefind/wasm.*.pagefind` binaries,
which Pagefind builds per platform and are compared by presence only.

Do not regenerate the baseline to make it pass. A reviewed difference gets a reason here first.

## Intended difference: page head tags

The published `0.2.6` package predates the build wiring for the page head. The `0.2.7` candidate prints the head that
`headMeta` computes: Open Graph and Twitter tags, a canonical link, JSON-LD, and `og:image` for a page whose social
image is written. The compatibility comparison removes exactly those tags from the *candidate* (and the derived
`trust.json` `build.id`) and requires everything else to match, including the single canonical link and the `hreflang`
set:

- every `<meta property="og:…">` and `<meta name="twitter:…">` tag;
- every `<script type="application/ld+json">` block;
- the `<link rel="canonical">` on a page whose baseline had none (the baseline's own canonicals are kept and compared);
- the `<meta name="description">` of `index.html`, which now falls back to the site description;
- `trust.json`'s `build.id`, a hash of the rendered HTML, which is replaced by the baseline's id.

The same pages, bodies, tag order, hreflang links, redirects, and sitemap still match byte for byte. A candidate page
with two canonical links throws.

## What the check reports

`scripts/release-compat.ts` builds the site with both packages and writes one report with five review sections:

| Section | What it compares |
| --- | --- |
| `differences` | Public output: every file's SHA-256, canonical links, `_redirects`, and sitemap URLs. |
| `review.urls` | Published pages, sitemap URLs, canonicals, redirect rules, and `urls.json` record URLs. |
| `review.configuration` | The effective `config` object in `.mizzen/build-report.json`, by path. |
| `review.cli` | The `--help` command and option inventory, plus `agent capabilities`, `check`, `doctor`, and `urls check`. |
| `review.contracts` | The package export map, shipped `schema/*.json` hashes, and exported contract type names. |

An added command, option, type, or schema is reported only. A removed command, option, contract type, or schema fails
the run, as does any public-output difference. Configuration and probe-output changes are reported for review because
they can be intended.

## Preliminary review for #1425

`preliminary-review.json` is the check run with the published `0.2.6` package as the baseline and a tarball built from
`origin/main` (`5ce8417`) as the candidate. It is an initial review, not the release gate: the final run must use the
exact `0.2.7` candidate tarball, and a person must review every reported difference before #1425 is closed.

Run it again with any candidate tarball:

```sh
npm pack --pack-destination /tmp/mizzen
node scripts/release-compat.ts \
  --baseline @velella/mizzen@0.2.6 \
  --candidate /tmp/mizzen/velella-mizzen-<version>.tgz \
  --theme @velella/lateen@0.2.3 \
  --report /tmp/mizzen/compat-report.json
```

Without registry access, `test/compat-0.2.6.test.ts` compares the checkout with the committed baseline instead and
must say that the baseline was not re-fetched.
