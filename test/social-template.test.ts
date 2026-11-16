import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTemplate, templateNameFor } from "../src/social/template.ts";
import type { Page, SiteConfig } from "../src/contracts/index.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function svg(body: string, attrs = 'width="1200" height="630" viewBox="0 0 1200 630"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

const SLOT = '<text data-slot="title" x="80" y="260" data-width="1040" data-max-lines="3" font-size="76" data-min-size="48">T</text>';

async function load(body: string, attrs?: string, files: Record<string, Buffer | string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mizzen-social-template-"));
  try {
    mkdirSync(join(root, "_templates", "social"), { recursive: true });
    writeFileSync(join(root, "_templates", "social", "t.svg"), svg(body, attrs));
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), data);
    }
    return await loadTemplate(root, root, "t");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ids(result: Awaited<ReturnType<typeof load>>): string[] {
  return result.ok ? [] : result.diagnostics.map((d) => d.id);
}

test("a valid template yields its slots and a hash", async () => {
  const result = await load(`<rect width="1200" height="630"/>${SLOT}`);
  assert.ok(result.ok);
  assert.equal(result.template.slots.length, 1);
  const slot = result.template.slots[0]!;
  assert.equal(slot.field, "title");
  assert.equal(slot.maxSize, 76);
  assert.equal(slot.minSize, 48);
  assert.equal(slot.maxLines, 3);
  assert.match(result.template.hash, /^[0-9a-f]{64}$/);
});

test("a missing template is a diagnostic, not a throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-social-template-"));
  try {
    const result = await loadTemplate(root, root, "nope");
    assert.deepEqual(ids(result), ["social.template-missing"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a template of the wrong size is rejected", async () => {
  assert.deepEqual(ids(await load(SLOT, 'width="800" height="600"')), ["social.template-invalid"]);
  assert.deepEqual(ids(await load(SLOT, 'width="1200" height="630" viewBox="0 0 10 10"')), ["social.template-invalid"]);
});

for (const [label, body] of [
  ["script", "<script>alert(1)</script>"],
  ["foreignObject", "<foreignObject><div/></foreignObject>"],
  ["animate", '<rect width="1" height="1"><animate attributeName="x" to="2"/></rect>'],
  ["an event attribute", '<rect width="1" height="1" onload="x()"/>'],
  ["an external href", '<use href="https://example.com/a.svg#b"/>'],
  ["an external url()", '<rect width="1" height="1" fill="url(https://example.com/x)"/>'],
  ["an @import", "<style>@import url(https://example.com/a.css);</style>"],
  ["a remote image", '<image href="https://example.com/a.png" width="1" height="1"/>'],
  ["an image of an unknown type", '<image href="a.svg" width="1" height="1"/>'],
] as const) {
  test(`a template with ${label} is rejected`, async () => {
    assert.deepEqual(ids(await load(`${body}${SLOT}`)), ["social.template-invalid"]);
  });
}

test("an image beside the template is inlined as a data URI", async () => {
  const a = await load(`<image href="../../logo.png" width="1" height="1"/>${SLOT}`, undefined, { "logo.png": PNG });
  assert.ok(a.ok);
  assert.match(a.template.svg, /data:image\/png;base64,/);
  assert.doesNotMatch(a.template.svg, /logo\.png/);
});

test("an image outside the site root is rejected, including through a symlink", async () => {
  const outer = mkdtempSync(join(tmpdir(), "mizzen-social-outer-"));
  try {
    const root = join(outer, "site");
    mkdirSync(join(root, "_templates", "social"), { recursive: true });
    writeFileSync(join(outer, "secret.png"), PNG);
    writeFileSync(join(root, "_templates", "social", "t.svg"), svg(`<image href="../../../secret.png" width="1" height="1"/>${SLOT}`));
    const direct = await loadTemplate(root, root, "t");
    assert.deepEqual(ids(direct), ["social.template-invalid"]);
    assert.match(direct.ok ? "" : direct.diagnostics[0]!.message, /outside the site root/);

    symlinkSync(join(outer, "secret.png"), join(root, "link.png"));
    writeFileSync(join(root, "_templates", "social", "t.svg"), svg(`<image href="../../link.png" width="1" height="1"/>${SLOT}`));
    assert.deepEqual(ids(await loadTemplate(root, root, "t")), ["social.template-invalid"]);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a slot without a width is rejected", async () => {
  assert.deepEqual(ids(await load('<text data-slot="title" x="1" y="1">T</text>')), ["social.template-invalid"]);
});

test("malformed markup is a diagnostic", async () => {
  assert.deepEqual(ids(await load("<rect>")), ["social.template-invalid"]);
});

function page(frontMatter: Record<string, unknown>): Page {
  return { frontMatter } as unknown as Page;
}
const withTemplate = { social: { template: "default", fonts: [] } } as unknown as SiteConfig;

test("template selection: default, page choice, page off, no config", () => {
  assert.deepEqual(templateNameFor(withTemplate, page({})), { name: "default" });
  assert.deepEqual(templateNameFor(withTemplate, page({ social: "wide" })), { name: "wide" });
  assert.deepEqual(templateNameFor(withTemplate, page({ social: false })), { name: undefined });
  assert.deepEqual(templateNameFor({} as SiteConfig, page({ social: "wide" })), { name: undefined });
  assert.equal(templateNameFor(withTemplate, page({ social: "../x" })).invalid !== undefined, true);
});
