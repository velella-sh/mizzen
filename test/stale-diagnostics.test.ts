import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/index.ts";
import { staleDiagnostics } from "../src/stale/diagnostics.ts";
import { run, site, write } from "./helpers-stale.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const FILES = {
  "mizzen.yml": "title: T\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "---\ntitle: Home\ncovers: [src/x.ts]\n---\n# Home\n",
  "src/x.ts": "x",
};

async function staleSite(extraConfig = ""): Promise<string> {
  const root = site({ ...FILES, "mizzen.yml": FILES["mizzen.yml"] + extraConfig });
  assert.equal((await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"])).code, 0);
  write(root, { "src/x.ts": "changed" });
  return root;
}

test("a site without covers gets no stale diagnostics", async () => {
  assert.deepEqual(await staleDiagnostics(site({ "mizzen.yml": "title: T\n", "index.md": "# Home\n" })), []);
});

test("a clean site gets none either", async () => {
  const root = site(FILES);
  await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"]);
  assert.deepEqual(await staleDiagnostics(root), []);
});

test("a stale page is a warning by default and names its files", async () => {
  const [d] = await staleDiagnostics(await staleSite());
  assert.equal(d?.id, "stale.page");
  assert.equal(d?.severity, "warning");
  assert.match(d!.message, /index\.md may be out of date \(last reviewed 2026-01-01\): changed src\/x\.ts/);
  assert.equal(d?.pos?.line, 3);
});

for (const severity of ["info", "warning", "error"] as const) {
  test(`stale.severity ${severity} is used`, async () => {
    const [d] = await staleDiagnostics(await staleSite(`stale:\n  severity: ${severity}\n`));
    assert.equal(d?.severity, severity);
  });
}

test("doctor and check carry the diagnostic in JSON, and only an error severity fails", async () => {
  for (const command of ["doctor", "check"]) {
    const warn = await run([command, await staleSite(), "--theme", THEME, "--format", "json"]);
    const found = JSON.parse(warn.logs.join("\n")).diagnostics.filter((d: { id: string }) => d.id === "stale.page");
    assert.equal(found.length, 1, command);
    assert.equal(found[0].severity, "warning");
    assert.match(found[0].message, /changed src\/x\.ts/);
    // doctor also fails on a Node older than 24, so only `check` shows the exit code of the stale finding alone.
    if (command === "check") assert.equal(warn.code, 0, warn.logs.join("\n").slice(0, 400));
    const err = await run([command, await staleSite("stale:\n  severity: error\n"), "--theme", THEME, "--format", "json"]);
    assert.equal(err.code, 1, command);
  }
});
