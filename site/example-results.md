---
title: Pinned example results
description: Record example runs for themes to use offline while rendering.
---

Enable pinned results in `mizzen.yml`:

```yaml
examples:
  pinned: true
  failOnFailure: true
```

`failOnFailure` is optional. It makes a currently matching, recorded failure a build error. Pinned builds read
`.mizzen-examples.json` from the site root. They never execute fences or contact the network to obtain their results.
Without pinned mode, the existing example runner and totals-only report continue to work as before.

## Record results in CI

Run the recorder in a trusted checkout on macOS with `sandbox-exec` or Linux with working `bwrap`. Use the UTC
run date and the commit whose code is being tested. Review and check in the resulting file. Build and deploy from
that checked-in input.

```sh
mizzen examples record site --date "$(date -u +%F)" --commit "$(git rev-parse HEAD)"
git diff -- site/.mizzen-examples.json
mizzen check site
mizzen build site
```

The recorder replaces the file atomically and exits 1 if a fence failed or the required OS sandbox was unavailable.
Unsupported languages are recorded as skipped. In a workflow that stops on command failure, upload the file from
an always-run step to inspect failed runs. Run the recorder again when the tested code or expected output changes.

## Theme contract

Layouts and components receive `page.examples` when the page has matching recorded entries. Look up the
`data-example-id` from a rendered code element in that map. IDs are local to the page, in test-fence order
(`example-1`, `example-2`, and so on). Adding prose or an ordinary fence leaves those IDs intact. Adding or
reordering test fences can change their ordinals.

A result has `status`, `file`, `line`, `language`, `date`, `commit`, and `sha256`. A changed fence has
`status: "stale"` and its prior result in `recordedStatus`, with the original provenance. Treat stale entries
and absent entries as unverified. An edit to prose or to fence presentation leaves the hash intact. Changing the
language, code, or adjacent expected output changes it.

## File format

Version 1 of `.mizzen-examples.json` has a top-level `version: 1` and an `examples` object. Within
`examples`, keys are page routes without the deployment base. Each route maps fence IDs to records:

```text
{
  "version": 1,
  "examples": {
    "/guide/": {
      "example-1": {
        "status": "passed",
        "file": "guide.md",
        "line": 12,
        "language": "js",
        "date": "2026-11-23",
        "commit": "<full lowercase Git commit ID>",
        "sha256": "<lowercase SHA-256 hex digest>"
      }
    }
  }
}
```

`status` is `passed`, `failed`, `skipped` for an unsupported language, or `sandbox-unavailable` for a
supported language skipped because there was no OS sandbox. The hash is over the UTF-8 bytes of the JSON array
`[language, code, expectedOutput]`, with `null` for absent expected output. File and 1-based line describe the
fence at the recorded run. A missing file gives no evidence, and a malformed file is a build error.

The public `examples.json` keeps the existing `pages` totals and key order. In pinned mode it also includes
`version: 1` and an `examples` object keyed by the published page URL, including `base`. It publishes recorded
entries whose hashes still match. Stale and unrecorded fences count toward `skipped`.
