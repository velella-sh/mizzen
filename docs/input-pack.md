# Transferable input packages

A site built from data reads files and pinned remote sources. A package carries those inputs as one file, so a build
in another checkout, a CI runner, or an air-gapped machine reads exactly the bytes the exporting machine read. A normal
build never fetches: it reads the local sources and the content-addressed store, and a package writes into both.

The commands are:

```bash
mizzen inputs export [dir] [--collections <a,b>] [--out <file>]
mizzen inputs inspect <file> [--json]
mizzen inputs verify <file>
mizzen inputs import <file> [dir] [--accept <ids|all>]
```

`export` and `inspect`/`verify` change nothing except the package file `export` is asked to write. `import` writes
only the package's declared inputs and the lock entries they need.

## What a package contains

A package holds only the collection sources the site declares:

- a file source, such as `_data/products.yml`, with the same bytes and the same path;
- an `https:` source, read from `.mizzen/data/<sha256>` and carried with its `mizzen.lock.json` entry, so the
  destination build reads the same pinned bytes;
- every collection named by a selected collection's `references` field, followed transitively. A record page that is
  built needs the records its links point at, so those collections come along.

Nothing else enters. Environment files (`.env`, `.env.*`), `.mizzen` cache and store entries that are not a declared
input, `.git`, `node_modules`, `mizzen.yml`, lock files, and any file outside the site root are never packaged. A
collection that declares one of those as its source is refused with a diagnostic, not silently skipped.

`npm:` sources are not packaged: their bytes live in an installed package tree, and a fresh checkout cannot build them
without `npm install`. Export names the collection and asks you to install the package in the destination. A package
also does not carry `data snapshot` entries in `mizzen.lock.json`; those describe history, not the bytes a build reads.

### Raw and non-public data

**A package contains the raw source bytes of every selected input, exactly as the build reads them.** It is not
redacted, sampled, or field-filtered. If a data file holds names, prices, internal identifiers, or anything else that
must not leave the organization, the package holds them too. Treat a package as the data it carries:

- keep it in a private artifact store or a private repository, never on a public CI artifact;
- do not commit it to a public repository;
- give it the same retention and access rules as the source files, and delete it when those files' retention ends;
- a package of local files alone needs no lock entry, but it still carries every byte of those files.

`inspect` prints the source list, sizes, and hashes before you distribute a package, so a reviewer can see exactly
which files it names.

## The container

A package is one file, not a ZIP or a tar, so it can be moved as a single artifact:

```text
mizzen-input-pack/1\n
{"blobs":[…],"format":1,"inputs":[…],"lock":{…}}\n
<content of the first blob><content of the second blob>…
```

The first line names the format. The second is the manifest as canonical JSON: keys sorted at every level, no
whitespace, no timestamp. The rest is the unique content blobs, in manifest order, with no separators. The manifest
gives every blob's byte length and SHA-256, so the reader knows where each one ends.

ZIP and tar record modification times, ownership, and permissions; two exports of the same input would then differ,
and a package could not be compared by hash. The fixed header has no such fields: the same inputs and the same Mizzen
version produce the same bytes and the same package SHA-256. `inspect` and `verify` print that hash; the package does
not store it, because a file cannot contain its own hash.

A manifest looks like this:

```json
{
  "format": 1,
  "inputs": [
    { "id": "products", "source": "_data/products.yml", "bytes": 90, "sha256": "c347…" },
    { "id": "products-copy", "source": "_data/products-copy.yml", "bytes": 90, "sha256": "c347…" }
  ],
  "blobs": [{ "sha256": "c347…", "bytes": 90 }],
  "lock": { "version": 1, "sources": {} }
}
```

Two inputs with equal content share one blob while both references survive. The manifest is validated as a whole: the
format, every input's id, path, size, and hash, the unique blobs, and that the lock holds exactly the entries the
locked inputs need. A package whose first line names an unknown format is refused before the manifest is read, with the
version that reads the supported format (`Mizzen 0.2.5` reads format 1).

## Inspect and verify without installing

```bash
mizzen inputs inspect site.mizzenpack
mizzen inputs inspect site.mizzenpack --json
mizzen inputs verify site.mizzenpack
```

