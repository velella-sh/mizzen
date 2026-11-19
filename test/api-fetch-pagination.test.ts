import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { build } from "../src/pipeline/build.ts";
import { dataFetch } from "../src/cli/data.ts";
import { loadConfigText } from "../src/config/load.ts";
import { readLock, storedPath, type LockedSource } from "../src/data/lock.ts";

const THEME = new URL("../../lateen", import.meta.url).pathname;

interface RequestLog {
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
}

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Served {
  readonly port: number;
  readonly requests: RequestLog[];
  close(): Promise<void>;
}

/** A local JSON API; no test here reaches the public internet. */
async function serve(handler: (url: URL, headers: IncomingHttpHeaders) => Reply): Promise<Served> {
  const requests: RequestLog[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    requests.push({ url, headers: request.headers });
    const reply = handler(url, request.headers);
    response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    response.end(reply.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "api-fetch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function config(source: string, extra: Record<string, unknown> = {}): string {
  return stringify({ collections: { items: { source, records: "data.items", ...extra } } });
}

/** `{ data: { items: records } }`, the nested response every route serves unless a test says otherwise. */
function page(records: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ data: { items: records }, ...extra });
}

function recordsOf(root: string): unknown[] {
  const lock = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as { sources: Record<string, LockedSource> };
  const address = Object.keys(lock.sources)[0]!;
  const entry = lock.sources[address]!;
  return JSON.parse(readFileSync(storedPath(root, entry.sha256), "utf8")) as unknown[];
}

function lockText(root: string): string {
  return readFileSync(join(root, "mizzen.lock.json"), "utf8");
}

test("a paginated source validates its record path and mode, and a plain https source stays valid", () => {
  const valid = loadConfigText(
    config("https://api.test/items", { pagination: { mode: "page", param: "p", pageSize: 2, stop: "short" } }),
    "mizzen.yml",
    "site",
  );
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.config.collections.items?.records, "data.items");
  assert.equal(valid.config.collections.items?.pagination?.mode, "page");

  const legacy = loadConfigText(
    "collections:\n  items:\n    source: https://data.test/items.csv\n",
    "mizzen.yml",
    "site",
  );
  assert.deepEqual(legacy.diagnostics, []);

  const noRecords = loadConfigText(config("https://api.test/items", { pagination: { mode: "page", stop: "empty" } }).replace("    records: data.items\n", ""), "mizzen.yml", "site");
  assert.equal(noRecords.diagnostics.some((entry) => entry.id === "config.api-records"), true);

  const noStop = loadConfigText(config("https://api.test/items", { pagination: { mode: "offset" } }), "mizzen.yml", "site");
  assert.equal(noStop.diagnostics.some((entry) => entry.id === "config.api-stop"), true);

  const shortNoSize = loadConfigText(config("https://api.test/items", { pagination: { mode: "page", stop: "short" } }), "mizzen.yml", "site");
  assert.equal(shortNoSize.diagnostics.some((entry) => entry.id === "config.api-page-size"), true);

  const noCursor = loadConfigText(config("https://api.test/items", { pagination: { mode: "cursor" } }), "mizzen.yml", "site");
  assert.equal(noCursor.diagnostics.some((entry) => entry.id === "config.api-cursor"), true);

  const noNext = loadConfigText(config("https://api.test/items", { pagination: { mode: "next" } }), "mizzen.yml", "site");
  assert.equal(noNext.diagnostics.some((entry) => entry.id === "config.api-next"), true);

  const local = loadConfigText(config("_data/items.yml"), "mizzen.yml", "site");
  assert.equal(local.diagnostics.some((entry) => entry.id === "config.api-source"), true);
});

