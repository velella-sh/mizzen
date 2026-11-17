# report-archive gallery fixture

Two published scan runs with an id, a date, and a commit. `/latest/` shows the newest run, and `/gallery/` lists
every run with a status filter (`/gallery/clean/`) and a date filter (`/gallery/recent/`). Each entry shows its date
and commit. Used by [`test/report-archive/gallery.test.ts`](../../../test/report-archive/gallery.test.ts).
