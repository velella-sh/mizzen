import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { run, site, write } from "./helpers-stale.ts";

const FILES = {
  "mizzen.yml": "title: T\n",
  "a.md": "---\ncovers: [src/*.ts, schema/a.json]\n---\n# A\n",
  "b.md": "---\ncovers: [lib/**/*.ts]\n---\n# B\n",
  "plain.md": "# P\n",
  "src/x.ts": "x",
  "lib/deep/y.ts": "y",
};

test("--changed prints the pages and the matched files", async () => {
  const root = site(FILES);
  const r = await run(["stale", "--site", root, "--changed", "src/x.ts", "./lib/deep/y.ts", "other.txt"]);
  assert.equal(r.code, 0);
  assert.equal(r.logs[0], "a.md\n  src/x.ts\nb.md\n  lib/deep/y.ts");
  const json = JSON.parse((await run(["stale", "--site", root, "--json", "--changed", "schema/a.json"])).logs[0]!);
  assert.deepEqual(json.pages, [{ page: "a.md", files: ["schema/a.json"] }]);
});

test("no match prints nothing and exits 0", async () => {
  const root = site(FILES);
  const r = await run(["stale", "--site", root, "--changed", "README.md"]);
  assert.deepEqual([r.code, r.logs], [0, []]);
});

test("--git-diff compares with a local ref", async () => {
  const root = site(FILES);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { env, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write(root, { "src/x.ts": "changed", "notes.txt": "n" });
  git("add", "-A");
  const r = await run(["stale", "--site", root, "--git-diff", "HEAD"]);
  assert.equal(r.code, 0, r.errors.join());
  assert.equal(r.logs[0], "a.md\n  src/x.ts");
  assert.equal((await run(["stale", "--site", root, "--git-diff", "no-such-ref"])).code, 2);
  assert.equal((await run(["stale", "--site", root, "--git-diff", "--output=x"])).code, 2);
});
