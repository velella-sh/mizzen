# Blog fixture

Two public posts dated the same day, one draft, and two authors. An input for the contract in
[`docs/blog.md`](../../docs/blog.md), not a buildable site yet.

| File | Shows |
| --- | --- |
| `posts/hello-world.md` | a complete post: date, author, explicit slug, description |
| `posts/one-more-day.md` | the same date, no slug (file name), the second author |
| `posts/not-yet.md` | `draft: true`, otherwise valid |
| `_data/authors.yml` | two authors, one with a URL and bio |
