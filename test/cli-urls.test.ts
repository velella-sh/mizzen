import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { site } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  pages:\n" +
    "    source: _data/pages.yml\n" +
    "    template: _templates/page.md\n" +
    "    permalink: /pages/{name|slug}/\n",
  "_data/pages.yml": "- id: a\n  name: Alpha\n",
  "_templates/page.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

/** A lock whose record `a` lives at `url`. */
function lock(url: string): string {
  return `${JSON.stringify({ version: 1, collections: { pages: { a: { url, previous: [] } } } })}\n`;
}

/** Runs the CLI and keeps what it wrote to each stream. */
async function run(args: readonly string[]): Promise<{ code: number; out: string; errors: string[] }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await main(args, {
    log: (message) => out.push(message),
    error: (message) => errors.push(message),
    write: (text) => out.push(text),
  });
  return { code, out: out.join(""), errors };
}

test("a clean site exits 0 and prints one summary line", async () => {
  const root = site({ ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/") });
  try {
    const result = await run(["urls", "check", root]);
    assert.equal(result.code, 0);
    assert.match(result.out, /1 record checked against urls\.lock\.json: 0 new, 0 changed, 0 removed\./);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed URL exits 1 and names both addresses", async () => {
  const root = site({ ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/"), "_data/pages.yml": "- id: a\n  name: Beta\n" });
  try {
    const result = await run(["urls", "check", root]);
    assert.equal(result.code, 1);
    assert.match(result.out, /changed pages\.a: \/pages\/alpha\/ -> \/pages\/beta\//);
    assert.match(result.errors.join("\n"), /urls\.url-changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--format json prints the whole report", async () => {
  const root = site({ ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/"), "_data/pages.yml": "- id: a\n  name: Beta\n" });
  try {
    const result = await run(["urls", "check", root, "--format", "json"]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.out) as {
      lock: boolean;
      checked: number;
      changed: { collection: string; id: string; from: string; to: string }[];
      errors: { id: string }[];
    };
    assert.equal(report.lock, true);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.changed, [{ collection: "pages", id: "a", from: "/pages/alpha/", to: "/pages/beta/" }]);
    assert.deepEqual(report.errors.map((finding) => finding.id), ["urls.url-changed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable lock fails the command and appears in text and JSON", async () => {
  const locks = [
    ["{ not json\n", "data.urls-lock-invalid"],
    ['{"version":2,"collections":{}}\n', "data.urls-lock-invalid"],
  ];
  for (const [contents, id] of locks) {
    const root = site({ ...FILES, [URLS_LOCK_FILE]: contents! });
    try {
      const text = await run(["urls", "check", root]);
      assert.equal(text.code, 1);
      assert.match(text.errors.join("\n"), new RegExp(id!));

      const json = await run(["urls", "check", root, "--format", "json"]);
      assert.equal(json.code, 1);
      const report = JSON.parse(json.out) as { lock: boolean; errors: { id: string }[] };
      assert.equal(report.lock, true);
      assert.ok(report.errors.some((finding) => finding.id === id), `${id} is in the JSON report`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("--update-urls belongs to build only", async () => {
  assert.equal((await run(["check", "--update-urls"])).code, 2);
  assert.equal((await run(["urls", "check", "--update-urls"])).code, 2);
  const help = await run(["urls", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /urls check \[dir\]/);
});

test("a site without a lock file is not a failure, and the command writes nothing", async () => {  const root = site(FILES);
  try {
    const result = await run(["urls", "check", root]);
    assert.equal(result.code, 0);
    assert.match(result.out, /No urls\.lock\.json yet: 1 record would publish a URL\./);
    await assert.rejects(async () => {
      const { readFile } = await import("node:fs/promises");
      await readFile(`${root}/${URLS_LOCK_FILE}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
