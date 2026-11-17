# Dated data

This note fixes how dates in data drive what a page says (days left, a status, a countdown) without
the build ever reading the clock. The same data and the same as-of date always give the same bytes.

## Date kinds

A date in data is a calendar date with a precision. Three forms are read:

- **Day**: `YYYY-MM-DD`, one day.
- **Month**: `YYYY-MM`, every day of that month.
- **Year**: `YYYY`, every day of that year.

A date has no time and no zone. A date and time with a zone, such as `2026-03-01T10:00:00+01:00`, is
not a date here and is reported; the engine handles calendar dates only.

A month or a year means a range of days: its **earliest** day is the first of the period and its
**latest** day is the last (`2026-02` runs from `2026-02-01` to `2026-02-28`, or the 29th in a leap
year). Comparing with a day follows the range:

- A partial date is **before** a day when its latest day is before that day.
- It is **after** a day when its earliest day is after that day.
- Otherwise it **contains** the day, and a comparison that needs one answer treats it as neither
  before nor after.
- A number such as days left counts from the as-of date to the **latest** day for a deadline and
  from the **earliest** day for a start; a rule says which.

Impossible dates such as `2026-02-30` are rejected with the position of the value. Parsing never uses
`new Date(string)` and never a local time zone: a day is a year, a month, and a day number, and day
counts come from a fixed civil-day algorithm.

## The as-of date

The **as-of date** is the day the build pretends it is. It is always an input and is never read inside
the build. It is resolved in this order, the first that is set winning:

1. the `--as-of YYYY-MM-DD` flag of `build`, `check`, and `watch`;
2. the site config's `asOf` key;
3. for a list or feed over one collection, that collection's `collections.<name>.referenceDate`.

`referenceDate` stays the narrowest setting: it applies to one collection's date filters and keeps
working as it does today. The flag and the key are site-wide. When a collection sets `referenceDate`,
that collection uses it; every other feature uses the site-wide date.

`--as-of today` is the one place the clock is read: the CLI reads the system date once at its edge,
prints it, and passes the plain date on. Nothing below the CLI reads a clock.

## No as-of date

A feature that needs the as-of date (days left, a derived status, a date filter with an offset) and
finds none reports a diagnostic at the place that needs it, naming the three ways to set it. It never
falls back to the system date. A site that uses no date feature needs no as-of date and is not
affected by one: its output hash does not change when the date moves.

## Determinism

The resolved as-of date joins the cache key of the pages that use it and, when any page uses it, the
manifest and the build hash. A site that never sets one keeps its hash.
