# data-large fixture

A generator for a data site of any size, used by `scripts/bench-data.ts` and the scale tests. The files are not
committed: `.generated/` is ignored, and the same arguments always write the same bytes.

```bash
node fixtures/data-large/generate.ts --records 10000 [--out <dir>] [--seed 1]
```

`--records` is the total over three collections: a few `regions` (CSV), then half and half `components` (YAML) and
`releases` (a JSON object keyed by id). Components reference a region, releases reference a component. The site also has
two list pages (`/components/`, `/releases/`, 100 per page) and one `releases` feed.

The only random source is a seeded mulberry32 generator, and dates are computed from a fixed day, so nothing reads the
clock. `test/data-large-fixture.test.ts` runs the generator twice for 1,000 and 10,000 records and compares the files.
The pages use the theme's `doc` layout, so the site builds with any theme that has it.
