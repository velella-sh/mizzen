# 0.2.5 compatibility baseline

`baseline.json` records the output of the published `@velella/mizzen@0.2.5` for the compatibility site in
`../compat-0.2.4/site`, built with the fixed test theme in `../compat-0.2/theme`. It records every public file's
SHA-256, each HTML page's canonical link, the `_redirects` file, and the sitemap URLs.

The baseline was captured with:

```sh
node scripts/release-compat.ts --baseline @velella/mizzen@0.2.5 \
  --write-baseline fixtures/compat-0.2.5/baseline.json
```

`test/compat-0.2.5.test.ts` builds the same site from this checkout and requires every byte to match. The release
workflow also installs the published `0.2.5` package beside the candidate tarball and compares them live, with the
published `@velella/lateen@0.2.4` theme.

The only normalizations are the engine version stamp in `agent.json` and the two `pagefind/wasm.*.pagefind` binaries,
which Pagefind builds per platform and are compared by presence only.

Do not regenerate the baseline to make it pass. A reviewed difference gets a reason here and in
`docs/upgrade-0.2.6.md` first.
