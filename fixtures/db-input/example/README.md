# SQLite and NDJSON equivalence

Both sites hold the same two product records. The SQLite site builds its database from `catalog.sql`; the NDJSON site
keeps the records one per line. `mizzen data extract` in either site writes the same canonical result, so both build
the same catalog.

```bash
cd sqlite-site
mkdir -p _data
sqlite3 _data/products.sqlite < catalog.sql
node ../../../../bin/mizzen.ts data extract
node ../../../../bin/mizzen.ts build --out dist

cd ../ndjson-site
node ../../../../bin/mizzen.ts data extract
node ../../../../bin/mizzen.ts build --out dist

diff -r ../sqlite-site/dist ./dist
```

The two `mizzen.lock.json` files name the same `sha256`, because the extracted result bytes are the same.
