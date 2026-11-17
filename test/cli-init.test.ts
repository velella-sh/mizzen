import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

/** A theme folder with starters, written under a fresh temp folder. */
function theme(): string {
  const root = mkdtempSync(join(tmpdir(), "init-theme-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("starters/docs/starter.json", JSON.stringify({ title: "Docs", description: "A small docs site.", optionalLanguages: ["fa"] }));
  put("starters/docs/mizzen.yml", "title: Docs\n");
  put("starters/docs/index.md", "# Home\n");
  put("starters/docs/index.fa.md", "# خانه\n");
  put("starters/docs/fa/guide.md", "# راهنما\n");
  put("starters/blank/mizzen.yml", "title: Blank\n");
  return root;
}

async function run(args: readonly string[]): Promise<{ code: number; out: string; errors: string }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await main(args, { log: (m) => out.push(m), error: (m) => errors.push(m), write: (t) => out.push(t) });
  return { code, out: out.join("\n"), errors: errors.join("\n") };
}

function target(): string {
  return join(mkdtempSync(join(tmpdir(), "init-target-")), "site");
}

test("init --list prints each starter with its title and description", async () => {
  const themeRoot = theme();
  try {
    const result = await run(["init", "--list", "--theme", themeRoot]);
    assert.equal(result.code, 0);
    assert.equal(result.out, "blank\ndocs\tDocs\tA small docs site.");
  } finally {
    rmSync(themeRoot, { recursive: true, force: true });
  }
});

test("init copies the starter, leaves out starter.json, and keeps every language by default", async () => {
  const themeRoot = theme();
  const dir = target();
  try {
    const result = await run(["init", "--starter", "docs", dir, "--theme", themeRoot]);
    assert.equal(result.code, 0, result.errors);
    assert.deepEqual(readdirSync(dir).sort(), ["fa", "index.fa.md", "index.md", "mizzen.yml"]);
    assert.equal(readFileSync(join(dir, "index.md"), "utf8"), "# Home\n");
  } finally {
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("--lang keeps only the named optional languages", async () => {
  const themeRoot = theme();
  const dir = target();
  try {
    const result = await run(["init", "--starter", "docs", dir, "--theme", themeRoot, "--lang", "en"]);
    assert.equal(result.code, 1, "en is not an optional language of the starter");
    const kept = await run(["init", "--starter", "docs", dir, "--theme", themeRoot, "--lang", ""]);
    assert.equal(kept.code, 0, kept.errors);
    assert.deepEqual(readdirSync(dir).sort(), ["index.md", "mizzen.yml"]);
    assert.ok(!existsSync(join(dir, "fa")));
  } finally {
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("a target folder that is not empty is refused and left alone", async () => {
  const themeRoot = theme();
  const dir = target();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.md"), "mine\n");
    const result = await run(["init", "--starter", "docs", dir, "--theme", themeRoot]);
    assert.equal(result.code, 1);
    assert.match(result.errors, /not empty/);
    assert.deepEqual(readdirSync(dir), ["keep.md"]);
  } finally {
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("a missing starter or theme is named in the error", async () => {
  const themeRoot = theme();
  const dir = target();
  try {
    const starter = await run(["init", "--starter", "nope", dir, "--theme", themeRoot]);
    assert.equal(starter.code, 1);
    assert.match(starter.errors, /starter "nope" not found/);
    assert.match(starter.errors, /blank, docs/);
    const missing = await run(["init", "--starter", "docs", dir, "--theme", join(themeRoot, "absent")]);
    assert.equal(missing.code, 1);
    assert.match(missing.errors, /starter "docs" not found in the theme at .*absent/);
    assert.ok(!existsSync(dir), "nothing is created on failure");
  } finally {
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("init without --starter or --list is a usage error", async () => {
  const result = await run(["init"]);
  assert.equal(result.code, 2);
  assert.match(result.errors, /init needs --starter/);
});