`inspect` reads the package and prints the format, package hash, and each input's id, source, size, and SHA-256. It
changes nothing in the site. `verify` additionally checks every content hash and that the file ends exactly after the
last declared content; an appended byte, a truncated file, or a changed byte is an error and an install never starts.
Both exit `1` on a bad package and `2` on a usage error.

## Import and conflicts

```bash
mizzen inputs import site.mizzenpack
mizzen inputs import site.mizzenpack ../fresh-checkout
```

Import validates the whole package, then every destination path and lock entry, before activation:

- a path must stay inside the destination, with no `..`, absolute path, backslash, drive letter, `.env`, `.mizzen`,
  `.git`, or `node_modules` segment;
- an existing symbolic link on the way to a destination, or at the destination itself, is refused;
- the package is bounded at 64 MiB and one input at 16 MiB before it is read;
- an existing file with different bytes, or a destination lock that pins a different hash or version for the same
  address, is a **conflict**.

A conflict changes nothing and names the input. Re-run after reviewing the difference with that input named, or with
`all`:

```bash
mizzen inputs import site.mizzenpack --accept products
mizzen inputs import site.mizzenpack --accept all
```

An accepted conflict replaces the file or lock entry; all other inputs are still checked. Importing the same package
again finds every hash equal and reports `already installed`; it rewrites neither an input nor the lock. The lock is
written last, through a rename, and only when it gains or changes a locked entry. If activation fails partway, the
files already replaced are restored and the lock is untouched, so the previous inputs stay active. Nothing is left
staged.

A file-only package needs no `mizzen.lock.json` unless it replaces a SQLite or NDJSON source that has a locked
extraction. Import removes that extraction, including when the lock spells its path with `./`, so the next build asks
for `mizzen data extract` instead of publishing stale records; unrelated extraction entries stay in place. A package
with `https:` inputs writes their bytes under `.mizzen/data/` and merges only those entries, keeping every other source
and snapshot in the destination lock.

## Transfer examples

### Local: export on one machine, build in another checkout

```bash
# On the machine that has the data and the lock:
mizzen inputs export . --out catalog-inputs.mizzenpack
mizzen inputs inspect catalog-inputs.mizzenpack

# Copy catalog-inputs.mizzenpack to the fresh checkout, then:
mizzen inputs verify catalog-inputs.mizzenpack
mizzen inputs import catalog-inputs.mizzenpack .
mizzen build . --out dist
```

The fresh checkout needs the site's pages, config, and theme, but not `_data/`, `.mizzen/data/`, or network access.
The build runs offline: it reads the imported files and the store, and nothing fetches.

A subset transfer names only the collections needed. Their `references` targets are added, and everything else stays
behind:

```bash
mizzen inputs export . --collections products --out products.mizzenpack
```

### CI: build from an artifact

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          name: catalog-inputs
          path: .mizzen-artifacts
      - run: node node_modules/@velella/mizzen/bin/mizzen.ts inputs verify .mizzen-artifacts/catalog-inputs.mizzenpack
      - run: node node_modules/@velella/mizzen/bin/mizzen.ts inputs import .mizzen-artifacts/catalog-inputs.mizzenpack .
      - run: node node_modules/@velella/mizzen/bin/mizzen.ts build . --out dist
```

A job that exports the artifact runs `mizzen inputs export . --out catalog-inputs.mizzenpack`, then uploads it with
`actions/upload-artifact`. Keep the artifact private: it holds raw input. A job that does not run `mizzen data fetch`
never needs a network connection at build time.

## Limits and known limits

- A package is read whole and bounded at 64 MiB; one input is bounded at 16 MiB. A larger source must be split or
  imported with a trusted programmatic limit.
- The selected set follows `collections.<name>.references`; a template's `:::records{from=…}` is not a declared
  dependency of the config and is not added automatically. Select that collection explicitly if its pages are needed.
- `npm:` sources and `data snapshot` history are not carried. Install the package or keep the snapshot in the
  destination checkout.
- The build still validates the site: a package transfers inputs, not a guarantee that the destination's config,
  templates, or theme match.
