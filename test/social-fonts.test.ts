import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadFonts, missingCharacters } from "../src/social/fonts.ts";

const SITE = resolve(fileURLToPath(new URL("../fixtures/social-site", import.meta.url)));
const LATIN = "fonts/geist-sans-latin-400-normal.woff";
const ARABIC = "fonts/vazirmatn-arabic-400-normal.woff";

test("declared WOFF fonts load with a family name and coverage", async () => {
  const set = await loadFonts(SITE, [LATIN, ARABIC]);
  assert.deepEqual(set.diagnostics, []);
  assert.equal(set.fonts.length, 2);
  assert.deepEqual(set.fonts.map((f) => f.family), ["Geist", "Vazirmatn"]);
  assert.match(set.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(missingCharacters(set.fonts, "Install نصب 24."), []);
});

test("a character no declared font draws is reported once", async () => {
  const set = await loadFonts(SITE, [LATIN]);
  assert.deepEqual(missingCharacters(set.fonts, "Hi نصب ن 日本"), ["ن", "ص", "ب", "日", "本"]);
  assert.deepEqual(missingCharacters(set.fonts, "a b\n‌‏"), []);
});

test("a missing file is reported and the others still load", async () => {
  const set = await loadFonts(SITE, ["fonts/none.woff", LATIN]);
  assert.deepEqual(set.diagnostics.map((d) => d.id), ["social.font-missing"]);
  assert.equal(set.fonts.length, 1);
});

test("a path outside the site is refused, also through a symlink", async () => {
  const outer = mkdtempSync(join(tmpdir(), "mizzen-social-fonts-"));
  try {
    const root = join(outer, "site");
    mkdirSync(root);
    symlinkSync(join(SITE, LATIN), join(root, "link.woff"));
    const set = await loadFonts(root, ["../x.woff", "/etc/hosts", "link.woff"]);
    assert.deepEqual(set.diagnostics.map((d) => d.id), ["social.font-outside", "social.font-outside", "social.font-outside"]);
    assert.equal(set.fonts.length, 0);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("WOFF2 and non-font files are reported, not drawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-social-fonts-"));
  try {
    writeFileSync(join(root, "a.woff2"), Buffer.from("wOF2xxxxxxxx"));
    writeFileSync(join(root, "b.txt"), "not a font at all");
    const set = await loadFonts(root, ["a.woff2", "b.txt"]);
    assert.deepEqual(set.diagnostics.map((d) => d.id), ["social.font-format", "social.font-format"]);
    assert.match(set.diagnostics[0]!.message, /WOFF2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the cache key follows the font bytes and the declared order", async () => {
  const a = await loadFonts(SITE, [LATIN, ARABIC]);
  const b = await loadFonts(SITE, [ARABIC, LATIN]);
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, (await loadFonts(SITE, [LATIN, ARABIC])).key);
});
