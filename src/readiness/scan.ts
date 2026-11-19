import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { SourcePos } from "../contracts/source.ts";
import type {
  ReadinessBuild,
  ReadinessDimension,
  ReadinessEvaluation,
  ReadinessFinding,
  ReadinessStatus,
} from "../contracts/readiness.ts";
import { readBuild, type Build, type BuildPage } from "../diff/builds.ts";
import { fingerprint, isIdentityFile, isIdentityPath, UnsupportedEntryError } from "../outputs/build-hash.ts";
import { siteScope, pageScope, finding, compareFindings, type FindingInput } from "./findings.ts";
import { RUBRIC, type RubricRule } from "./rubric.ts";

/** One rule's result and the findings that explain it. */
export interface RuleOutcome {
  /** Stable rule code. */
  readonly code: string;
  /** The rule's status for this build. */
  readonly status: ReadinessStatus;
  /** Why the rule is unknown, when it is. */
  readonly reason?: string;
  /** Findings for a failed rule, sorted; empty for a pass or an unknown. */
  readonly findings: readonly ReadinessFinding[];
}

/** What one scan of a built folder found. */
export interface ScanResult {
  /** The folder that was scanned; never copied into a report. */
  readonly built: string;
  /** The manifest facts, with a zero hash when the manifest is unreadable. */
  readonly build: ReadinessBuild;
  /** One outcome per rubric rule, in rubric order. */
  readonly outcomes: readonly RuleOutcome[];
  /** Every finding, sorted. */
  readonly findings: readonly ReadinessFinding[];
}

/** Options of {@link scanBuild}. */
export interface ScanOptions {
  /** An evaluation report, already checked by its adapter. Absent leaves `examples.evaluation` unknown. */
  readonly evaluations?: ReadinessEvaluation;
}

const ZERO_HASH = "0".repeat(64);
const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Collects one result per rule and keeps the first failure per rule deterministic. */
class Outcomes {
  readonly #byCode = new Map<string, { status: ReadinessStatus; reason?: string; findings: ReadinessFinding[] }>();

  pass(code: string): void {
    this.#byCode.set(code, { status: "pass", findings: [] });
  }

  fail(code: string, ...findings: readonly ReadinessFinding[]): void {
    const current = this.#byCode.get(code);
    const all = [...(current?.findings ?? []), ...findings];
    this.#byCode.set(code, { status: "fail", findings: all });
  }

  unknown(code: string, reason: string): void {
    if (this.#byCode.has(code)) return;
    this.#byCode.set(code, { status: "unknown", reason, findings: [] });
  }

  /** Rules in rubric order; a rule nobody touched is unknown, never a pass. */
  result(): RuleOutcome[] {
    return RUBRIC.rules.map((rule) => {
      const entry = this.#byCode.get(rule.code);
      if (entry === undefined) return { code: rule.code, status: "unknown", reason: "The rule was not evaluated.", findings: [] };
      return {
        code: rule.code,
        status: entry.status,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        findings: [...entry.findings].sort(compareFindings),
      };
    });
  }
}

/** A rule's finding builder, with the rule's scope defaults. */
function report(
  outcomes: Outcomes,
  rule: RubricRule,
  input: FindingInput,
): void {
  outcomes.fail(rule.code, finding(rule, input));
}

/** Reads one JSON file, keeping "missing" apart from "malformed". */
async function readJson(dir: string, path: string): Promise<{ readonly value: unknown } | { readonly reason: string }> {
  let text: string;
  try {
    text = await readFile(resolve(dir, path), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { reason: code === "ENOENT" || code === "EISDIR" ? `missing ${path}` : `unreadable ${path}` };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { reason: `${path} is not valid JSON` };
  }
}

/** Reads a built text file, or `undefined` when it is missing or unreadable. */
async function readText(dir: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(dir, path), "utf8");
  } catch {
    return undefined;
  }
}

