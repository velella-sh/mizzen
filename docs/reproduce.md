# Diagnose and reproduce builds

A build is reproducible when the same inputs, config, tool versions, and environment give the same publishable
bytes. `mizzen build --diagnose` records what a build actually used, `mizzen compare` attributes a difference to a
category, and `mizzen reproduce` checks a recorded build before rebuilding it.

## The report

```bash
mizzen build . --diagnose
```

writes `.mizzen/build-report.json` beside the site. It is not a publishable file and is left out of the build hash;
do not copy it, or anything else under `.mizzen/`, into `dist/` or a site's source folder.

The report has one format version (`1`) and five comparable categories:

| Category | What it records |
| --- | --- |
| `inputs` | SHA-256 of `mizzen.lock.json`, `urls.lock.json`, and `blocks.lock.json`; every local collection source; every discovered page, asset, data file, and template. Paths are relative. |
| `config` | One hash of the resolved config, the effective reference date (`asOf`), and the rule-bearing config: defaults, redirects, output switches, collection transforms and derived rules, quality rules, feeds, and calendars. Config values and secrets are never written. |
| `tools` | The actual Mizzen version, Node.js version, and theme package name and version. |
| `environment` | The resolved time zone and locale, plus `LANG` and `SOURCE_DATE_EPOCH` when set. |
| `outputs` | The build hash and every publishable file with its relative path and SHA-256, by the same rule `mizzen verify` uses. |

Moving the checkout alone changes no value: every path is relative and the theme is named by its package metadata,
not its folder.

## Compare a laptop build with CI

The usual difference is intentional: a laptop in one time zone and a CI runner in UTC can format an environment-
sensitive value differently. Prove it, then remove it.

```bash
# Laptop: record the build it actually made.
mizzen build . --out dist --diagnose
cp .mizzen/build-report.json laptop.json

# CI: the same commit, with the runner's environment.
TZ=UTC LC_ALL=C.UTF-8 mizzen build . --out dist --diagnose
cp .mizzen/build-report.json ci.json

mizzen compare laptop.json ci.json
```

The report names the difference instead of leaving a diff of HTML:

```text
environment: 1 difference
  timezone: Asia/Tehran -> UTC
outputs: 2 differences
  hash: 4c1e… -> 9a02…
  index.html: 71bd… -> e3f0…
```

Here the environment difference explains the output, so `unexplained` is absent. To make the builds agree, run both
with the same output-affecting environment:

```bash
TZ=UTC LC_ALL=C.UTF-8 mizzen build . --out dist --diagnose
mizzen compare laptop.json .mizzen/build-report.json
```

```text
identical: every category matches.
```

## Preflight and reproduce

A report from another machine can be checked before anything is built:

```bash
mizzen reproduce laptop.json . --check
```

It names a missing lock or data file, a changed input hash, a different effective config, or an incompatible Mizzen,
Node major, or theme version. A fatal problem stops before the build. To rebuild and compare:

```bash
mizzen reproduce laptop.json . --out dist
```

The command disables the build cache, writes a fresh `.mizzen/build-report.json`, and exits `1` when the output hash
differs. It exits `0` when the publishable files are identical.

## A clean checkout, offline

Transfer the data inputs as one private package and install the same tool version:

```bash
# On the machine that has the data:
mizzen inputs export . --out site-inputs.mizzenpack
mizzen build . --diagnose
cp .mizzen/build-report.json site-report.json

# In an empty checkout with the same pages, config, and theme:
mizzen inputs verify site-inputs.mizzenpack
mizzen inputs import site-inputs.mizzenpack .
mizzen reproduce site-report.json . --out dist
```

The build reads the imported files and the content-addressed store, opens no network connection, and writes the same
output hashes as the recorded build when the tool versions and environment match. The input package holds raw source
bytes; keep it private. See [input packs](input-pack.md) for what a package carries and its limits.

## When output differs and nothing explains it

If `mizzen compare` finds an output difference while inputs, config, tools, and environment all match, it prints:

```text
unexplained: the outputs differ while every input, config, tool, and environment value matches; investigate the build.
```

That is not a category to ignore: a plugin, a clock, randomness, a network read, or a file outside the report's input
list is reaching the output. The report cannot see what a plugin read unless the plugin declares it, so start with
`mizzen.config.ts` and the plugin's `inputs` list.