test("a nested record array is read, and a missing path names its page", async () => {
  const server = await serve((url) =>
    url.searchParams.get("page") === "2"
      ? { body: JSON.stringify({ data: {} }) }
      : { body: page([{ id: "a" }, { id: "b" }]) },
  );
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "page", param: "page", start: 1, pageSize: 2, stop: "short" },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes("Page 2") && line.includes("data.items")), result.errors.join("\n"));
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("page-number pagination sends its parameter and stops on a short page", async () => {
  const pages: Record<string, unknown[]> = {
    "1": [{ id: "a" }, { id: "b" }],
    "2": [{ id: "c" }, { id: "d" }],
    "3": [{ id: "e" }],
  };
  const server = await serve((url) => ({ body: page(pages[url.searchParams.get("p") ?? ""] ?? []) }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "page", param: "p", start: 1, pageSize: 2, stop: "short" },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.deepEqual(server.requests.map((entry) => entry.url.searchParams.get("p")), ["1", "2", "3"]);
    assert.deepEqual((recordsOf(root) as { id: string }[]).map((record) => record.id), ["a", "b", "c", "d", "e"]);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("offset pagination advances by the records it consumed and ends on a short response", async () => {
  const byOffset: Record<string, unknown[]> = {
    "0": [{ id: "a" }, { id: "b" }],
    "2": [{ id: "c" }, { id: "d" }],
    "4": [{ id: "e" }],
  };
  const server = await serve((url) => ({ body: page(byOffset[url.searchParams.get("offset") ?? ""] ?? []) }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "offset", param: "offset", start: 0, pageSize: 2, stop: "short" },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.deepEqual(server.requests.map((entry) => entry.url.searchParams.get("offset")), ["0", "2", "4"]);
    assert.equal(recordsOf(root).length, 5);

    const empty = await serve((url) => ({ body: url.searchParams.get("offset") === "0" ? page([{ id: "a" }, { id: "b" }]) : page([]) }));
    try {
      const emptyRoot = tree({
        "mizzen.yml": config(`http://127.0.0.1:${empty.port}/items`, {
          pagination: { mode: "offset", param: "offset", start: 0, stop: "empty" },
        }),
      });
      const emptyResult = await dataFetch({ root: emptyRoot });
      assert.equal(emptyResult.code, 0, emptyResult.errors.join("\n"));
      assert.equal(recordsOf(emptyRoot).length, 2);
      rmSync(emptyRoot, { recursive: true, force: true });
    } finally {
      await empty.close();
    }
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("cursor pagination passes the string unchanged and a missing cursor ends successfully", async () => {
  const cursor = "a+b/c==";
  const server = await serve((url) => {
    const value = url.searchParams.get("cursor");
    if (value === null) return { body: page([{ id: "a" }, { id: "b" }], { meta: { next: cursor } }) };
    if (value === cursor) return { body: page([{ id: "c" }, { id: "d" }], { meta: { next: null } }) };
    return { status: 400, body: JSON.stringify({ error: "bad cursor" }) };
  });
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "cursor", param: "cursor", cursor: "meta.next" },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.deepEqual(server.requests.map((entry) => entry.url.searchParams.get("cursor")), [null, cursor]);
    assert.equal(recordsOf(root).length, 4);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("a relative next-page URL resolves, and an origin outside the allowlist is refused", async () => {
  const server = await serve((url) =>
    url.searchParams.get("page") === "2"
      ? { body: page([{ id: "c" }]) }
      : { body: page([{ id: "a" }, { id: "b" }], { links: { next: "/items?page=2" } }) },
  );
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, { pagination: { mode: "next", next: "links.next" } }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.deepEqual(server.requests.map((entry) => entry.url.pathname + entry.url.search), ["/items", "/items?page=2"]);
    assert.equal(recordsOf(root).length, 3);
    rmSync(root, { recursive: true, force: true });

    const outside = await serve(() => ({ body: page([{ id: "a" }], { links: { next: "https://other.test/items" } }) }));
    try {
      const outsideRoot = tree({
        "mizzen.yml": config(`http://127.0.0.1:${outside.port}/items`, { pagination: { mode: "next", next: "links.next" } }),
      });
      const outsideResult = await dataFetch({ root: outsideRoot });
      assert.equal(outsideResult.code, 1);
      assert.ok(outsideResult.errors.some((line) => line.includes("may not follow") && line.includes("other.test")), outsideResult.errors.join("\n"));
      assert.equal(existsSync(join(outsideRoot, "mizzen.lock.json")), false);
      rmSync(outsideRoot, { recursive: true, force: true });
    } finally {
      await outside.close();
    }
  } finally {
    await server.close();
  }
});

test("a repeated cursor, the page cap, and the byte cap each stop with their own diagnostic", async () => {
  let cursorPage = 0;
  const cursorServer = await serve(() => ({ body: page([{ id: String(cursorPage++) }], { meta: { next: "same" } }) }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${cursorServer.port}/items`, {
        pagination: { mode: "cursor", cursor: "meta.next", maxPages: 10 },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes("twice")), result.errors.join("\n"));
    rmSync(root, { recursive: true, force: true });
  } finally {
    await cursorServer.close();
  }

  const pageServer = await serve((url) => ({ body: page([{ id: url.searchParams.get("page") ?? "a" }], { links: { next: `/items?page=${Number(url.searchParams.get("page") ?? "1") + 1}` } }) }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${pageServer.port}/items`, {
        pagination: { mode: "next", next: "links.next", maxPages: 2 },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes("read 2 pages") && line.includes("limit is 2")), result.errors.join("\n"));
    rmSync(root, { recursive: true, force: true });
  } finally {
    await pageServer.close();
  }

  const byteServer = await serve(() => ({ body: page([{ id: "a", note: "x".repeat(200) }]) }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${byteServer.port}/items`, {
        pagination: { mode: "page", stop: "empty", maxBytes: 50 },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes("more than 50 bytes") && line.includes("limit is 50")), result.errors.join("\n"));
    rmSync(root, { recursive: true, force: true });
  } finally {
    await byteServer.close();
  }
});

test("the stored JSON list obeys the collection byte limit, not only the raw responses", async () => {
  const body = page([{ id: "a" }, { id: "b" }]);
  const server = await serve(() => ({ body }));
  const root = tree({
    "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, { limits: { bytes: Buffer.byteLength(body) } }),
  });
  try {
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes("stores") && line.includes("limit is")), result.errors.join("\n"));
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test("a credential is read from the environment, sent only to its origin, and never written", async () => {
  const secret = "hunter2-secret";
  const server = await serve((url, headers) => ({
    body: url.searchParams.get("page") === "2"
      ? page([])
      : page([{ id: "a" }], { links: { next: "/items?page=2" } }),
    headers: { "content-type": "application/json" },
    ...(headers.authorization === `Bearer ${secret}` ? {} : { status: 401 }),
  }));
  const previous = process.env.API_FETCH_TOKEN;
  process.env.API_FETCH_TOKEN = secret;
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "next", next: "links.next", auth: { env: "API_FETCH_TOKEN", prefix: "Bearer " } },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${secret}`);
    const written = [lockText(root), result.messages.join("\n"), result.errors.join("\n")].join("\n");
    assert.equal(written.includes(secret), false, "the secret appears in the lock or a report");
    rmSync(root, { recursive: true, force: true });

    delete process.env.API_FETCH_TOKEN;
    const missingRoot = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "page", stop: "empty", auth: { env: "API_FETCH_TOKEN" } },
      }),
    });
    const missing = await dataFetch({ root: missingRoot });
    assert.equal(missing.code, 1);
    assert.ok(missing.errors.some((line) => line.includes("API_FETCH_TOKEN") && line.includes("unset")), missing.errors.join("\n"));
    assert.equal(existsSync(join(missingRoot, "mizzen.lock.json")), false);
    rmSync(missingRoot, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.API_FETCH_TOKEN;
    else process.env.API_FETCH_TOKEN = previous;
    await server.close();
  }
});

test("a transient failure is retried within the limit, and a permanent one is reported at once", async () => {
  let attempts = 0;
  const flaky = await serve(() => {
    attempts += 1;
    return attempts === 1 ? { status: 429 } : { body: page([{ id: "a" }]) };
  });
  try {
    const root = tree({ "mizzen.yml": config(`http://127.0.0.1:${flaky.port}/items`) });
    const result = await dataFetch({ root });
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.equal(attempts, 2);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await flaky.close();
  }

  let permanent = 0;
  const missing = await serve(() => {
    permanent += 1;
    return { status: 404 };
  });
  try {
    const root = tree({ "mizzen.yml": config(`http://127.0.0.1:${missing.port}/items`, { pagination: { mode: "page", stop: "empty", retries: 3 } }) });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.equal(permanent, 1, "a permanent error is not retried");
    assert.ok(result.errors.some((line) => line.includes("HTTP 404")), result.errors.join("\n"));
    rmSync(root, { recursive: true, force: true });
  } finally {
    await missing.close();
  }

  let exhausted = 0;
  const down = await serve(() => {
    exhausted += 1;
    return { status: 503 };
  });
  try {
    const root = tree({ "mizzen.yml": config(`http://127.0.0.1:${down.port}/items`, { pagination: { mode: "page", stop: "empty", retries: 1 } }) });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.equal(exhausted, 2);
    assert.ok(result.errors.some((line) => line.includes("HTTP 503")), result.errors.join("\n"));
    rmSync(root, { recursive: true, force: true });
  } finally {
    await down.close();
  }
});

test("a duplicate id across pages names the id and both pages", async () => {
  const server = await serve((url) => ({
    body: page(url.searchParams.get("page") === "2" ? [{ id: "same" }] : [{ id: "a" }, { id: "same" }]),
  }));
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, {
        pagination: { mode: "page", param: "page", start: 1, pageSize: 2, stop: "short" },
      }),
    });
    const result = await dataFetch({ root });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((line) => line.includes(`"same"`) && line.includes("pages 1 and 2")), result.errors.join("\n"));
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("the lock records page order and hashes, and an identical fetch changes nothing", async () => {
  const server = await serve((url) => ({
    body: url.searchParams.get("page") === "2"
      ? page([{ id: "c" }])
      : page([{ id: "a" }, { id: "b" }], { links: { next: "/items?page=2" } }),
  }));
  try {
    const root = tree({ "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, { pagination: { mode: "next", next: "links.next" } }) });
    const first = await dataFetch({ root });
    assert.equal(first.code, 0, first.errors.join("\n"));
    const locked = JSON.parse(lockText(root)) as { sources: Record<string, LockedSource> };
    const entry = locked.sources[`http://127.0.0.1:${server.port}/items`]!;
    assert.deepEqual(entry.pages?.map((entryPage) => entryPage.url), [
      `http://127.0.0.1:${server.port}/items`,
      `http://127.0.0.1:${server.port}/items?page=2`,
    ]);
    assert.equal(entry.pages?.every((entryPage) => /^[0-9a-f]{64}$/.test(entryPage.sha256)), true);
    assert.equal(entry.pages?.every((entryPage) => entryPage.bytes > 0), true);
    const before = lockText(root);
    const second = await dataFetch({ root });
    assert.equal(second.code, 0);
    assert.ok(second.messages.some((line) => line.startsWith("unchanged ")), second.messages.join("\n"));
    assert.equal(lockText(root), before);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("a failure on the last page leaves the previous lock and input untouched", async () => {
  let fail = false;
  const server = await serve((url) => {
    if (fail && url.searchParams.get("page") === "2") return { status: 500 };
    return { body: url.searchParams.get("page") === "2" ? page([{ id: "c" }]) : page([{ id: "a" }, { id: "b" }], { links: { next: "/items?page=2" } }) };
  });
  try {
    const root = tree({
      "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, { pagination: { mode: "next", next: "links.next", retries: 0 } }),
    });
    const first = await dataFetch({ root });
    assert.equal(first.code, 0, first.errors.join("\n"));
    const before = lockText(root);
    const storeBefore = readdirSync(join(root, ".mizzen/data")).sort();

    fail = true;
    const second = await dataFetch({ root });
    assert.equal(second.code, 1);
    assert.equal(lockText(root), before, "the lock changed after a failed fetch");
    assert.deepEqual(readdirSync(join(root, ".mizzen/data")).sort(), storeBefore, "the store changed after a failed fetch");
    assert.deepEqual((recordsOf(root) as { id: string }[]).map((record) => record.id), ["a", "b", "c"]);
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("--check reports changed paginated data with exit 1 and writes nothing", async () => {
  let body = page([{ id: "a" }, { id: "b" }], { links: { next: "/items?page=2" } });
  const server = await serve((url) => ({ body: url.searchParams.get("page") === "2" ? page([{ id: "c" }]) : body }));
  try {
    const root = tree({ "mizzen.yml": config(`http://127.0.0.1:${server.port}/items`, { pagination: { mode: "next", next: "links.next" } }) });
    assert.equal((await dataFetch({ root })).code, 0);
    const before = lockText(root);
    const storeBefore = readdirSync(join(root, ".mizzen/data")).sort();

    const unchanged = await dataFetch({ root, check: true });
    assert.equal(unchanged.code, 0);
    assert.equal(lockText(root), before);

    body = page([{ id: "a" }, { id: "changed" }], { links: { next: "/items?page=2" } });
    const changed = await dataFetch({ root, check: true });
    assert.equal(changed.code, 1);
    assert.ok(changed.messages.some((line) => line.startsWith("changed ")), changed.messages.join("\n"));
    assert.equal(lockText(root), before, "--check wrote the lock");
    assert.deepEqual(readdirSync(join(root, ".mizzen/data")).sort(), storeBefore, "--check wrote a store file");
    rmSync(root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("an offline build reads the fetched multi-page input without a network", async () => {
  const server = await serve((url) => ({
    body: url.searchParams.get("page") === "2"
      ? page([{ id: "c", name: "Gamma" }])
      : page([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], { links: { next: "/items?page=2" } }),
  }));
  let root = "";
  const out = mkdtempSync(join(tmpdir(), "api-fetch-out-"));
  try {
    root = tree({
      "mizzen.yml": stringify({
        title: "Example",
        url: "https://example.test",
        collections: {
          items: {
            source: `http://127.0.0.1:${server.port}/items`,
            records: "data.items",
            pagination: { mode: "next", next: "links.next" },
            template: "_templates/item.md",
            permalink: "/items/{id}/",
          },
        },
      }),
      "_templates/item.md": "---\ntitle: Item\nlayout: doc\n---\n\n# :field[name]\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello.\n",
    });
    const fetched = await dataFetch({ root });
    assert.equal(fetched.code, 0, fetched.errors.join("\n"));

    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a build must not fetch");
    }) as typeof fetch;
    try {
      const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
      const errors = result.diagnostics.filter((entry) => entry.severity === "error");
      assert.deepEqual(errors, []);
      for (const id of ["a", "b", "c"]) {
        const html = readFileSync(join(out, "items", id, "index.html"), "utf8");
        assert.ok(html.includes({ a: "Alpha", b: "Beta", c: "Gamma" }[id]!), `${id} is missing from the built page`);
      }
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    await server.close();
  }
});