/** A `/`-separated path with the site base removed. */
function underBase(path: string, base: string): string {
  if (base === "") return path;
  if (path === base) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

/** The JSON twin's path for a page URL, relative to the output folder. */
function jsonPath(url: string, base: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return underBase(`${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".json")}`, base).replace(/^\//, "");
  if (last.includes(".")) return undefined;
  return underBase(`${url.endsWith("/") ? url : `${url}/`}index.json`, base).replace(/^\//, "");
}

/** The Markdown twin's path for a page URL, relative to the output folder. */
function twinPath(url: string, base: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return underBase(`${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".md")}`, base).replace(/^\//, "");
  if (last.includes(".")) return undefined;
  return underBase(`${url.endsWith("/") ? url : `${url}/`}index.md`, base).replace(/^\//, "");
}

/** The built file a link path names, or `undefined` when no file answers it. */
function outputFor(path: string, files: ReadonlySet<string>): string | undefined {
  let clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // A malformed escape stays as written; it will not answer a file.
  }
  if (clean === "" || clean.endsWith("/")) {
    const index = `${clean}index.html`;
    return files.has(index) ? index : undefined;
  }
  if (files.has(clean)) return clean;
  if (!clean.slice(clean.lastIndexOf("/") + 1).includes(".")) {
    if (files.has(`${clean}/index.html`)) return `${clean}/index.html`;
    if (files.has(`${clean}.html`)) return `${clean}.html`;
  }
  return undefined;
}

/** Every `href="…"` value in a built HTML file, deduplicated in document order. */
function hrefsOf(html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
    const href = match[1] ?? "";
    if (seen.has(href)) continue;
    seen.add(href);
    found.push(href);
  }
  return found;
}

/** Every Markdown link target in `llms.txt`, in document order. */
function markdownLinksOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (target !== undefined) found.push(target);
  }
  return found;
}

/** The site path a link names, or `undefined` for a link that leaves the site. */
function sitePathOf(target: string): string | undefined {
  if (target.startsWith("#") || target.startsWith("?") || target.startsWith("//")) return undefined;
  if (/^(?:mailto|tel|data|javascript|blob):/i.test(target)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    try {
      return new URL(target).pathname;
    } catch {
      return undefined;
    }
  }
  return target.split("#")[0]?.split("?")[0];
}

/** A source span is usable: relative file, positive integers, and an end at or after the start. */
function spanReason(file: string, line: unknown, column: unknown, endLine: unknown, endColumn: unknown): string | undefined {
  if (!isIdentityPath(file)) return `source file "${file}" is not a safe relative path`;
  if (!isInt(line) || !isInt(column) || !isInt(endLine) || !isInt(endColumn)) return `span of ${file} has no positive line and column`;
  if (endLine < line) return `span of ${file} ends before it starts`;
  if (endLine === line && endColumn < column) return `span of ${file} ends before it starts`;
  return undefined;
}

/** A span for a finding, when every number is present. */
function spanOf(file: string, line: unknown, column: unknown, endLine: unknown, endColumn: unknown): SourcePos | undefined {
  if (!isString(file) || !isInt(line) || !isInt(column) || !isInt(endLine) || !isInt(endColumn)) return undefined;
  return { file, line, column, endLine, endColumn };
}

/** The number of opening code fences whose info string is empty. */
function unlabeledFences(markdown: string): number {
  let open: { readonly char: string; readonly length: number } | undefined;
  let count = 0;
  for (const line of markdown.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (open === undefined) {
      if (info === "") count++;
      open = { char: marker[0] ?? "`", length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length && info === "") {
      open = undefined;
    }
  }
  return count;
}

/** Validates `sourcemap.json`, returning pages by URL and the findings that make it unusable in part. */
interface MapBlock {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface MapPage {
  readonly url: string;
  readonly source: string;
  readonly sections: readonly { readonly id: string }[];
  readonly blocks: readonly MapBlock[];
}

function sourcemapPages(value: unknown): { readonly pages: readonly MapPage[] } | { readonly reason: string } {
  if (!isRecord(value) || value.version !== 0 || !Array.isArray(value.pages)) return { reason: "sourcemap.json is not version 0" };
  const pages: MapPage[] = [];
  for (const entry of value.pages) {
    if (!isRecord(entry) || !isString(entry.url) || !isString(entry.source)) return { reason: "sourcemap.json has a page without a URL or source" };
    const sections = Array.isArray(entry.sections) ? entry.sections : [];
    const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
    const parsedSections: { id: string }[] = [];
    for (const section of sections) {
      if (!isRecord(section) || !isString(section.id)) return { reason: "sourcemap.json has a section without an id" };
      const reason = spanReason(entry.source, section.line, section.column, section.endLine, section.endColumn);
      if (reason !== undefined) return { reason };
      parsedSections.push({ id: section.id });
    }
    const parsedBlocks: MapBlock[] = [];
    for (const block of blocks) {
      if (!isRecord(block) || !isString(block.id) || !BLOCK_ID.test(block.id)) return { reason: "sourcemap.json has an invalid block id" };
      const reason = spanReason(entry.source, block.line, block.column, block.endLine, block.endColumn);
      if (reason !== undefined) return { reason };
      parsedBlocks.push({
        id: block.id,
        file: entry.source,
        line: block.line as number,
        column: block.column as number,
        endLine: block.endLine as number,
        endColumn: block.endColumn as number,
      });
    }
    pages.push({ url: entry.url, source: entry.source, sections: parsedSections, blocks: parsedBlocks });
  }
  return { pages };
}

/**
 * Scans one built folder against the public rubric. Every fact comes from the build's own files: the manifest, its
 * hash, `sourcemap.json`, `blocks.json`, the Markdown and JSON twins, `llms.txt`, `AGENTS.md`, packs, examples, trust,
 * review coverage, and the rendered HTML. A file that merely exists passes nothing on its own: its content must agree
 * with the manifest and the other artifacts.
 */
export async function scanBuild(built: string, options: ScanOptions = {}): Promise<ScanResult> {
  const dir = resolve(built);
  const outcomes = new Outcomes();
  const raw = await readJson(dir, ".mizzen/manifest.json");
  let build: Build | undefined;
  let base = "";
  let asOf: string | undefined;
  let hasManifest = false;
  const manifestRule = RUBRIC.rules.find((rule) => rule.code === "structure.manifest")!;

  if ("reason" in raw) {
    report(outcomes, manifestRule, { scope: siteScope(), message: "The build has no readable manifest.", evidence: raw.reason });
  } else if (!isRecord(raw.value)) {
    report(outcomes, manifestRule, { scope: siteScope(), message: "The manifest is not a JSON object.", evidence: "manifest.json is not an object" });
  } else {
    base = isString(raw.value.base) ? raw.value.base : "";
    asOf = isString(raw.value.asOf) ? raw.value.asOf : undefined;
    try {
      build = await readBuild(dir, dir);
      hasManifest = true;
    } catch (error) {
      report(outcomes, manifestRule, {
        scope: siteScope(),
        message: "The build's manifest is malformed.",
        evidence: error instanceof Error ? error.message.replace(/^"+|"+$/g, "") : "manifest is malformed",
      });
    }
  }

  const files = new Set(Object.keys(build?.files ?? {}));
  const pages = build?.pages ?? [];
  const pageByUrl = new Map(pages.map((page) => [page.url, page]));

  if (build !== undefined) {
    const bad = pages.find((page) => !isIdentityPath(page.source) || page.outputs.length === 0 || page.outputs.some((path) => !isIdentityFile(path)));
    if (bad !== undefined) {
      report(outcomes, manifestRule, {
        scope: pageScope(bad.url),
        message: "A page entry names no safe relative source file or output.",
        evidence: `source ${JSON.stringify(bad.source)}, ${bad.outputs.length} output(s)`,
      });
    } else {
      outcomes.pass("structure.manifest");
    }
    const badHash = pages.find((page) => !/^[0-9a-f]{64}$/.test(page.hashes.source) || !/^[0-9a-f]{64}$/.test(page.hashes.html));
    if (badHash !== undefined) {
      report(outcomes, manifestRule, {
        scope: pageScope(badHash.url),
        message: "A page entry carries a hash that is not a SHA-256.",
        evidence: "hashes.source or hashes.html is not 64 lowercase hex characters",
      });
    }
  } else {
    outcomes.unknown("structure.markdown", "the manifest is not readable");
  }

  const needManifest = (code: string): boolean => {
    if (build !== undefined) return true;
    outcomes.unknown(code, "the manifest is not readable");
    return false;
  };

  // Markdown twins: every rendered page has a non-empty twin listed in its own outputs.
  if (build !== undefined) {
    let failed = 0;
    for (const page of pages) {
      if (!page.outputs.some((path) => path.endsWith(".html"))) continue;
      const twin = twinPath(page.url, base);
      if (twin === undefined) continue;
      if (!files.has(twin) || !page.outputs.includes(twin)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.markdown")!, {
          scope: pageScope(page.url),
          message: "A rendered page has no Markdown twin.",
          evidence: `missing ${twin} for ${page.source}`,
        });
        continue;
      }
      const text = await readText(dir, twin);
      if (text === undefined || text.trim() === "") {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.markdown")!, {
          scope: pageScope(page.url),
          message: "A page's Markdown twin is empty.",
          evidence: `${twin} is empty`,
        });
      }
    }
    if (failed === 0) outcomes.pass("structure.markdown");
  } else {
    outcomes.unknown("structure.markdown", "the manifest is not readable");
  }

  // Source map: one entry per page, every span real.
  let map: readonly MapPage[] | undefined;
  if (needManifest("structure.sourcemap")) {
    const parsed = await readJson(dir, "sourcemap.json");
    if ("reason" in parsed) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.sourcemap")!, {
        scope: siteScope(),
        message: "The build has no readable source map.",
        evidence: parsed.reason,
      });
    } else {
      const checked = sourcemapPages(parsed.value);
      if ("reason" in checked) {
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.sourcemap")!, {
          scope: siteScope(),
          message: "The source map is malformed.",
          evidence: checked.reason,
        });
      } else {
        map = checked.pages;
        const mapByUrl = new Map(map.map((entry) => [entry.url, entry]));
        let failed = 0;
        for (const page of pages) {
          const entry = mapByUrl.get(page.url);
          if (entry === undefined) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.sourcemap")!, {
              scope: pageScope(page.url),
              message: "A page has no source map entry.",
              evidence: `sourcemap.json has no entry for ${page.source}`,
            });
          } else if (entry.source !== page.source) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.sourcemap")!, {
              scope: pageScope(page.url),
              message: "A source map entry names another source file.",
              evidence: `sourcemap ${entry.source} does not match manifest ${page.source}`,
            });
          }
        }
        for (const entry of map) {
          if (!pageByUrl.has(entry.url)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.sourcemap")!, {
              scope: pageScope(entry.url),
              message: "The source map names a page the build does not contain.",
              evidence: `sourcemap entry ${entry.source} has no manifest page`,
            });
          }
        }
        if (failed === 0) outcomes.pass("structure.sourcemap");
      }
    }
  }

  // Block ids: unique across the site, and unique heading anchors within a page.
  if (needManifest("structure.ids")) {
    if (map === undefined) {
      outcomes.unknown("structure.ids", "sourcemap.json is not readable");
    } else {
      const seen = new Map<string, string>();
      let failed = 0;
      for (const page of map) {
        const anchors = new Set<string>();
        for (const section of page.sections) {
          if (anchors.has(section.id)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.ids")!, {
              scope: pageScope(page.url),
              message: "A heading anchor repeats within one page.",
              evidence: `section ${section.id} repeats in ${page.source}`,
            });
          }
          anchors.add(section.id);
        }
        for (const block of page.blocks) {
          const owner = seen.get(block.id);
          if (owner !== undefined) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.ids")!, {
              scope: pageScope(page.url, block.id),
              message: "A block id is used by more than one page.",
              evidence: `${block.id} is also on ${owner}`,
            });
          } else {
            seen.set(block.id, page.url);
          }
        }
      }
      if (failed === 0) outcomes.pass("structure.ids");
    }
  }

  // blocks.json: every recorded id names a page, and the HTML uses exactly those ids.
  if (needManifest("structure.blocks")) {
    const parsed = await readJson(dir, "blocks.json");
    if ("reason" in parsed) {
      outcomes.unknown("structure.blocks", "the site records no stable block ids");
    } else if (!isRecord(parsed.value) || parsed.value.version !== 1 || !isRecord(parsed.value.blocks)) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
        scope: siteScope(),
        message: "blocks.json is malformed.",
        evidence: "blocks.json is not version 1 with a blocks object",
      });
    } else {
      const byUrl = new Map<string, Set<string>>();
      let failed = 0;
      for (const id of Object.keys(parsed.value.blocks).sort()) {
        const entry = (parsed.value.blocks as Record<string, unknown>)[id];
        if (!BLOCK_ID.test(id) || !isRecord(entry) || !isString(entry.url) || !isString(entry.file) || !isInt(entry.line)) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
            scope: siteScope(),
            message: "A recorded block id is malformed.",
            evidence: `blocks.json entry ${JSON.stringify(id)} is incomplete`,
          });
          continue;
        }
        const page = pageByUrl.get(entry.url);
        if (page === undefined || page.source !== entry.file) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
            scope: pageScope(entry.url, id),
            message: "A recorded block names a page or source the build does not contain.",
            evidence: `${id} names ${entry.file} on ${entry.url}`,
          });
          continue;
        }
        const set = byUrl.get(entry.url) ?? new Set<string>();
        set.add(id);
        byUrl.set(entry.url, set);
        const mapEntry = map?.find((candidate) => candidate.url === entry.url);
        if (mapEntry !== undefined && !mapEntry.blocks.some((block) => block.id === id)) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
            scope: pageScope(entry.url, id),
            message: "blocks.json and the source map disagree about a block id.",
            evidence: `${id} is absent from sourcemap.json for ${entry.url}`,
          });
        }
      }
      for (const page of pages) {
        const html = page.outputs.find((path) => path.endsWith(".html"));
        if (html === undefined) continue;
        const text = await readText(dir, html);
        if (text === undefined) continue;
        const inHtml = new Set([...text.matchAll(/\sdata-block="([^"]*)"/g)].map((match) => match[1] ?? ""));
        const recorded = byUrl.get(page.url) ?? new Set<string>();
        for (const id of inHtml) {
          if (!recorded.has(id)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
              scope: pageScope(page.url, id),
              message: "Rendered HTML uses a block id the build did not record.",
              evidence: `${id} is in ${html} but not blocks.json`,
            });
          }
        }
        for (const id of recorded) {
          if (!inHtml.has(id)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "structure.blocks")!, {
              scope: pageScope(page.url, id),
              message: "A recorded block id does not appear in the page HTML.",
              evidence: `${id} is in blocks.json but not ${html}`,
            });
          }
        }
      }
      if (failed === 0) outcomes.pass("structure.blocks");
    }
  }

  // llms.txt: every link resolves, and every page's Markdown twin is reachable.
  if (needManifest("navigation.llms")) {
    const text = await readText(dir, "llms.txt");
    if (text === undefined || text.trim() === "") {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.llms")!, {
        scope: siteScope(),
        message: "The build has no readable llms.txt.",
        evidence: "llms.txt is missing or empty",
      });
    } else {
      const linked = new Set<string>();
      let failed = 0;
      for (const target of markdownLinksOf(text)) {
        const path = sitePathOf(target);
        if (path === undefined) continue;
        const builtPath = outputFor(underBase(path, base), files);
        if (builtPath === undefined) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.llms")!, {
            scope: siteScope(),
            message: "llms.txt links to a path the build does not contain.",
            evidence: `unresolved ${target}`,
          });
        } else {
          linked.add(builtPath);
        }
      }
      for (const page of pages) {
        const twin = twinPath(page.url, base);
        if (twin === undefined || !files.has(twin)) continue;
        if (![...linked].includes(twin)) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.llms")!, {
            scope: pageScope(page.url),
            message: "llms.txt does not list a page's Markdown twin.",
            evidence: `${twin} is absent from llms.txt`,
          });
        }
      }
      if (failed === 0) outcomes.pass("navigation.llms");
    }
  }

  // Rendered links: every internal href names a built file.
  if (needManifest("navigation.links")) {
    let failed = 0;
    for (const page of pages) {
      const htmlPath = page.outputs.find((path) => path.endsWith(".html"));
      if (htmlPath === undefined) continue;
      const html = await readText(dir, htmlPath);
      if (html === undefined) continue;
      const pageDir = page.url.slice(0, page.url.lastIndexOf("/") + 1);
      for (const href of hrefsOf(html)) {
        const path = sitePathOf(href);
        if (path === undefined) continue;
        const absolute = path.startsWith("/") ? underBase(path, base) : underBase(posix.normalize(posix.join(pageDir, path)), base);
        if (outputFor(absolute, files) === undefined) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.links")!, {
            scope: pageScope(page.url),
            message: "A page links to a path the build does not contain.",
            evidence: `unresolved ${href} in ${htmlPath}`,
          });
        }
      }
    }
    if (failed === 0) outcomes.pass("navigation.links");
  }

  // AGENTS.md: present, with the build's page count.
  if (needManifest("navigation.agents")) {
    const text = await readText(dir, "AGENTS.md");
    if (text === undefined || text.trim() === "") {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.agents")!, {
        scope: siteScope(),
        message: "The build has no readable AGENTS.md.",
        evidence: "AGENTS.md is missing or empty",
      });
    } else {
      const count = /Pages in this build:\s*(\d+)/.exec(text);
      if (count === null || !text.includes("## Pages")) {
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.agents")!, {
          scope: siteScope(),
          message: "AGENTS.md does not describe the build's pages.",
          evidence: "AGENTS.md has no Pages section with a page count",
        });
      } else if (Number(count[1]) !== pages.length) {
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "navigation.agents")!, {
          scope: siteScope(),
          message: "AGENTS.md names another number of pages than the build.",
          evidence: `AGENTS.md says ${count[1]}, manifest has ${pages.length}`,
        });
      } else {
        outcomes.pass("navigation.agents");
      }
    }
  }

  // Page JSON: every page has one, and it names the page and its source.
  const pageJson = new Map<string, Record<string, unknown>>();
  if (needManifest("context.page-json")) {
    let failed = 0;
    for (const page of pages) {
      const path = jsonPath(page.url, base);
      if (path === undefined || !files.has(path)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.page-json")!, {
          scope: pageScope(page.url),
          message: "A page has no JSON twin.",
          evidence: `missing ${path ?? "JSON twin"}`,
        });
        continue;
      }
      const parsed = await readJson(dir, path);
      if ("reason" in parsed || !isRecord(parsed.value)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.page-json")!, {
          scope: pageScope(page.url),
          message: "A page's JSON twin is malformed.",
          evidence: "reason" in parsed ? parsed.reason : `${path} is not an object`,
        });
        continue;
      }
      if (parsed.value.url !== page.url || parsed.value.source !== page.source) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.page-json")!, {
          scope: pageScope(page.url),
          message: "A page's JSON twin names another page or source.",
          evidence: `${path} has url ${JSON.stringify(parsed.value.url)} and source ${JSON.stringify(parsed.value.source)}`,
        });
        continue;
      }
      pageJson.set(page.url, parsed.value);
    }
    if (failed === 0) outcomes.pass("context.page-json");
  }

  // Agent instructions: parse, name a page, and say where to edit.
  const agentFiles = [...files].filter((path) => path === "agent.json" || path.endsWith("/agent.json") || path.endsWith(".agent.json")).sort();
  if (needManifest("context.agent-json")) {
    if (agentFiles.length === 0) {
      outcomes.unknown("context.agent-json", "no page declares an agent block");
    } else {
      let failed = 0;
      for (const path of agentFiles) {
        const parsed = await readJson(dir, path);
        if ("reason" in parsed || !isRecord(parsed.value)) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.agent-json")!, {
            scope: siteScope(),
            message: "An agent instruction file is malformed.",
            evidence: "reason" in parsed ? parsed.reason : `${path} is not an object`,
          });
          continue;
        }
        const url = parsed.value.url;
        const page = isString(url) ? pageByUrl.get(url) : undefined;
        if (page === undefined || parsed.value.source !== page.source) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.agent-json")!, {
            scope: isString(url) ? pageScope(url) : siteScope(),
            message: "An agent instruction file names no page of this build.",
            evidence: `${path} names ${JSON.stringify(url)}`,
          });
          continue;
        }
        const agent = parsed.value.agent;
        if (!isRecord(agent) || (!isString(agent.source) && !isString(agent.notes))) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.agent-json")!, {
            scope: pageScope(page.url),
            message: "An agent block says nothing an agent can act on.",
            evidence: `${path} has no agent.source or agent.notes`,
          });
        }
      }
      if (failed === 0) outcomes.pass("context.agent-json");
    }
  }

  // Packs: every structured pack names known pages and a span per item.
  const packFiles = [...files].filter((path) => path.startsWith("pack/") && path.endsWith(".json")).sort();
  if (needManifest("context.packs")) {
    if (packFiles.length === 0) {
      outcomes.unknown("context.packs", "the site configures no context packs");
    } else {
      let failed = 0;
      const packBuilds = new Set<string>();
      for (const path of packFiles) {
        const parsed = await readJson(dir, path);
        if ("reason" in parsed || !isRecord(parsed.value) || parsed.value.version !== 1 || !Array.isArray(parsed.value.items)) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.packs")!, {
            scope: siteScope(),
            message: "A context pack is malformed.",
            evidence: "reason" in parsed ? parsed.reason : `${path} is not version 1 with items`,
          });
          continue;
        }
        const buildId = isRecord(parsed.value.build) && isString(parsed.value.build.id) ? parsed.value.build.id : undefined;
        if (buildId !== undefined) packBuilds.add(buildId);
        for (const item of parsed.value.items) {
          if (!isRecord(item) || !isString(item.url) || !pageByUrl.has(item.url)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.packs")!, {
              scope: isRecord(item) && isString(item.url) ? pageScope(item.url) : siteScope(),
              message: "A context pack selects a page the build does not contain.",
              evidence: `${path} selects ${JSON.stringify(isRecord(item) ? item.url : undefined)}`,
            });
            continue;
          }
          const origin = item.origin;
          if (!isRecord(origin) || !isString(origin.source) || !isString(origin.span)) {
            failed++;
            report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.packs")!, {
              scope: pageScope(item.url),
              message: "A context pack item has no source span.",
              evidence: `${path} item ${item.url}`,
            });
          }
        }
        if (!files.has(path.replace(/\.json$/, ".md"))) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.packs")!, {
            scope: siteScope(),
            message: "A context pack has no Markdown twin.",
            evidence: `${path} has no matching .md`,
          });
        }
      }
      if (packBuilds.size > 1) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "context.packs")!, {
          scope: siteScope(),
          message: "Context packs disagree about which build they came from.",
          evidence: `${packBuilds.size} build ids across pack/*.json`,
        });
      }
      if (failed === 0) outcomes.pass("context.packs");
    }
  }

  // Examples: labelled fences, a complete report, and a matching evaluation suite.
  if (needManifest("examples.fences")) {
    let fences = 0;
    let unlabeled = 0;
    for (const page of pages) {
      const twin = twinPath(page.url, base);
      if (twin === undefined) continue;
      const text = await readText(dir, twin);
      if (text === undefined) continue;
      const count = unlabeledFences(text);
      unlabeled += count;
      if (count > 0) {
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "examples.fences")!, {
          scope: pageScope(page.url),
          message: "A code fence declares no language.",
          evidence: `${count} unlabeled fence(s) in ${twin}`,
        });
      }
      fences += (text.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length;
    }
    if (unlabeled > 0) {
      // Findings already explain the failure.
    } else if (fences === 0) {
      outcomes.unknown("examples.fences", "the build has no code fences");
    } else {
      outcomes.pass("examples.fences");
    }
  }

  if (needManifest("examples.report")) {
    const parsed = await readJson(dir, "examples.json");
    if ("reason" in parsed) {
      outcomes.unknown("examples.report", "the examples report is not in this build");
    } else if (!isRecord(parsed.value) || !Array.isArray(parsed.value.pages)) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "examples.report")!, {
        scope: siteScope(),
        message: "examples.json is malformed.",
        evidence: "examples.json has no pages array",
      });
    } else {
      const byUrl = new Map<string, Record<string, unknown>>();
      for (const entry of parsed.value.pages) {
        if (isRecord(entry) && isString(entry.url)) byUrl.set(entry.url, entry);
      }
      let failed = 0;
      for (const page of pages) {
        const entry = byUrl.get(page.url);
        if (entry === undefined) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "examples.report")!, {
            scope: pageScope(page.url),
            message: "The examples report omits a page.",
            evidence: `no examples entry for ${page.url}`,
          });
          continue;
        }
        if (typeof entry.failed === "number" && entry.failed > 0) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "examples.report")!, {
            scope: pageScope(page.url),
            message: "A page has a failing example.",
            evidence: `${entry.failed} failed example(s) for ${page.url}`,
          });
        }
      }
      if (failed === 0) outcomes.pass("examples.report");
    }
  }

  if (needManifest("examples.evaluation")) {
    const evaluations = options.evaluations;
    if (evaluations === undefined) {
      outcomes.unknown("examples.evaluation", "no evaluation report was supplied");
    } else if (evaluations.suite !== RUBRIC.evaluation.suite || evaluations.version !== RUBRIC.evaluation.version) {
      outcomes.unknown(
        "examples.evaluation",
        `suite ${evaluations.suite} ${evaluations.version} does not match the rubric's ${RUBRIC.evaluation.suite} ${RUBRIC.evaluation.version}`,
      );
    } else if (build === undefined || evaluations.snapshot !== build.hash) {
      outcomes.unknown("examples.evaluation", "the evaluation snapshot is not this build hash");
    } else {
      const result = evaluations.results["examples.evaluation"];
      if (result === undefined) {
        outcomes.unknown("examples.evaluation", "the evaluation report has no result for this rule");
      } else if (result === "pass") {
        outcomes.pass("examples.evaluation");
      } else {
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "examples.evaluation")!, {
          scope: siteScope(),
          message: "The evaluation suite did not pass this build.",
          evidence: `suite ${evaluations.suite} ${evaluations.version} failed on snapshot ${evaluations.snapshot}`,
        });
      }
    }
  }

  // Verification: the artifact is the recorded build, and trust names the same pages.
  if (needManifest("verification.digest")) {
    try {
      const actual = await fingerprint(dir, asOf);
      if (actual.hash === build!.hash) {
        outcomes.pass("verification.digest");
      } else {
        const expected = build!.files;
        const names = new Set([...Object.keys(expected), ...Object.keys(actual.files)]);
        const first = [...names].sort().find((path) => expected[path] !== actual.files[path]);
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "verification.digest")!, {
          scope: siteScope(),
          message: "The built folder does not hash to its manifest's build hash.",
          evidence: first === undefined ? "build hashes differ" : first in expected ? `${first} changed or is missing` : `${first} is not in the manifest`,
        });
      }
    } catch (error) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "verification.digest")!, {
        scope: siteScope(),
        message: "The built folder cannot be hashed.",
        evidence: error instanceof UnsupportedEntryError ? `${error.path} is a ${error.entry} entry` : "the folder is unreadable",
      });
    }
  }

  if (needManifest("verification.trust")) {
    const parsed = await readJson(dir, "trust.json");
    if ("reason" in parsed) {
      outcomes.unknown("verification.trust", "the trust report is not in this build");
    } else if (!isRecord(parsed.value) || parsed.value.version !== 2 || !isRecord(parsed.value.build) || !isRecord(parsed.value.pages)) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "verification.trust")!, {
        scope: siteScope(),
        message: "trust.json is malformed.",
        evidence: "trust.json is not version 2 with build and pages",
      });
    } else {
      const trustPages = parsed.value.pages;
      let failed = 0;
      if (parsed.value.build.pages !== pages.length || !isString(parsed.value.build.id) || !/^[0-9a-f]{64}$/.test(parsed.value.build.id)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "verification.trust")!, {
          scope: siteScope(),
          message: "trust.json names another build shape.",
          evidence: `trust build has ${String(parsed.value.build.pages)} page(s); manifest has ${pages.length}`,
        });
      }
      for (const page of pages) {
        const entry = trustPages[page.url];
        if (!isRecord(entry) || entry.source !== page.source) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "verification.trust")!, {
            scope: pageScope(page.url),
            message: "trust.json does not name a page's source.",
            evidence: `no trust entry for ${page.source} on ${page.url}`,
          });
        }
      }
      if (failed === 0) outcomes.pass("verification.trust");
    }
  }

  // Permissions: every page names a safe edit target, and generated pages point at their source.
  if (needManifest("permissions.edit-target")) {
    let failed = 0;
    for (const page of pages) {
      const entry = pageJson.get(page.url);
      if (entry === undefined || !isString(entry.source) || !isIdentityPath(entry.source)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "permissions.edit-target")!, {
          scope: pageScope(page.url),
          message: "A page does not name a safe source file for an agent to edit.",
          evidence: entry === undefined ? `no page JSON for ${page.url}` : `source ${JSON.stringify(entry.source)}`,
        });
      }
    }
    for (const path of agentFiles) {
      const parsed = await readJson(dir, path);
      if ("reason" in parsed || !isRecord(parsed.value) || !isRecord(parsed.value.agent)) continue;
      const source = parsed.value.agent.source;
      if (source !== undefined && (!isString(source) || !isIdentityPath(source))) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "permissions.edit-target")!, {
          scope: isString(parsed.value.url) ? pageScope(parsed.value.url) : siteScope(),
          message: "An agent block names an unsafe edit target.",
          evidence: `${path} source ${JSON.stringify(source)}`,
        });
      }
    }
    if (failed === 0) outcomes.pass("permissions.edit-target");
  }

  if (needManifest("permissions.generated")) {
    let failed = 0;
    let generated = 0;
    for (const path of agentFiles) {
      const parsed = await readJson(dir, path);
      if ("reason" in parsed || !isRecord(parsed.value) || !isRecord(parsed.value.agent)) continue;
      const agent = parsed.value.agent;
      if (agent.edit !== false) continue;
      generated++;
      const url = isString(parsed.value.url) ? parsed.value.url : undefined;
      if (!isString(agent.source) || !isIdentityPath(agent.source) || (url !== undefined && pageByUrl.get(url)?.source === agent.source)) {
        failed++;
        report(outcomes, RUBRIC.rules.find((rule) => rule.code === "permissions.generated")!, {
          scope: url === undefined ? siteScope() : pageScope(url),
          message: "A generated page does not name the file an agent should edit instead.",
          evidence: `${path} has edit false`,
        });
      }
    }
    if (failed === 0) outcomes.pass("permissions.generated");
    if (generated === 0 && failed === 0) {
      outcomes.pass("permissions.generated");
    }
  }

  // Maintenance: coverage and review state.
  let coverage: Record<string, Record<string, unknown>> | undefined;
  if (needManifest("maintenance.review")) {
    const parsed = await readJson(dir, "review-coverage.json");
    if ("reason" in parsed) {
      outcomes.unknown("maintenance.review", "the review coverage report is not in this build");
    } else if (!isRecord(parsed.value) || parsed.value.version !== 1 || !isRecord(parsed.value.pages)) {
      report(outcomes, RUBRIC.rules.find((rule) => rule.code === "maintenance.review")!, {
        scope: siteScope(),
        message: "review-coverage.json is malformed.",
        evidence: "review-coverage.json is not version 1 with pages",
      });
    } else {
      const entries: Record<string, Record<string, unknown>> = {};
      let failed = 0;
      for (const page of pages) {
        const entry = parsed.value.pages[page.url];
        if (!isRecord(entry) || entry.source !== page.source) {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "maintenance.review")!, {
            scope: pageScope(page.url),
            message: "The review report omits a page or names another source.",
            evidence: `no review entry for ${page.source} on ${page.url}`,
          });
        } else {
          entries[page.url] = entry;
        }
      }
      coverage = entries;
      if (failed === 0) outcomes.pass("maintenance.review");
    }
  }

  if (needManifest("maintenance.state")) {
    if (coverage === undefined) {
      outcomes.unknown("maintenance.state", "review coverage is not readable");
    } else {
      let failed = 0;
      let unknown = 0;
      for (const page of pages) {
        const state = coverage[page.url]?.state;
        if (state === "satisfied") continue;
        if (state === "overdue" || state === "insufficient" || state === "untracked") {
          failed++;
          report(outcomes, RUBRIC.rules.find((rule) => rule.code === "maintenance.state")!, {
            scope: pageScope(page.url),
            message: "A page is due for review.",
            evidence: `review state ${String(state)} for ${page.url}`,
          });
        } else {
          unknown++;
        }
      }
      if (failed > 0) {
        // Findings explain the failure.
      } else if (unknown > 0) {
        outcomes.unknown("maintenance.state", `${unknown} page(s) have no measured review state`);
      } else {
        outcomes.pass("maintenance.state");
      }
    }
  }

  const all = outcomes.result();
  return {
    built: dir,
    build: {
      hash: build?.hash ?? ZERO_HASH,
      pages: pages.length,
      files: files.size,
    },
    outcomes: all,
    findings: all.flatMap((outcome) => outcome.findings).sort(compareFindings),
  };
}

/** The rubric rules in report order. */
export function rubricRules(): readonly RubricRule[] {
  return RUBRIC.rules;
}

/** The dimension a rule scores, for consumers that group outcomes. */
export function dimensionOfCode(code: string): ReadinessDimension {
  const rule = RUBRIC.rules.find((entry) => entry.code === code);
  if (rule === undefined) throw new TypeError(`readiness: unknown rule ${code}`);
  return rule.dimension;
}

/** True when a scan has a readable manifest; a report from a scan without one is a finding, not a pass. */
export function scanHasBuild(result: ScanResult): boolean {
  return result.build.hash !== ZERO_HASH;
}

/** A finding's page scope builder, exported for tests and adapters. */
export { pageScope };
