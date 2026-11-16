/** Writes small built folders by hand for the site-diff tests: pages, Markdown twins, page JSON, and other files. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprint, hashOf, MANIFEST_PATH } from "../src/outputs/build-hash.ts";

export interface FixturePage {
  readonly url: string;
  readonly source?: string;
  readonly title?: string;
  readonly layout?: string | null;
  /** The page's Markdown: the twin and the source hash. */
  readonly md?: string;
  /** The page's HTML; defaults to a wrapper around `md`. */
  readonly html?: string;
  /** Page JSON written beside the HTML. */
  readonly json?: unknown;
  readonly view?: string;
}

export interface FixtureBuild {
  readonly pages?: readonly FixturePage[];
  /** Other files by path: assets, feeds, redirect stubs, the search index. */
  readonly files?: Readonly<Record<string, string>>;
}

export function htmlPath(url: string): string {
  return `${url.replace(/^\/|\/$/g, "")}${url === "/" ? "" : "/"}index.html`.replace(/^\//, "");
}

function put(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Writes the folder and its manifest, and returns the folder. */
export async function writeBuild(spec: FixtureBuild, dir = mkdtempSync(join(tmpdir(), "mizzen-diff-fixture-"))): Promise<string> {
  const entries = [];
  for (const page of spec.pages ?? []) {
    const html = htmlPath(page.url);
    const twin = html.replace(/\.html$/, ".md");
    const md = page.md ?? `# ${page.title ?? page.url}\n`;
    put(dir, html, page.html ?? `<html><body>${md}</body></html>`);
    put(dir, twin, md);
    const outputs = [html, twin];
    if (page.json !== undefined) put(dir, html.replace(/\.html$/, ".json"), `${JSON.stringify(page.json, null, 2)}\n`);
    entries.push({
      url: page.url,
      source: page.source ?? `${page.url.replace(/^\/|\/$/g, "") || "index"}.md`,
      title: page.title ?? page.url,
      layout: page.layout === undefined ? "doc" : page.layout,
      outputs,
      hashes: { source: hashOf(md), html: hashOf(page.html ?? `<html><body>${md}</body></html>`) },
      ...(page.view === undefined ? {} : { view: page.view }),
    });
  }
  for (const [path, content] of Object.entries(spec.files ?? {})) put(dir, path, content);
  const record = await fingerprint(dir);
  put(dir, MANIFEST_PATH, `${JSON.stringify({ build: record, pages: entries }, null, 2)}\n`);
  return dir;
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
