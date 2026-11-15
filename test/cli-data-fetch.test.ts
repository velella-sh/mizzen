import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dataFetch, type FetchLike } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { readLock } from "../src/data/lock.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-data-fetch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: { log: (message: string) => void logs.push(message), error: (message: string) => void errors.push(message) },
  };
}

test("parseArgs registers data fetch with and without --check", () => {
  assert.deepEqual(parseArgs(["data", "fetch"]), {
    options: { command: "data-fetch", root: ".", check: false },
  });
  assert.deepEqual(parseArgs(["data", "fetch", "site", "--check"]), {
    options: { command: "data-fetch", root: "site", check: true },
  });
  assert.equal("error" in parseArgs(["data"]), true);
  assert.equal("error" in parseArgs(["data", "pull"]), true);
});

test("the first fetch pins a source, the second leaves it unchanged, and a change is detected", async () => {
  let body = "id,name\n1,Alpha\n";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/csv", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetcher: FetchLike = (url, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);

  const root = tree({
    "mizzen.yml":
      "collections:\n  items:\n    source: https://data.test/items.csv\n    limits:\n      bytes: 200\n",
  });
  try {
    const first = await dataFetch({ root, fetch: fetcher });
    assert.equal(first.code, 0);
    assert.deepEqual(first.errors, []);
    assert.ok(first.messages.some((message) => message.startsWith("new https://data.test/items.csv")));
    const lock = await readLock(root);
    const entry = lock.lock.sources["https://data.test/items.csv"];
    assert.ok(entry);
    assert.equal(entry.bytes, Buffer.byteLength(body));
    assert.ok(existsSync(join(root, ".mizzen/data", entry.sha256)));

    const second = await dataFetch({ root, fetch: fetcher });
    assert.equal(second.code, 0);
    assert.ok(second.messages.some((message) => message.startsWith("unchanged ")));

    body = "id,name\n1,Beta\n";
    const changed = await dataFetch({ root, fetch: fetcher });
    assert.equal(changed.code, 0);
    assert.ok(changed.messages.some((message) => message.startsWith("changed ")));
    const after = await readLock(root);
    assert.notEqual(after.lock.sources["https://data.test/items.csv"]?.sha256, entry.sha256);

    const check = await dataFetch({ root, fetch: fetcher, check: true });
    assert.equal(check.code, 0, "check after the change was already written");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check reports a changed source and writes nothing", async () => {
  let body = "id,name\n1,Alpha\n";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetcher: FetchLike = (url, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: https://data.test/items.csv\n",
  });
  try {
    const first = await dataFetch({ root, fetch: fetcher });
    assert.equal(first.code, 0);
    const lockBefore = readFileSync(join(root, "mizzen.lock.json"), "utf8");

    body = "id,name\n1,Beta\n";
    const check = await dataFetch({ root, fetch: fetcher, check: true });
    assert.equal(check.code, 1);
    assert.ok(check.messages.some((message) => message.startsWith("changed ")));
    assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), lockBefore, "the lock did not change");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversize response fails without writing a lock", async () => {
  const body = "x".repeat(100);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetcher: FetchLike = (url, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
  const root = tree({
    "mizzen.yml":
      "collections:\n  items:\n    source: https://data.test/items.csv\n    limits:\n      bytes: 10\n",
  });
  try {
    const result = await dataFetch({ root, fetch: fetcher });
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((message) => message.includes("larger than")));
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false);
    assert.equal(existsSync(join(root, ".mizzen")), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI command pins an installed package and exits 0", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: npm:@acme/data/items.yml\n",
    "node_modules/@acme/data/package.json": JSON.stringify({ name: "@acme/data", version: "1.2.3" }),
    "node_modules/@acme/data/items.yml": "- id: a\n  name: Alpha\n",
  });
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["data", "fetch", root], io), 0);
    assert.deepEqual(errors, []);
    assert.ok(logs.some((line) => line.startsWith("wrote mizzen.lock.json")));
    const lock = await readLock(root);
    assert.equal(lock.lock.sources["npm:@acme/data/items.yml"]?.version, "1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
