---
title: Calendar feeds
description: Publish .ics calendars from a collection's dates, with stable event ids, reminders, add-to-calendar files, and a feed of what ends soon.
---

# Calendar feeds

A collection with dates can publish calendar files that people subscribe to. The dates stay in the data, the ids and
stamps come from the data, and a build with the same data writes the same bytes, so a calendar app sees a change only
when something really changed. This page covers the `calendars` config, the events and reminders it builds, the ids the
files carry, and the `feeds` window that lists what ends soon.

## Declare a calendar

```yaml
collections:
  runtimes:
    source: _data/runtimes.yml
    template: _templates/runtime.md
    permalink: /runtimes/{id}/
    dates: [eol, supportEnd]
    referenceDate: 2026-07-01

calendars:
  eol:
    collection: runtimes
    events:
      - name: eol
        field: eol
        title: "{title} reaches end of life"
    reminders: [30d, 7d]
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `collection` | string | required | Collection whose records the calendar lists. |
| `where` | object | every record | Which records it lists, written like a list page's `where`. |
| `events` | list | required | Events built from each record. At least one. |
| `reminders` | list | `[]` | Reminders before each event as whole days, such as `30d`. |
| `groupBy` | string | | Record field whose values each get a calendar of their own under `calendars/<name>/`. |
| `limit` | integer | no limit | Largest number of events in one file. |

The `calendars` output writes `calendars/<name>.ics` for each calendar. With `groupBy`, it also writes
`calendars/<name>/<group>.ics` for every value, such as one file per vendor. A calendar with no events writes no file and
is reported, and a site with calendars but no `url` writes none and reports `calendars.no-url`.

### Events

One event is built from each record for every entry under `events`.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `name` | string | required | Event name, kept in the event id, such as `eol`. Unique per calendar. |
| `field` | string | required | Record field that holds the event's first day; it must be one of the collection's `dates`. |
| `end` | string | | Record field that holds the last day of a multi-day event; it must be one of the collection's `dates`. |
| `title` | string | `{title}` | Title template; `{field}` names a record field. |

A record whose field is empty or is not a date gets no event for it, and the build reports how many it skipped. An
`end` that is not after `field` is ignored, so a single-day event stays a single day.

## Reminders

`reminders` lists whole days before each event, such as `30d` and `7d`. Each one becomes a `VALARM` on every event, with
the event's title and the lead time as its text. A value that is not a whole number of days is a config error.

## Event ids and stamps

An event's `UID` is built from the collection, the record id, the event name, and the site's host:

```text
runtimes/node-20/eol@example.com
```

It never contains the record's page URL, so renaming a record keeps its events. The `DTSTAMP` comes from the record's
own `updated` field, then the collection's snapshot date, then the collection's `referenceDate`; a record with no such
date is reported and left out rather than stamped with the build clock.

The `record-calendar` output writes one `calendar.ics` beside each record page, holding that record's events across the
site's calendars. A record with no events gets no file. The file's address is handed to the theme as `record.calendar`,
and `record.calendars` lists the site calendars the record belongs to as `https` and `webcal` addresses.

## Subscribe from a calendar app

A calendar file is a normal `.ics` file at a permanent address, so a reader subscribes to it with `https` or `webcal`:

```text
https://example.com/calendars/eol.ics
webcal://example.com/calendars/eol.ics
```

The theme receives each address in `record.calendars`, and a record page that belongs to a calendar writes
`<link rel="alternate" type="text/calendar">` in its head. `llms.txt` lists every written calendar, so an agent can find
the same files. Calendar apps need absolute links, so a site without `url` writes no calendar.

The per-record file is the one to offer as "add to calendar": it holds only that record's events and never asks the
reader to subscribe to the whole collection.

## A feed of what ends soon

A collection feed can add a window. It keeps only entries whose `date` falls from the as-of date to the as-of date plus
`days`, both included, and writes them through the same Atom, RSS, and JSON Feed writers as any other feed:

```yaml
feeds:
  ending-soon:
    collection: runtimes
    date: eol
    formats: [atom, json]
    window:
      days: 90
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `days` | integer | required | Last day of the window, counted from the as-of date; both ends are included, so `0` is the as-of date alone. |

The window starts at the resolved as-of date, never the system clock: the `--as-of` flag wins, then `asOf` in the site
config, then the collection's `referenceDate`. With none of them set, the build reports `dates.no-as-of` and writes no
window feed. Two as-of dates over the same data give two windows; one as-of date gives byte-identical files.

A window feed's entry id is the calendar event id, `<collection>/<record>/<event>@<host>`, when a calendar of the same
collection declares an event on the feed's `date` field. The `event` is that event's `name`, so the feed entry and the
`.ics` event identify the same thing. Without such a calendar event, the entry keeps the usual feed id, a tag URI of the
collection and record.
