# API fetch example

A runnable cursor and page-number example against a sample service. No test or step here reaches the public
internet: the service listens on `127.0.0.1`, the one plain-http host `mizzen data fetch` accepts.

From an installed package, in a project that has the service file and this folder:

```bash
node service.mjs &          # prints "ready <port>"
# replace 127.0.0.1:0 in each mizzen.yml with the printed address
npx mizzen data fetch page-site
npx mizzen data fetch cursor-site
```

Both sites pin five records (`a` through `e`). A second fetch changes nothing; `npx mizzen data fetch page-site
--check` exits 0 while the data is unchanged and 1 once the service returns different data. `mizzen build` on either
site reads `.mizzen/data/` and never opens a network connection.

From a checkout of Mizzen, run `node bin/mizzen.ts` instead of `npx mizzen`.
