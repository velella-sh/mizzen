// #842: a preview build publishes its result at `.mizzen/doctor.json`, in the version 1 diagnostics report the doctor
// already prints; a normal build writes no such file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseDoctorReport } from "../src/edits/proof-verifier.ts";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

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

test("a preview build publishes its diagnostics at .mizzen/doctor.json", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-doctor-report-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
      "broken.md": "---\ntitle: Broken\nlayout: missing\n---\n\nBroken\n",
    });
    const out = join(parent, "out");

    const result = await build({
      root: site,
      out,
      themeRoot,
      defaultLayout: "doc",
      basePath: "/preview/pr-1",
      preview: { canonicalBase: "https://preview.example.com/", commit: "0123456789abcdef" },
    });

    const text = readFileSync(join(out, REPORT), "utf8");
    const report = JSON.parse(text) as {
      version: number;
      preview: Record<string, string>;
      counts: Record<string, number>;
      diagnostics: { id: string; severity: string; pos?: { file: string; line: number; column: number } }[];
    };
    assert.equal(report.version, 1);
    assert.deepEqual(report.preview, {
      base: "/preview/pr-1",
      canonicalBase: "https://preview.example.com/",
      commit: "0123456789abcdef",
    });
    assert.deepEqual(report.diagnostics, result.diagnostics, "the report holds the build's diagnostics");
    assert.deepEqual(report.counts, {
      error: result.diagnostics.filter((d) => d.severity === "error").length,
      warning: result.diagnostics.filter((d) => d.severity === "warning").length,
      info: result.diagnostics.filter((d) => d.severity === "info").length,
    });

    const badLayout = report.diagnostics.find((d) => d.id === "render.unknown-layout");
    assert.ok(badLayout, "the missing layout is reported");
    assert.equal(badLayout.pos?.file, "broken.md", "the finding keeps its source file");
    assert.equal(typeof badLayout.pos?.line, "number", "the finding keeps its line");
    assert.equal(typeof badLayout.pos?.column, "number", "the finding keeps its column");
    assert.deepEqual(
      parseDoctorReport(text).map((finding) => finding.id),
      report.diagnostics.map((finding) => finding.id),
      "the file is the version 1 diagnostics report CI already reads",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a clean preview has zero errors and the same report every time", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-doctor-clean-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\nurl: https://example.com\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const buildPreview = async (out: string): Promise<string> => {
      await build({
        root: site,
        out,
        themeRoot,
        defaultLayout: "doc",
        basePath: "/preview/pr-1",
        preview: { canonicalBase: "https://preview.example.com/" },
      });
      return readFileSync(join(out, REPORT), "utf8");
    };

    const first = await buildPreview(join(parent, "one"));
    const report = JSON.parse(first) as { counts: Record<string, number>; diagnostics: unknown[] };
    assert.equal(report.counts.error, 0, "a clean preview has zero errors");
    assert.deepEqual(report.diagnostics, []);
    assert.equal(first, await buildPreview(join(parent, "two")), "the same build writes the same report");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a warm cache still publishes the commit the build was made from", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-doctor-cache-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    const cacheDir = join(parent, "cache");
    const buildPreview = async (commit: string): Promise<string> => {
      await build({
        root: site,
        out,
        themeRoot,
        defaultLayout: "doc",
        basePath: "/preview/pr-1",
        preview: { canonicalBase: "https://preview.example.com/", commit },
        cache: true,
        cacheDir,
      });
      return readFileSync(join(out, REPORT), "utf8");
    };

    assert.equal((JSON.parse(await buildPreview("aaaa")) as { preview: { commit: string } }).preview.commit, "aaaa");
    // The entry holds the report, so a preview of another commit must not be answered by the one before it.
    const second = JSON.parse(await buildPreview("bbbb")) as { preview: { commit: string } };
    assert.equal(second.preview.commit, "bbbb");
    const again = JSON.parse(await buildPreview("bbbb")) as { preview: { commit: string } };
    assert.equal(again.preview.commit, "bbbb", "the same commit is served by its own entry");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a normal build writes no doctor report", async () => {
  const parent = mkdtempSync(join(tmpdir(), "normal-site-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Normal\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    await build({ root: site, out, themeRoot, defaultLayout: "doc", basePath: "/preview/pr-1" });
    assert.equal(existsSync(join(out, REPORT)), false, "a base alone does not make a preview");
    assert.ok(existsSync(join(out, ".mizzen/manifest.json")), "the rest of the output is unchanged");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
