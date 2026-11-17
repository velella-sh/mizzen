---
title: Dated data
description: The as-of date and its precedence, date fields, the Gregorian and Jalali calendars, derived countdowns and states, and how a template writes a date.
---

# Dated data

A record's date can drive more than a line of text: how many days are left, whether something is still supported, and
which records a list shows. Mizzen reads every date against one day, the **as-of date**, and never reads a clock during
a build. The same data files with the same as-of date produce the same bytes on any machine, on any day.

## The as-of date

Set the day the build pretends it is in `mizzen.yml`, or pass it to the command:

```yaml
# mizzen.yml
asOf: 2026-07-01
```

```sh
mizzen build . --as-of 2026-07-01
mizzen check . --as-of today
mizzen watch . --as-of today
```

`--as-of` is on `build`, `check`, and `watch`, and wins over `asOf`. `--as-of today` is the one place Mizzen reads the
system clock: once, at the command line, which prints the date it used and passes a plain `YYYY-MM-DD` on. Nothing
below the command line reads a clock, which is why a past build stays reproducible.

A collection's `referenceDate` is the date its lists compare `before` and `after` against, so it wins over both for
those lists. See [Lists](/data/lists/).

## Choosing a calendar

Dates are written in the Gregorian calendar unless the site says otherwise:

```yaml
# mizzen.yml
dates:
  calendar: jalali
```

The calendar changes how a date is written, not what it means: `2026-03-21` is one day either way. A month or a year
cannot be written in the Jalali calendar, because a Gregorian month does not match a Jalali one; use a whole day.

## Date fields

List the fields that hold a date under the collection's `dates`:

```yaml
collections:
  releases:
    source: _data/releases.yml
    dates: [released, endDate]
```

A value is a calendar date written `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`. A full ISO 8601 instant, such as
`2026-03-15T09:00:00+03:30`, is read as its UTC day. A value that is not a date is `data.date-invalid` at the field, and
a record without a value is not a finding: it simply has no derived value.

```yaml
# _data/releases.yml
- id: 2.4
  released: 2026-03-15
```

## Derived values

A collection computes values from one of its date fields with `derived`. A rule either counts whole days or picks a
value from bands of that count:

```yaml
collections:
  releases:
    source: _data/releases.yml
    dates: [released]
    derived:
      daysLeft: { field: released, kind: days-left }
      daysSince: { field: released, kind: days-since }
      state:
        field: released
        bands:
          - { below: 0, value: expired }
          - { below: 90, value: soon }
          - { value: later }
```

| Rule | Counts |
| --- | --- |
| `kind: days-left` | Whole days from the as-of day to the latest day the value can mean. A month counts to its last day. |
| `kind: days-since` | Whole days from the earliest day the value can mean to the as-of day. |
| `bands` | Always days-left. The first band whose exclusive `below` the count is under gives the value; the last band leaves `below` out. |

A value is read beside the record's fields, and a real field with the same name wins. Nothing is written back to the
data file. A rule with no as-of date reports `dates.no-as-of` and derives nothing. A rule that reads a field not listed
under the collection's `dates` is `config.derived-date-field`; bands out of order, a middle band without `below`, or a
last band with one is `config.derived-bands`.

A template reads a derived value like any other field:

```md
Released :field[released]{format=long}
:field[daysLeft] days left · :field[state]
```

## Where a derived value is read

Lists, `where`, `sort`, `group`, the `:records` directive, feeds, and the search index all read derived values like
fields:

```yaml
---
title: Coming soon
list:
  collection: releases
  where: { state: soon }
  sort: [daysLeft]
---
```

## Formatting a date

`:field[released]` prints the value as the data file wrote it. Add `{format=…}` to write it as a date:

```md
Released :field[released]{format=short}
Released :field[released]{format=long}
Released :field[released]{format=full}
```

A format uses the page's `lang`, otherwise the site's, and `dates.calendar`. The tables are built in, so the text does
not change with the Node or ICU version. These are the exact forms for 15 March 2026 and 21 March 2026:

| Language | Calendar | `format` | Date | Prints |
| --- | --- | --- | --- | --- |
| `en` | `gregorian` | `short` | 2026-03-15 | `2026-03-15` |
| `en` | `gregorian` | `long` | 2026-03-15 | `15 March 2026` |
| `en` | `gregorian` | `full` | 2026-03-15 | `Sunday, 15 March 2026` |
| `fa` | `gregorian` | `long` | 2026-03-15 | `۱۵ مارس ۲۰۲۶` |
| `en` | `jalali` | `long` | 2026-03-21 | `1 Farvardin 1405` |
| `fa` | `jalali` | `long` | 2026-03-21 | `۱ فروردین ۱۴۰۵` |
| `fa` | `jalali` | `full` | 2026-03-21 | `شنبه، ۱ فروردین ۱۴۰۵` |

A region suffix such as `fa-IR` uses `fa`, and any other language is written as `en`. A `{format=…}` on a field that is
not a date reports `data.field-not-date`; a name that is not `short`, `long`, or `full` reports `data.field-format`.

## Rebuilding every day

A site that publishes a countdown or a "soon" state must be built again as the day moves. The
[rebuild-daily recipe](https://github.com/velella-sh/mizzen/blob/main/docs/recipes/rebuild-daily.yml) runs
`mizzen build --as-of today` on a schedule and publishes only when the build hash changed. A manual build with a fixed
date stays valid, so you can still reproduce a past site byte for byte.
