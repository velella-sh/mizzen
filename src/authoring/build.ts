/**
 * Build a draft in a temporary copy of the site, so a preview and a verification see the page the theme would draw
 * without touching the working tree. The copy excludes build output, cache, and repository metadata; the draft is
 * written at its proposed source path, the model is rebuilt, the surface and behavior reports are read from the copy,
 * and the site is built into a fresh output folder. The caller removes the temporary folder.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import type { BehaviorReport } from "../contracts/behavior.ts";
import type { SurfaceReport } from "../contracts/surface.ts";
import type { AuthoringDraft, AuthoringTask } from "../contracts/authoring.ts";
import { build, type BuildResult } from "../pipeline/build.ts";
import { buildModel, type ModelResult } from "../model/build.ts";
import { behaviorReportOf } from "../behavior/report.ts";
import { surfaceReportOf } from "../surface/report.ts";
import { renderDraftSource } from "./draft.ts";

/** What a merged site build produced. */
export interface MergedSite {
  /** The temporary site root. */
  readonly root: string;
  /** The temporary output folder. */
  readonly out: string;
  /** The page source written in the copy, relative to the site root. */
  readonly source: string;
  /** The output file relative to the output folder. */
  readonly file: string;
  /** The page HTML, when the build wrote it. */
  readonly html?: string;
  /** The rebuilt site model. */
  readonly model: ModelResult;
  /** The surface report from the copy. */
  readonly surface: SurfaceReport;
  /** The behavior report from the copy. */
  readonly behavior: BehaviorReport;
  readonly built: BuildResult;
  /** Every build diagnostic at error severity. */
  readonly errors: readonly Diagnostic[];
}

/** What a merged build needs. */
export interface MergedSiteOptions {
  /** The real site root; it is copied, never changed. */
  readonly root: string;
  readonly task: AuthoringTask;
  readonly draft: AuthoringDraft;
  readonly themeRoot: string;
  readonly version?: string;
}

/** Folders a site copy never carries: output, cache, dependencies, and repository metadata. */
const EXCLUDED = new Set([".git", ".mizzen", "dist", "node_modules", "coverage"]);

/** Copy the site, skipping output, cache, dependencies, and repository metadata. */
function copySite(root: string, target: string): void {
  cpSync(root, target, {
    recursive: true,
    filter: (source) => !EXCLUDED.has(source.split(/[\\/]/u).pop() ?? ""),
  });
}

/** The output file of a page URL, relative to the output folder. */
export function outputFileOf(url: string): string {
  const path = url.replace(/^\/+/u, "");
  return `${path.endsWith("/") ? path : `${path}/`}index.html`;
}

/**
 * Writes the draft into a copy of the site, rebuilds the model, the surface and behavior reports, and the site. The
 * caller owns the temporary folder and removes it with {@link removeMergedSite}.
 */
export async function buildMergedSite(options: MergedSiteOptions): Promise<MergedSite> {
  const temp = mkdtempSync(join(tmpdir(), "mizzen-authoring-"));
  const siteRoot = join(temp, "site");
  const out = join(temp, "out");
  copySite(options.root, siteRoot);
  const source = options.task.location.source;
  const absolute = join(siteRoot, source);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, renderDraftSource(options.draft));

  const model = await buildModel(siteRoot);
  const surface = (
    await surfaceReportOf({
      root: siteRoot,
      site: model.site,
      ...(options.version === undefined ? {} : { version: options.version }),
    })
  ).report;
  const behavior = (
    await behaviorReportOf({
      site: model.site,
      root: siteRoot,
      ...(options.version === undefined ? {} : { version: options.version }),
    })
  ).report;
  const built = await build({ root: siteRoot, out, themeRoot: options.themeRoot, defaultLayout: "doc" });
  const file = outputFileOf(options.task.location.url);
  const pagePath = join(out, file);
  const html = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : undefined;
  return {
    root: siteRoot,
    out,
    source,
    file,
    ...(html === undefined ? {} : { html }),
    model,
    surface,
    behavior,
    built,
    errors: [...model.diagnostics, ...built.diagnostics].filter((diagnostic) => diagnostic.severity === "error"),
  };
}

/** Removes the temporary folder a merged build created. */
export function removeMergedSite(site: MergedSite): void {
  rmSync(join(site.root, ".."), { recursive: true, force: true });
}
