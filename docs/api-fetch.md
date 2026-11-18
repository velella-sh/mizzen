# Fetching a paginated API

A collection can read a JSON API instead of a file. `mizzen data fetch` walks the API, stores every record as one
JSON list under `.mizzen/data/`, and pins the list and the pages it came from in `mizzen.lock.json`. A build reads
only the stored list and never opens a network connection.

```yaml
collections:
  items:
    source: https://api.example.com/v1/items
    records: data.items          # dot path to the record array in each response
    pagination:
      mode: page                 # page, offset, cursor, or next
      param: page                # query parameter; the default depends on the mode
      start: 1
      pageSize: 100
      stop: short                # empty or short
```

`records` alone is valid: the fetch reads one response and stores its array. A source without `records` keeps the
old behavior exactly: its body is stored byte for byte and parsed by its file extension.

A paginated `source` must be an `https://` URL. Plain `http://` is accepted only for `127.0.0.1`, `localhost`, and
`[::1]`, so a local sample service can be used in tests. Nothing else may be a plain-http source.

## Modes

| Mode | Sends | Ends when |
| --- | --- | --- |
| `page` | `param` set to the page number, from `start` | `stop: empty` on a page with no records, or `stop: short` below `pageSize` |
| `offset` | `param` set to the offset, from `start` (default `0`) | the same stop conditions; the offset grows by the number of records the page held |
| `cursor` | `param` set to the string at the `cursor` path | the path is absent, `null`, or `""` |
| `next` | nothing; it requests the URL at the `next` path | the path is absent, `null`, or `""` |

`stop` is required for `page` and `offset`, and `pageSize` is required for `stop: short`. A cursor passes through
unchanged: it is put into the query string as the same string the response wrote. A relative next-page URL resolves
against the page that named it. A next-page URL must name the source's origin, or an origin listed under
`pagination.origins`; any other origin is refused before a request is sent.

## Limits

| Key | Default | Stops with |
| --- | --- | --- |
| `maxPages` | `50` | `data.api-too-many-pages`, before page 51 is requested |
| `maxBytes` | the collection's `limits.bytes` | `data.api-too-large`, when the pages read pass the cap |
| `retries` | `2` | after the last retry, with `data.api-http` or `data.api-request` |

A transport error, HTTP 408, 429, 500, 502, 503, or 504 is retried up to `retries` times; every other status is
reported at once. A repeated cursor stops with `data.api-cursor-repeat`, and a repeated next-page URL with
`data.api-page-repeat`. A missing record array names its page, such as `Page 2 of collection "items" has no record
array at "data.items"`. A record id that appears twice names the id and both pages. The first problem stops the
run before any project file is written.

## Authentication

```yaml
pagination:
  mode: next
  next: links.next
  auth:
    env: ITEMS_TOKEN      # the name of the environment variable, never the value
    header: Authorization # default
    prefix: "Bearer "     # default empty
```

The credential is read when the command runs and is sent only to an allowed origin. It is never written to the
config, the lock, the store, a report, or an error: a server response is never copied into a message. A missing or
empty variable is one diagnostic that names the variable.

## The lock and the store

The lock entry for an API source holds the SHA-256 and size of the stored list, plus `pages`: each page's final URL,
byte size, and SHA-256, in fetch order. An identical fetch writes the same lock; the source's `fetchedAt` is kept
from the first fetch. A fetch that fails on a later page leaves the previous lock and stored list untouched, because
every page is read before anything is written.

`mizzen data fetch --check` performs the same reads and writes nothing. It exits `0` when every source matches the
lock, `1` when a source is new, changed, or unreadable, and `2` for a usage problem. `mizzen data fetch` writes all
sources only when every source succeeded.

## Building offline

After a successful fetch, `mizzen build` reads `.mizzen/data/<sha256>`, which is the combined list in fetch order.
Records and URLs are the same with networking disabled. `data fetch` is the only command that opens a connection;
a build never does.

## Example

`fixtures/api-fetch/example/` holds a small service with one page-number and one cursor endpoint, and a site for
each. Run the service, replace `127.0.0.1:0` in each `mizzen.yml` with the printed address, then run
`mizzen data fetch page-site` and `mizzen data fetch cursor-site`. Each pins five records, and a second fetch
changes nothing. From a checkout, use `node bin/mizzen.ts` in place of `mizzen`.
