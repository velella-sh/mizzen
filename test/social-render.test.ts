import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadFonts } from "../src/social/fonts.ts";
import { SocialRenderer, renderTemplate, stripPng } from "../src/social/render.ts";
import { loadTemplate } from "../src/social/template.ts";

const SITE = resolve(fileURLToPath(new URL("../fixtures/social-site", import.meta.url)));
const FONTS = ["fonts/geist-sans-latin-400-normal.woff", "fonts/vazirmatn-arabic-400-normal.woff"];

const CASES: Record<string, { values: Record<string, string>; sha256: string }> = {
  english: {
    values: {
      site: "Evergreen",
      title: "Install Evergreen on a fresh machine in under five minutes",
      description: "Everything you need to get the CLI running, from downloading the binary to your first build.",
    },
    sha256: "5a53267cd17fea28e7db9ffd6922746eccf688c0c8dc5eb7fb2bd6b6e950ac1b",
  },
  persian: {
    values: {
      site: "همیشه‌سبز",
      title: "نصب همیشه‌سبز روی یک دستگاه تازه در کمتر از پنج دقیقه با Node 24",
      description: "هر آنچه برای راه‌اندازی ابزار خط فرمان لازم دارید، از دریافت فایل تا نخستین ساخت سایت.",
    },
    sha256: "f661cb39470296d6ede8f358ac745deab5f48b0d344db8802d1bd972c27596f3",
  },
  "long word": {
    values: { site: "Evergreen", title: "Supercalifragilisticexpialidocious_".repeat(4), description: "x" },
    sha256: "9231f21b8f92dd46cb0edc8a15808ef6bdc4e4de1ff7b750d736f51d92eaa33d",
  },
};

async function setup() {
  const fonts = await loadFonts(SITE, FONTS);
  assert.deepEqual(fonts.diagnostics, []);
  const loaded = await loadTemplate(SITE, SITE, "default");
  assert.ok(loaded.ok);
  return { template: loaded.template, renderer: await SocialRenderer.create(fonts.fonts) };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// These hashes are the cross-platform contract: CI runs this file on Linux, macOS and Windows, and all three must draw
// the same bytes. A change to a hash is a deliberate change to what the images look like.
for (const [name, entry] of Object.entries(CASES)) {
  test(`the ${name} fixture image has the recorded bytes`, async () => {
    const { template, renderer } = await setup();
    const { png } = renderTemplate(template, entry.values, renderer);
    assert.equal(sha(png), entry.sha256);
  });
}

test("rendering twice gives the same bytes", async () => {
  const { template, renderer } = await setup();
  const a = renderTemplate(template, CASES.english!.values, renderer).png;
  const b = renderTemplate(template, CASES.english!.values, await SocialRenderer.create((await loadFonts(SITE, FONTS)).fonts)).png;
  assert.equal(sha(a), sha(b));
});

test("the PNG is 1200 by 630 and carries no time, text, or software chunk", async () => {
  const { template, renderer } = await setup();
  const { png } = renderTemplate(template, CASES.english!.values, renderer);
  const file = Buffer.from(png);
  assert.equal(file.readUInt32BE(16), 1200);
  assert.equal(file.readUInt32BE(20), 630);
  const types: string[] = [];
  for (let at = 8; at < file.length; at += 12 + file.readUInt32BE(at)) types.push(file.toString("latin1", at + 4, at + 8));
  assert.deepEqual(types.filter((t) => !["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(t)), []);
  assert.equal(types[0], "IHDR");
  assert.equal(types.at(-1), "IEND");
  for (const banned of ["tIME", "tEXt", "iTXt", "zTXt", "eXIf", "iCCP"]) assert.ok(!file.includes(banned), banned);
});

test("stripPng drops ancillary chunks and refuses other files", () => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.alloc(13)),
    chunk("tIME", Buffer.alloc(7)),
    chunk("tEXt", Buffer.from("Software\0x")),
    chunk("IDAT", Buffer.alloc(3)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const out = Buffer.from(stripPng(png));
  assert.ok(!out.includes("tIME") && !out.includes("tEXt"));
  assert.ok(out.includes("IDAT"));
  assert.throws(() => stripPng(Buffer.from("nope nope nope")));
});

test("the renderer never reads a system font", async () => {
  const bare = await SocialRenderer.create([]);
  const { template } = await setup();
  const { png } = renderTemplate(template, CASES.english!.values, bare);
  assert.ok(png.length > 0);
});
