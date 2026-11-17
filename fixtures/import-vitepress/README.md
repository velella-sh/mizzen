# VitePress import fixture

A hand-written VitePress page with one example of each pattern the import must tell apart, and the page
it should become. The syntax is the one on VitePress's Markdown Extensions page; it is not copied from
a real site.

## Assumed mapping

The fixture declares one explicit component mapping:

| VitePress component | Mizzen directive |
| --- | --- |
| `Badge` | `badge` |

Attributes are copied by name, so `text="Beta"` becomes `text="Beta"`. The fixture has no other import
configuration. Where a real site writes this mapping is task #584's decision.

## Expected result

| Source | Expected output | Report |
| --- | --- | --- |
| `source/deploy.md:5-7` — tip with a title | `expected/deploy.md:5-7` — `:::tip[Run the doctor first]` | none |
| `source/deploy.md:9-11` — warning without a title | `expected/deploy.md:9-11` — `:::warning` | none |
| `source/deploy.md:15` — mapped `Badge` | `expected/deploy.md:15` — `::badge{text="Beta"}` | none |
| `source/deploy.md:19-21` — dynamic `ReleaseNotes` with `:version` | `expected/deploy.md:19` — its link and text, no component | one entry at `source/deploy.md:19` naming `ReleaseNotes` |

The report's severity, id, message text, and end position belong to task #585. This fixture fixes only
that one entry exists and starts at line 19.

## Files

- `source/deploy.md` — the VitePress page. Read-only like every fixture.
- `expected/deploy.md` — the page a correct import produces. It is a recorded answer, not generated;
  change it in the same review as the source.

Nothing reads this fixture yet. #584 adds the conversion and its test, #585 the report, and #586 the
build comparison.
