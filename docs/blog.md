# Blog metadata and routes

Epic: #545. Contract for #546, before the routes in #547 and the feed in #548.

A blog is ordinary pages plus four front-matter fields and one optional config block. A site without `blog` keeps
writing exactly what it writes today; nothing is implied by a folder name.

## Front matter

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `date` | `YYYY-MM-DD` | none | Required on a post. A calendar date, never a clock time, so two builds on two machines sort the same. |
| `author` | author id | none | Required on a post. Must name an entry in `_data/authors.yml`; an unknown id is a build error at the field. |
| `slug` | URL segment | the file name | Optional. One segment, no slash. Two posts may not share a slug, even in different folders. |
| `draft` | boolean | `false` | A draft is never written to a public route, the archive, the feed, or the sitemap. It is still validated. |

## Authors

`_data/authors.yml` is a map from id to a display record. Only `name` is required; the rest is passed to layouts
unchanged.

```yaml
armin:
  name: Armin
  url: https://example.org/armin/
  bio: Writes about docs builds.
```

An author without a page still renders a byline; `blog.authors: false` suppresses author routes.

## Opt in

```yaml
blog:
  posts: posts          # source folder, relative to the site root; required
  route: blog           # public prefix; default blog
  archive: archive      # archive route under the prefix; default archive
  authors: true         # write one page per author; default true
  feed: true            # write feed.xml; default true
  pageSize: 10          # posts per index page; default 10
```

Route names live only in this block. Changing `route` moves every public blog URL and leaves the rest of the site
alone. A site that never sets `blog` has no `/blog/`, no archive, no author page, and no feed.

## Order and URLs

- Posts sort by `date` descending, then by `slug` in code-point order. The tie-break is what makes two posts on the
  same day stable across rebuilds.
- A post lives at `<base>/<route>/<slug>/`; the index at `<base>/<route>/`, page 2 at `<base>/<route>/page/2/`.
- The archive lists every public post, newest first, at `<base>/<route>/<archive>/`.
- An author page lists that author's public posts at `<base>/<route>/authors/<id>/`.
- The feed contains public posts only, newest first, with an absolute URL per item.

## Fixture

[`fixtures/blog/`](../fixtures/blog/) has two public posts, both dated the same day, one draft, and two authors. It is
an input, not a buildable site: the metadata contract is what #547 and #548 implement against.

## Limits

- No scheduled publishing: a future `date` is public when the file says so. A clock is not an input to a deterministic
  build.
- No tags, categories, or pagination rules beyond `pageSize` in this contract.
- A draft is excluded from output, not hidden behind a flag; publishing it is a front-matter change.
