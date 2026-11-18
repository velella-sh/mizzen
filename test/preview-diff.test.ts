// #843: a preview build may name the latest public build with `--baseline`; it then publishes the difference at
// `.mizzen/preview-diff.json`, names the baseline in `.mizzen/doctor.json`, and stays verifiable. No baseline means no
// diff, and the diff never enters the build hash it describes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { verify } from "../src/cli/verify.ts";
import type { SiteDiff } from "../src/diff/index.ts";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const DIFF = ".mizzen/preview-diff.json";
const REPORT = ".mizzen/doctor.json";

/** A theme with one layout, so a build needs nothing else. */
function theme(root: string): string {
  const dir = join(root, "theme");
  tree(dir, {
    "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body>${p.page.html}</body></html>`;\n',
  });
  return dir;
}

/** The build hash the folder's manifest records. */
function buildHash(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, ".mizzen/manifest.json"), "utf8")) as { build: { hash: string } }).build.hash;
}

test("a preview with a baseline publishes the diff against the public build", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-diff-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const publicDir = join(parent, "public");
    await build({ root: site, out: publicDir, themeRoot, defaultLayout: "doc" });
    const baselineHash = buildHash(publicDir);

    // One page changes and another appears, so the diff has a page and a file to name.
    tree(site, {
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello again\n",
      "new.md": "---\ntitle: New\nlayout: doc\n---\n\nNew page\n",
    });
    const previewDir = join(parent, "preview");
    const preview = { canonicalBase: "https://preview.example.com/", commit: "0123456789abcdef" };
    await build({ root: site, out: previewDir, themeRoot, defaultLayout: "doc", basePath: "/preview/pr-1", preview, baseline: publicDir });

    const text = readFileSync(join(previewDir, DIFF), "utf8");
    const report = JSON.parse(text) as { version: number; baseline: { hash: string }; diff: SiteDiff };
    assert.equal(report.version, 1);
    assert.equal(report.baseline.hash, baselineHash, "the report names the public build it compared");
    assert.deepEqual(report.diff.base, { hash: baselineHash });
    assert.equal(report.diff.head.hash, buildHash(previewDir), "the head hash is the preview's own build hash");
    assert.equal(report.diff.identical, false);

    // The preview's base path is not a move: the page is compared with the page it replaces at the public base.
    const changed = report.diff.pages.changed.find((page) => page.url === "/");
    assert.ok(changed, "the page that changed is reported at its public URL");
    assert.equal(changed.source, "index.md");
    assert.equal(changed.renderOnly, false, "a content edit is more than a render change");
    assert.ok(changed.changes.includes("text"), "the changed text is named");
    assert.deepEqual(
      report.diff.pages.added.map((page) => page.url),
      ["/new/"],
    );
    assert.ok(
      report.diff.files.changed.some((file) => file.name === "llms.txt"),
      "a site-wide file built from the pages is named",
    );

    const doctor = JSON.parse(readFileSync(join(previewDir, REPORT), "utf8")) as {
      preview: Record<string, string>;
      counts: Record<string, number>;
    };
    assert.equal(doctor.preview.baseline, baselineHash, "the diagnostics report names the baseline");
    assert.equal(doctor.preview.diff, DIFF, "and where the diff was written");
    assert.equal(doctor.counts.error, 0);

    const verified = await verify({ dir: previewDir });
    assert.equal(verified.ok, true, "the diff is not part of the build identity it describes");

    // The same input gives the same report in another folder.
    const againDir = join(parent, "again");
    await build({ root: site, out: againDir, themeRoot, defaultLayout: "doc", basePath: "/preview/pr-1", preview, baseline: publicDir });
    assert.equal(readFileSync(join(againDir, DIFF), "utf8"), text, "the diff is byte-identical across runs");
    assert.equal(buildHash(againDir), report.diff.head.hash, "and so is the build it names");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a preview without a baseline writes no diff", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-diff-none-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    await build({
      root: site,
      out,
      themeRoot,
      defaultLayout: "doc",
      basePath: "/preview/pr-1",
      preview: { canonicalBase: "https://preview.example.com/" },
    });

    assert.equal(existsSync(join(out, DIFF)), false, "a preview alone has nothing to compare");
    const doctor = JSON.parse(readFileSync(join(out, REPORT), "utf8")) as { preview: Record<string, string> };
    assert.equal("baseline" in doctor.preview, false, "and names no baseline");
    assert.equal("diff" in doctor.preview, false);
    assert.equal((await verify({ dir: out })).ok, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the CLI refuses --baseline without --preview-canonical", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-diff-cli-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const baseline = join(parent, "public");
    await build({ root: site, out: baseline, themeRoot, defaultLayout: "doc" });

    const errors: string[] = [];
    const io = { log: (_: string): void => {}, error: (message: string): void => void errors.push(message) };
    const code = await main(["build", site, "--theme", themeRoot, "--out", join(parent, "out"), "--baseline", baseline], io);
    assert.equal(code, 2, "a baseline alone is a usage error");
    assert.match(errors.join("\n"), /--baseline is only valid with --preview-canonical/);
    assert.equal(existsSync(join(parent, "out")), false, "and nothing is built");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
