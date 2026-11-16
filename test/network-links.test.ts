/** `[[project:/path/]]` links: resolved from the lock, titled from it, diagnosed with a file and line, hidden projects refused. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { H, lockOf, networkSite } from "./helpers-network.ts";


async function pageWith(body: string, lock = lockOf()) {
  const root = await networkSite("", lock);
  writeFileSync(join(root, "links.md"), `---\ntitle: Links\n---\n${body}\n`);
  const { site, diagnostics } = await buildModel(root);
  return { page: site.pages.find((p) => p.title === "Links")!, diagnostics };
}

test("a link to another project's page becomes a link with the page's title", async () => {
  const { page, diagnostics } = await pageWith("See [[blog:/post/]] now.");
  assert.deepEqual(diagnostics.filter((d) => d.id.startsWith("network.")), []);
  assert.match(page.html, /<a href="\/blog\/post\/">A post<\/a>/);
  assert.doesNotMatch(page.html, /\[\[/);
});

test("the author's text wins over the title, and an anchor is kept", async () => {
  const { page } = await pageWith("Read [[blog:/post/#intro|the post]].");
  assert.match(page.html, /<a href="\/blog\/post\/#intro">the post<\/a>/);
});

test("a link inside code is left alone", async () => {
  const { page, diagnostics } = await pageWith("`[[blog:/nope/]]`\n\n```\n[[blog:/nope/]]\n```");
  assert.deepEqual(diagnostics.filter((d) => d.id.startsWith("network.link")), []);
  assert.match(page.html, /\[\[blog:\/nope\/\]\]/);
});

test("a missing project or page is an error at the link's file and line, and the text stays", async () => {
  const { page, diagnostics } = await pageWith("First line.\n\nSee [[wiki:/x/]] and [[blog:/nope/]].");
  const project = diagnostics.find((d) => d.id === "network.link-missing-project");
  const missing = diagnostics.find((d) => d.id === "network.link-missing-page");
  assert.equal(project?.severity, "error");
  assert.equal(missing?.severity, "error");
  assert.equal(project?.pos?.file, "links.md");
  assert.equal(project?.pos?.line, 6);
  assert.equal(missing?.pos?.line, 6);
  assert.match(page.html, /\[\[wiki:\/x\/\]\]/);
});

test("a page whose hash changed in the latest update is a warning", async () => {
  const lock = lockOf();
  const blog = lock.projects[1]!;
  const changed = { ...lock, projects: [lock.projects[0]!, { ...blog, manifest: { ...blog.manifest!, pages: [{ path: "/post/", title: "A post", sha256: H, previous: "b".repeat(64) }] } }, lock.projects[2]!] };
  const { diagnostics } = await pageWith("[[blog:/post/]]", changed);
  const d = diagnostics.find((x) => x.id === "network.link-changed");
  assert.equal(d?.severity, "warning");
  assert.equal(d?.pos?.line, 4);
});

test("a public project cannot link to a hidden one; a hidden project may", async () => {
  const lock = lockOf();
  const { diagnostics } = await pageWith("[[internal:/]]", lock);
  assert.equal(diagnostics.find((d) => d.id === "network.link-hidden")?.severity, "error");

  const root = await networkSite("", lock, "internal");
  writeFileSync(join(root, "links.md"), "---\ntitle: Links\n---\n[[docs:/]]\n");
  const built = await buildModel(root);
  assert.deepEqual(built.diagnostics.filter((d) => d.id.startsWith("network.link")), []);
});

test("doctor counts broken and changed project links", async () => {
  const { doctor } = await import("../src/cli/doctor.ts");
  const root = await networkSite("", lockOf());
  writeFileSync(join(root, "links.md"), "---\ntitle: Links\n---\n[[blog:/nope/]] [[blog:/post/]]\n");
  const summary = (await doctor({ root })).find((d) => d.id === "doctor.network-summary");
  assert.equal(summary?.severity, "info");
  assert.match(summary?.message ?? "", /project links: 1 broken, 0 to a changed page/);
});
