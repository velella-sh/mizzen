import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config/load.ts";
import { normalizeBase } from "../content/permalink.ts";
import { EVIDENCE_REPORT_PATH, evidenceReport } from "../evidence/report.ts";
import { loadLockedEvidence } from "../evidence/store.ts";
import { loadFederation } from "../federation/lock.ts";
import { discover } from "../content/discover.ts";
import type { Diagnostic, Output, OutputContext, OutputFile, Page, PageStale, PreviewPolicy, Site } from "../contracts/index.ts";
import { buildModel, repositoryFolder } from "../model/build.ts";
import { listCalendarsOf } from "../calendar/links.ts";
import { writeUrlsLock } from "../data/urls-lock.ts";
import { writeBlocksLock } from "../blocks/lock.ts";
import { diffReadBuilds, type SiteDiff } from "../diff/index.ts";
import { readBuild, type Build } from "../diff/builds.ts";
import { MANIFEST_PATH, PREVIEW_DIFF_PATH, recordBuildHash } from "../outputs/build-hash.ts";
import { underBase } from "../outputs/manifest.ts";
import { driftPagesOf, driftRoot } from "../outputs/drift-report.ts";
import { trustAsOf, trustPagesOf, trustRoot } from "../outputs/trust.ts";
import { CODE_CONFIG_FILE, loadCodeConfig, runModelHooks, runOutputsHooks } from "../plugins/hooks.ts";
import { pluginInputs } from "../plugins/dependencies.ts";
import { createCssBundler, type CssBundle } from "../render/css.ts";
import { loadRegistry } from "../render/registry.ts";
import { copyAssets } from "./assets.ts";
import { buildIslandModules, islandUrl } from "../render/islands.ts";
import { cacheKey, cacheRootOf, includedSnippets, renderSettingsKey, restoreCache, writeCache } from "./cache.ts";
import { createDiagnostics, diagnosticsReport, sortDiagnostics, type Diagnostics } from "./diagnostics.ts";
import { stalePageStates } from "../stale/diagnostics.ts";
import { applyVersionRouting } from "../versions/apply.ts";
import { buildDependencyGraph } from "./dependency-graph.ts";
import { planInvalidation, formatInvalidationReport, type InvalidationPlan } from "./invalidation.ts";
import { pruneRenderCache, pruneRenderEntries, readRenderInputs, recordKeyOf, recordShapeOf, renderCache, renderPageKey, writeRenderInputs, type RenderCache, type RenderCacheEntry } from "./render-cache.ts";
import { moduleName } from "../runtime/modules.ts";
import { EXAMPLES_LOCK_FILE, pinnedExamplesOf, readExamplesLock } from "../examples/pinned.ts";
import { plannedSocialImages } from "../social/plan.ts";
import { createRenderPool, renderOnePage, type RenderPool } from "./parallel.ts";
import { placeholderDiagnostics } from "./placeholder-diagnostic.ts";

/** Options of {@link build}. */
export interface BuildOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The folder the site is written to. Replaced as a whole: the old site stays until the new one is complete. */
  readonly out: string;
  /** The theme's root folder: its `src/index.ts`, and its `layouts/`, `chrome/`, and `components/` folders. */
  readonly themeRoot: string;
  /** Theme files to copy, as paths relative to `themeRoot`; each lands under `assets/theme/` with its hash in the name. */
  readonly themeFiles?: readonly string[];
  /** Layout for a page that names none in its front matter or in `defaults`. Without it such a page is an error. */
  readonly defaultLayout?: string;
  /** Folder the outputs are read from. Default: `src/outputs/` beside this file. */
  readonly outputsDir?: string;
  /** Reuse the output of an unchanged build from the cache. Off by default; `mizzen build` turns it on. */
  readonly cache?: boolean;
  /** Folder the cache lives in. Default: `<root>/.mizzen/cache`. Only used when `cache` is true. */
  readonly cacheDir?: string;
  /**
   * Pages to render at once in worker threads. `1`, the default, renders in this process, byte for byte as before;
   * `2` or more starts that many workers, each loading the theme, and pages are rendered in batches. A worker that
   * fails renders its pages in this process with a diagnostic. There is no config key for this: it is a machine
   * setting, like a make job count, and `mizzen build --workers <n|auto>` is how a person sets it.
   */
  readonly workers?: number;
  /**
   * Accept every record page's current URL and write `urls.lock.json`: a URL that changed keeps its old one as a
   * redirect. `mizzen build --update-urls` sets this; no other command writes the lock.
   */
  readonly updateUrls?: boolean;
  /**
   * Give every page its block ids and write `blocks.lock.json`: a block that declares one keeps it when it moves, and
   * one without a declaration gets a content-derived id. `mizzen build --update-blocks` sets this.
   */
  readonly updateBlocks?: boolean;
  /**
   * The as-of date, `YYYY-MM-DD`, from `--as-of`; it wins over the config's `asOf`. The build never reads the clock:
   * `--as-of today` is resolved by the CLI before it gets here.
   */
  readonly asOf?: string;
  /**
  /**
   * Explain each page rebuilt after a warm build in {@link BuildResult.report}: the changed input and the shortest
   * dependency chain to the page. `mizzen build --report` prints it; a build that rebuilt nothing reports nothing.
   */
  readonly report?: boolean;
  /**
   * The site `base` this build is written under, from `--base`: `/preview/pr-1` builds the same pages and assets under
   * that path, so each preview gets its own. Wins over the config's `base`.
   */
  readonly basePath?: string;
  /**
   * The preview policy from `--preview-canonical`: every page is `noindex` and its canonical points at
   * `canonicalBase` and the page's own URL. Wins over `config.url` for the canonical; front matter `canonical_url`
   * still wins over both. It also carries the commit `--commit` or `GITHUB_SHA` names, for the manifest.
   */
  readonly preview?: PreviewPolicy;
  /**
   * The latest public build to compare this preview with: a built folder with its manifest, from `--baseline`. Only a
   * preview build uses it. The difference is written to `.mizzen/preview-diff.json` beside the preview, naming the
   * baseline's build hash; a preview without a baseline writes no such file.
   */
  readonly baseline?: string;
}

/** Where a build spent its wall time, in milliseconds. */
export interface BuildTimings {
  /** Reading the site and building its model: config, discovery, front matter, Markdown, HTML, collections, evidence, and the cache reads that decide what to render. */
  readonly dataMs: number;
  /** Rendering pages through the theme, summed over every page the build rendered. */
  readonly renderMs: number;
  /** Running the outputs and checking their files, not counting the page renders they asked for. */
  readonly outputsMs: number;
  /** Writing the site, the manifest, and the cache entry. */
  readonly writeMs: number;
}

/** What {@link build} wrote and found. */
export interface BuildResult {
  /** Absolute path of the output folder. */
  readonly out: string;
  /** Every file written, relative to `out`, sorted by path. */
  readonly files: readonly string[];
  /** Every finding of the build, sorted. The site is written even when there are errors; the caller decides whether to fail. */
  readonly diagnostics: readonly Diagnostic[];
  /** Doc pages the build rendered, rather than read from the per-page render cache. */
  readonly renderedPages: number;
  /** Doc pages served from the per-page render cache in this build. */
  readonly cachedPages: number;
  /**
   * Where this build spent its wall time. Absent on a whole-build cache hit, where no stage ran: the output was
   * restored from the cache.
   */
  readonly timings?: BuildTimings | undefined;
  /**
   * What a warm build had to rebuild, from the dependency graph and the pages whose render key changed. Absent on a
   * cold build or when the settings changed, where every output is rebuilt and there is nothing to narrow.
   */
  readonly invalidation?: InvalidationPlan | undefined;
  /** Why each page was rebuilt, from `invalidation`, when `report` is on and a warm build narrowed the work. */
  readonly report?: string | undefined;
}

/** The default folder of outputs: `src/outputs/` beside this file's folder. */
const OUTPUTS_DIR = fileURLToPath(new URL("../outputs/", import.meta.url));

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True for a path an output may write: relative, `/`-separated, and with no empty, `.`, or `..` segment. */
function isInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isOutput(value: unknown): value is Output {
  if (typeof value !== "object" || value === null) return false;
  const { name, run } = value as { name?: unknown; run?: unknown };
  return typeof name === "string" && typeof run === "function";
}

/** Where a preview build publishes its result, relative to the output folder. */
const PREVIEW_REPORT_PATH = ".mizzen/doctor.json";

/**
 * The result of one preview build: the version 1 diagnostics report `mizzen doctor --format json` prints, plus the
 * counts and the base and canonical that name the preview. The build owns this path, so a preview always describes
 * itself; a normal build writes no report at all. A preview compared with the public build also names the baseline
 * and the diff report beside this one.
 */
function previewReport(
  site: Site,
  preview: PreviewPolicy,
  findings: readonly Diagnostic[],
  baseline: string | undefined,
): string {
  const { version, diagnostics } = diagnosticsReport(findings);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return `${JSON.stringify(
    {
      version,
      preview: {
        base: site.config.base,
        canonicalBase: preview.canonicalBase,
        ...(preview.commit === undefined ? {} : { commit: preview.commit }),
        ...(baseline === undefined ? {} : { baseline, diff: PREVIEW_DIFF_PATH }),
      },
      counts,
      diagnostics,
    },
    null,
    2,
  )}\n`;
}

/**
 * The difference between the public baseline and this preview: the report `mizzen diff` prints, plus the build hash
 * that names the baseline it compared.
 */
function previewDiffReport(baseline: Build, diff: SiteDiff): string {
  return `${JSON.stringify({ version: 1, baseline: { hash: baseline.hash }, diff }, null, 2)}\n`;
}

/**
 * The preview's pages read at the public base, so a page is compared with the page it replaces rather than reported as
 * moved by the preview's own base path. Every other file is already relative to the folder that deploys under the base.
 */
function atPublicBase(head: Build, base: string): Build {
  return base === "" ? head : { ...head, pages: head.pages.map((page) => ({ ...page, url: underBase(page.url, base) })) };
}

/**
 * Reads every `*.ts` file of the outputs folder in file-name order and returns the outputs they export.
 * A file must export exactly one output, under any export name, and the output's `name` must equal the file name.
 * A file that exports no output is a helper and is not run.
 */
async function loadOutputs(dir: string, diagnostics: Diagnostics): Promise<Output[]> {
  if (!(await exists(dir))) {
    diagnostics.error("output.missing-folder", `Output folder "${dir}" does not exist.`, {
      help: "Point `outputsDir` at the folder of output files.",
    });
    return [];
  }
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && moduleName(entry.name) !== null)
    .map((entry) => entry.name)
    .sort(byCodePoint);

  const outputs: Output[] = [];
  for (const file of names) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      diagnostics.error("output.load-failed", `Failed to load output "${file}": ${detail}.`, {
        help: "Fix the file so Node can import it.",
      });
      continue;
    }
    const found = Object.keys(mod)
      .sort(byCodePoint)
      .map((key) => mod[key])
      .filter(isOutput);
    if (found.length === 0) continue;
    if (found.length > 1) {
      diagnostics.error("output.multiple", `Output file "${file}" exports ${found.length} outputs; it may export one.`, {
        help: "Move the extra outputs into their own files.",
      });
      continue;
    }
    const output = found[0]!;
    const expected = moduleName(file)!;
    if (output.name !== expected) {
      diagnostics.error("output.name-mismatch", `Output file "${file}" is named "${output.name}"; it must be "${expected}".`, {
        help: "Make the output's name equal to its file name, without its extension.",
      });
      continue;
    }
    outputs.push(output);
  }
  return outputs;
}

/**
 * Puts `staging` in place of `out`. The old folder is moved aside first and removed only once the new one is in
 * place, so a failed swap puts the old site back.
 */
async function commit(staging: string, out: string): Promise<void> {
  const replaced = `${staging}-replaced`;
  const hadOld = await exists(out);
  if (hadOld) await rename(out, replaced);
  try {
    await rename(staging, out);
  } catch (err) {
    if (hadOld) await rename(replaced, out);
    throw err;
  }
  if (hadOld) await rm(replaced, { recursive: true, force: true });
}

/** Fails when `out` is the source folder or sits inside it under a name discovery would not skip. */
function assertOutOutsideSource(sourceDir: string, out: string): void {
  const rel = relative(sourceDir, out);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside && (rel === "" || !/^[_.]/.test(rel.split(sep)[0] ?? ""))) {
    throw new TypeError(
      `build: the output folder "${out}" is inside the source folder "${sourceDir}"; name it with a leading "_" (such as _site) or put it outside.`,
    );
  }
}

/**
 * Builds the site: model, theme, outputs, and write.
 *
 * The site's plugins run in the build, in the order `mizzen.config.ts` lists them: `content` on every page while the
 * model is assembled, `model` on the finished site before anything renders, `outputs` on the files the outputs produced
 * before any of them is written. A hook that fails is an error naming its plugin, and the build carries on with the
 * value it had.
 *
 * Every output runs first, in file-name order, and its files are checked in memory: a path outside the output folder
 * is an error, and so is a path two outputs both write; the first one wins. Then the site's assets are copied and the
 * output files written, all into a staging folder beside `out`. A site file wins over an output file at the same path:
 * the output's file is skipped, with no diagnostic. Only when the staging folder is complete is it swapped in, so `out`
 * is never half-written. Outputs switched off by `outputs` in the config do not run.
 *
 * With `cache`, a build whose config, source, navigation, theme, outputs, layout options, engine version, and plugin
 * declarations are unchanged restores the previous output instead of building again. Config and navigation are in the
 * same key as the pages, so changing either invalidates every page. When that whole-build entry misses, each page's
 * Markdown parse is kept under `<cache>/pages/` and keyed by its expanded body, body line, plugin names and orders, and
 * the engine version, so only the pages that changed are parsed again. A site whose code file lists a plugin that
 * declares no inputs always builds cold: what the plugin reads cannot be part of the key, so a hit could restore stale
 * output.
 *
 * With `workers` above 1, pages render in worker threads, and the site written is byte for byte the one a single
 * process writes. A worker that fails renders its pages in this process, with a `render.worker-failed` warning.
 *
 * A preview build (`preview`) also writes `.mizzen/doctor.json`: its diagnostics with codes and positions, the counts
 * of each severity, and the base and canonical that name the preview, so CI reads the result from the output itself.
 *
 * Problems in the content and the theme come back as diagnostics; a throw means a bug, such as an output or layout
 * that threw, and leaves `out` as it was. `out` must not be the source folder nor sit inside it, unless its name
 * starts with `_` or `.`, which discovery skips.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const startedAt = performance.now();
  const diagnostics = createDiagnostics();
  const root = resolve(options.root);
  const out = resolve(options.out);
  const themeRoot = resolve(options.themeRoot);
  const outputsDir = resolve(options.outputsDir ?? OUTPUTS_DIR);
  const workers = options.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1) {
    throw new TypeError(`build: workers must be a whole number of at least 1, not ${String(options.workers)}.`);
  }

  // The config is read before the cache so the source folder is known without building the model.
  const basePath = options.basePath === undefined ? undefined : normalizeBase(options.basePath);
  const preview = options.preview;
  // A preview may be compared with the public build it replaces. The baseline is read before the cache key because the
  // diff report it produces is part of the output: another public build must not be answered by the old entry. A
  // folder without a manifest is a usage error that says how to fix it, never a report of nothing.
  const baseline =
    preview === undefined || options.baseline === undefined
      ? undefined
      : await readBuild(resolve(options.baseline), options.baseline);
  const loadedConfig = loadConfig(root);
  const loaded = {
    ...loadedConfig,
    config: {
      ...loadedConfig.config,
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
      ...(basePath === undefined ? {} : { base: basePath }),
    },
  };
  const sourceDir = resolve(root, loaded.config.source);
  assertOutOutsideSource(sourceDir, out);
  const evidence = await loadLockedEvidence(root);
  // Federated knowledge is a build input: a changed lock or bundle is a different key, and a normal build reads only the
  // local lock and bytes. A site without the key loads nothing.
  const federationInput =
    loaded.config.federation === undefined ? undefined : await loadFederation(root).catch(() => undefined);
  const recordedExamples = loaded.config.examples?.pinned === true
    ? await readExamplesLock(root).catch((error: Error) => {
        diagnostics.error("examples.invalid-lock", `Cannot read ${EXAMPLES_LOCK_FILE}: ${error.message}`);
        return undefined;
      })
    : undefined;

  // Stale state compares each page's covered files with the committed review lock, never with git or a clock. It is
  // read before the cache key because a covered file or the lock can change while every source file stays the same.
  // It is an enrichment: a build that cannot read it still writes the site.
  const staleBySource = await stalePageStates(root).catch((): Map<string, PageStale> => new Map());
  const repositoryDir = repositoryFolder(loaded.config.repository?.dir);
  const staleByRepositorySource = new Map([...staleBySource].map(([file, stale]) => [posix.join(repositoryDir, file), stale]));

  // The site's code file is read before the cache: its plugin declarations are part of the key, and a plugin that
  // declares no inputs means the build cannot be cached. Its problems are diagnostics, not a failed build, so they are
  // reported below whether the build runs or the cache restores their record.
  const code = await loadCodeConfig(root);
  // A code file that could not load may read modules the declarations cannot name, so nothing about it is cached.
  const codeFailed = code.diagnostics.some((finding) => finding.id === "plugin.load-failed");
  const pluginKey = codeFailed ? undefined : await pluginInputs(code.plugins, root).catch(() => undefined);

  const cacheRoot =
    options.cache === true && options.updateUrls !== true && options.updateBlocks !== true && pluginKey !== undefined && !diagnostics.hasErrors
      ? resolve(options.cacheDir ?? cacheRootOf(root))
      : undefined;
  let key: string | undefined;
  if (cacheRoot !== undefined) {
    key = await cacheKey({
      root,
      sourceDir,
      config: loaded.config,
      themeRoot,
      outputsDir,
      out,
      ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
      ...(options.themeFiles === undefined ? {} : { themeFiles: options.themeFiles }),
      stale: JSON.stringify([...staleBySource]),
      ...(evidence === undefined ? {} : { evidence: evidence.fingerprint }),
      ...(federationInput?.loaded.fingerprint === undefined ? {} : { federation: federationInput.loaded.fingerprint }),
      examplesKey: recordedExamples?.digest,
      ...(pluginKey === undefined ? {} : { pluginKey }),
      ...(preview === undefined ? {} : { preview }),
      ...(baseline === undefined ? {} : { baseline: baseline.hash }),
    }).catch(() => undefined);
    if (key !== undefined) {
      const hit = await restoreCache(cacheRoot, key, out).catch(() => undefined);
      if (hit !== undefined) {
        try {
          await commit(hit.staging, out);
          return { out, files: hit.files, diagnostics: [...hit.diagnostics], renderedPages: 0, cachedPages: 0 };
        } catch {
          // A cache entry that cannot be put in place is no better than no entry: build cold below.
        } finally {
          await rm(hit.staging, { recursive: true, force: true });
        }
      }
    }
  }

  // The per-page render cache answers a narrower question than the whole-build cache: with the settings unchanged,
  // which pages still render to the bytes they had? Its key covers the config, navigation, data, theme, outputs, and
  // every page's front matter but not a page's body, so a body-only edit retires that one page and nothing else.
  const renderRoot = cacheRoot === undefined ? undefined : join(cacheRoot, "render");
  for (const d of code.diagnostics) diagnostics.report(d);

  const model = await buildModel(root, {
    ...(cacheRoot === undefined ? {} : { pageCacheDir: join(cacheRoot, "pages") }),
    plugins: code.plugins,
    ...(options.updateUrls === true ? { updateUrls: true } : {}),
    ...(options.updateBlocks === true ? { updateBlocks: true } : {}),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(basePath === undefined ? {} : { base: basePath }),
    ...(preview === undefined ? {} : { preview }),
  });
  for (const d of model.diagnostics) diagnostics.report(d);

  // The model hooks run once, on the assembled site and before anything is rendered from it.
  const hookedModel = await runModelHooks(code.plugins, model.site);
  for (const d of hookedModel.diagnostics) diagnostics.report(d);
  // Version routing decides what the public build writes: the default release also answers at the unprefixed URL and
  // current docs stay out of the output while a release is default. The model keeps one page per source file.
  const versioned = applyVersionRouting(hookedModel.value.pages, hookedModel.value.data.versions, hookedModel.value.config.base);
  for (const d of versioned.diagnostics) diagnostics.report(d);
  let hookedSite: Site = versioned.pages === hookedModel.value.pages ? hookedModel.value : { ...hookedModel.value, pages: versioned.pages };
  if (recordedExamples !== undefined) {
    const pages = await Promise.all(hookedSite.pages.map(async (page) => {
      const examples = await pinnedExamplesOf(page, hookedSite.config.base, recordedExamples.lock);
      return examples === undefined ? page : { ...page, examples };
    }));
    hookedSite = { ...hookedSite, pages };
  }
  // With `examples.execute`, a build runs the opt-in examples itself and attaches their evidence to each page, so the
  // HTML, `examples.json`, every page JSON, and a proof read one map. The lock is checked first; a missing one stops the
  // run with one error and attaches nothing. A pinned build never executes, so this runs only when asked.
  if (hookedSite.config.examples?.execute === true) {
    const { runSiteExamples } = await import("../examples/site.ts");
    const cacheDir = options.cache === true ? join(options.cacheDir ?? cacheRootOf(root), "examples") : undefined;
    const { exampleCache } = await import("../pipeline/examples/cache.ts");
    const ran = await runSiteExamples(hookedSite, {
      root,
      sourceDir,
      ...(cacheDir === undefined ? {} : { cache: exampleCache({ dir: cacheDir }) }),
      report: (finding) => diagnostics.report(finding),
    });
    hookedSite = ran.site;
  }
  // Attach the state and subscription links before hashing or handing pages to a render worker.
  const site: Site =
    staleByRepositorySource.size === 0 && Object.keys(hookedSite.config.calendars ?? {}).length === 0
      ? hookedSite
      : {
          ...hookedSite,
          pages: hookedSite.pages.map((page) => {
            const stale = staleByRepositorySource.get(page.source.file);
            const list = listCalendarsOf(hookedSite, page);
            return stale === undefined && list === page.list ? page : {
              ...page,
              ...(stale === undefined ? {} : { stale }),
              ...(list === undefined ? {} : { list }),
            };
          }),
        };
  for (const d of await placeholderDiagnostics(site)) diagnostics.report(d);
  const externalEvidence = evidence === undefined ? undefined : evidenceReport(
    evidence,
    new Set(site.pages.filter((page) => page.kind === "doc").map((page) => page.url)),
    site.config.asOf,
  );

  // Trust and drift are computed once, from this build's pages, and handed to the theme through `site.data` before any
  // page renders. Outputs still run on the raw site, so `trust.json` and `drift.json` keep their own provenance; the
  // entries the theme shows are the same levels and reasons, from the same build. A site that supplies `trust` or
  // `drift` itself keeps its value: data wins over a derived fact.
  let renderSite = site;
  /** The evidence a page's theme reads, hashed per page: a review date comes from git, not from source bytes. */
  const evidenceByUrl = new Map<string, string>();
  if (site.pages.some((page) => page.kind === "doc")) {
    try {
      const evidence: Record<string, unknown> = {};
      if (!Object.hasOwn(site.data, "drift")) evidence.drift = await driftPagesOf(site, { root: driftRoot() });
      if (!Object.hasOwn(site.data, "trust")) {
        const asOf = trustAsOf();
        const trust = await trustPagesOf(site, {
          root: trustRoot(),
          ...(asOf === undefined ? {} : { asOf }),
          ...(evidence.drift === undefined ? {} : { drift: evidence.drift }),
        });
        evidence.trust = trust.pages;
      }
      if (Object.keys(evidence).length > 0) {
        renderSite = { ...site, data: { ...site.data, ...evidence } };
        const trustPages = evidence.trust as Record<string, unknown> | undefined;
        const driftPages = evidence.drift as Record<string, unknown> | undefined;
        for (const page of site.pages) {
          const own = JSON.stringify([trustPages?.[page.url] ?? null, driftPages?.[page.url] ?? null]);
          evidenceByUrl.set(page.url, createHash("sha256").update(own).digest("hex"));
        }
      }
    } catch {
      // Evidence is an enrichment: a build without it still writes the site, and the outputs report what they could not
      // measure. Nothing is fabricated in its place.
    }
  }

  // Its key stands in for the collection sources with the site's shape (see `recordShapeOf`), so it is computed once the
  // model exists: a record's fields are keyed by the page that shows them, not by the settings every page shares.
  const settingsKey =
    renderRoot === undefined
      ? undefined
      : await renderSettingsKey({
          root,
          sourceDir,
          config: loaded.config,
          examplesKey: recordedExamples?.digest,
          themeRoot,
          outputsDir,
          ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
          ...(options.themeFiles === undefined ? {} : { themeFiles: options.themeFiles }),
          ...(pluginKey === undefined ? {} : { pluginKey }),
          ...(preview === undefined ? {} : { preview }),
          ...(Object.keys(site.collections).length === 0 ? {} : { recordShape: recordShapeOf(site) }),
        }).catch(() => undefined);
  /** The pages whose social image this build writes: their heads name it, so it is part of their render key. */
  const socialPages = await plannedSocialImages(site, root);
  const recordKey = recordKeyOf(site);
  /** Every page's render key, computed once: the lookup, the write, and the prune of unused entries all read it. */
  const pageKeys = new Map<string, string>();
  const pageKeyOf = (page: Page): string => {
    let key = pageKeys.get(page.url);
    if (key === undefined && settingsKey !== undefined) {
      key = renderPageKey(
        settingsKey,
        page,
        options.defaultLayout,
        evidenceByUrl.get(page.url) ?? "",
        recordKey(page),
        page.dates === true ? site.config.asOf : undefined,
        socialPages.has(page.url) ? "1" : "",
      );
      pageKeys.set(page.url, key);
    }
    return key ?? "";
  };
  const settingsDir = renderRoot === undefined || settingsKey === undefined ? undefined : join(renderRoot, settingsKey);
  const renderStore: RenderCache | undefined = settingsDir === undefined ? undefined : renderCache(settingsDir);
  const previousInputs = settingsDir === undefined ? {} : await readRenderInputs(settingsDir);
  const retiredSettings =
    renderRoot === undefined || settingsKey === undefined
      ? []
      : (await readdir(renderRoot).catch((): string[] => [])).filter((name) => name !== settingsKey);

  const registry = await loadRegistry(themeRoot, { siteRoot: root, overrides: loaded.config.theme.overrides });
  for (const d of registry.diagnostics) diagnostics.report(d);

  // Shared CSS, in cascade order: the theme's `styles/`, then every chrome part's `style.css`. A page adds its layout's
  // and its components' CSS. Bundles are collected here and written with the site.
  const bundler = createCssBundler({
    themeRoot,
    base: [
      ...registry.styles,
      ...Object.values(registry.chrome).flatMap((unit) => (unit.css === undefined ? [] : [unit.css])),
    ],
    urlBase: site.config.base,
  });
  const bundles = new Map<string, CssBundle>();

  /** Links the page's stylesheets just before `</head>`; the render stage is synchronous, so this happens after it. */
  const usedIslands = new Set<string>();
  const withCss = async (rendered: {
    html: string;
    css: readonly string[];
    islands?: readonly { src: string }[];
    skipFontPreloads?: readonly string[];
  }): Promise<string> => {
    for (const island of rendered.islands ?? []) usedIslands.add(island.src);
    const { base, page } = await bundler.page(rendered.css);
    const used = [base, page].filter((b): b is CssBundle => b !== undefined && b.css !== "");
    for (const b of used) bundles.set(b.path, b);
    if (used.length === 0) return rendered.html;
    const skipped = new Set((rendered.skipFontPreloads ?? []).map((family) => family.toLowerCase()));
    const preloads =
      base === undefined
        ? []
        : optionalFontFaces(base.css)
            .filter((face) => !skipped.has(face.family.toLowerCase()))
            .map((face) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${face.url}">`);
    const links = used.map((b) => `<link rel="stylesheet" href="${site.config.base}/${b.path}">`).join("");
    return rendered.html.replace(/<\/head>/i, () => `${preloads.join("")}${links}</head>`);
  };

  // The site's code file is code, not a site file: it is never copied into the output.
  const files = (await discover(sourceDir, { include: site.config.include, exclude: site.config.exclude })).filter(
    (file) => file.path !== CODE_CONFIG_FILE,
  );

  // Read every reusable render once, before the pool starts: a page served from the cache must not be prefetched.
  const cachedRenders = new Map<string, RenderCacheEntry>();
  if (renderStore !== undefined && settingsKey !== undefined) {
    await Promise.all(
      site.pages
        .filter((page) => page.kind === "doc")
        .map(async (page) => {
          const entry = await renderStore.get(pageKeyOf(page));
          if (entry !== undefined) cachedRenders.set(page.url, entry);
        }),
    );
  }

  // A snippet is not discovered, so a page whose render key missed does not say which include changed. The previous
  // build's hashes name it, so the plan carries the include's own causal chain instead of blaming the page file.
  const includeInputs: Record<string, string> = {};
  if (renderStore !== undefined) {
    for (const path of await includedSnippets(files, sourceDir)) {
      try {
        includeInputs[path] = createHash("sha256").update(await readFile(join(sourceDir, path))).digest("hex");
      } catch {
        includeInputs[path] = "";
      }
    }
  }

  // With the settings unchanged, the pages whose render key missed and the snippets whose bytes changed are the
  // changed inputs; the graph turns them into the outputs that must rebuild and the causal chain for each.
  let invalidation: InvalidationPlan | undefined;
  if (renderStore !== undefined && cachedRenders.size > 0 && retiredSettings.length === 0) {
    const changedPages = site.pages.filter((page) => page.kind === "doc" && !cachedRenders.has(page.url));
    const changedSnippets = Object.keys(includeInputs).filter((path) => previousInputs[path] !== includeInputs[path]);
    if (changedPages.length + changedSnippets.length > 0) {
      const graph = await buildDependencyGraph({ root, site, files }).catch(() => undefined);
      if (graph !== undefined) {
        invalidation = planInvalidation({
          graph: graph.graph,
          changes: [
            ...changedPages.map((page) => ({ kind: "changed" as const, path: page.source.file })),
            ...changedSnippets.map((path) => ({ kind: "changed" as const, path })),
          ],
        });
      }
    }
  }

  // Reading the site and preparing the build is over; what is left is rendering pages, running the outputs, and writing.
  const dataMs = performance.now() - startedAt;

  // With one worker, pages render in this process exactly as before. With more, the pool starts rendering the doc
  // pages the html output will ask for while the outputs are still being loaded, then serves them from its results.
  // A pool that renders a page nobody asks for reports nothing: reporting happens when an output asks for the page.
  const pool: RenderPool | undefined =
    workers > 1
      ? createRenderPool({
          themeRoot,
          siteRoot: root,
          overrides: loaded.config.theme.overrides,
          site: renderSite,
          registry,
          images: socialPages,
          ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
          workers,
        })
      : undefined;
  if (pool !== undefined && site.config.outputs.html !== false) {
    pool.prefetch(site.pages.filter((page) => page.kind === "doc" && !cachedRenders.has(page.url)));
  }

  // Outputs may ask for the same page: render it once and report its diagnostics once.
  const renderedHtml = new Map<string, Promise<string>>();
  let renderedPages = 0;
  let cachedPages = 0;
  /** Wall time spent rendering pages, and so not attributable to the outputs that asked for them. */
  let renderMs = 0;
  const reportedLayouts = new Set<string>();
  /** Reports a page's rendering findings, once per missing layout for record pages only. */
  const reportRendered = (
    rendered: { readonly layout?: string; readonly diagnostics: readonly Diagnostic[] },
    page: Page,
  ): void => {
    for (const diagnostic of rendered.diagnostics) {
      // A collection's pages all share one template layout, and a list's pages share the layout its declaration chose,
      // so one error is enough for them (#234). A file page's layout is its own choice, and each keeps its diagnostic.
      if (diagnostic.id === "render.unknown-layout" && (page.record !== undefined || page.list !== undefined)) {
        const layout =
          rendered.layout ??
          /layout "([^"]+)"/.exec(diagnostic.message)?.[1];
        if (layout !== undefined) {
          if (reportedLayouts.has(layout)) continue;
          reportedLayouts.add(layout);
        }
      }
      diagnostics.report(diagnostic);
    }
  };
  const renderPaged = async (page: Page): Promise<string> => {
    const known = renderedHtml.get(page.url);
    if (known !== undefined) return known;
    const pending = (async () => {
      const cached = cachedRenders.get(page.url);
      if (cached !== undefined) {
        cachedPages += 1;
        reportRendered(cached, page);
        return withCss({
          html: cached.html,
          css: cached.css,
          ...(cached.islands === undefined ? {} : { islands: cached.islands }),
          ...(cached.skipFontPreloads === undefined ? {} : { skipFontPreloads: cached.skipFontPreloads }),
        });
      }
      const renderStartedAt = performance.now();
      try {
        const rendered =
          pool === undefined ? renderOnePage(registry, renderSite, page, options.defaultLayout, socialPages) : await pool.render(page);
        renderedPages += 1;
        reportRendered(rendered, page);
        if (renderStore !== undefined && settingsKey !== undefined) {
          await renderStore.set(pageKeyOf(page), {
            html: rendered.html,
            css: rendered.css,
            ...(rendered.islands === undefined ? {} : { islands: rendered.islands }),
            ...(rendered.skipFontPreloads === undefined ? {} : { skipFontPreloads: rendered.skipFontPreloads }),
            diagnostics: rendered.diagnostics,
          });
        }
        return await withCss(rendered);
      } finally {
        renderMs += performance.now() - renderStartedAt;
      }
    })();
    renderedHtml.set(page.url, pending);
    return pending;
  };

  const ctx: OutputContext = {
    renderPage: renderPaged,
    build: { root, workers, ...(cacheRoot === undefined ? {} : { cacheDir: cacheRoot }) },
    report: (d) => diagnostics.report(d),
  };

  // Outputs run in memory and the plugins' `outputs` hooks run on what they produced, so every path is checked before
  // anything is written.
  const produced: OutputFile[] = [];
  const owner = new Map<OutputFile, string>();
  if (externalEvidence !== undefined) {
    const file = { path: EVIDENCE_REPORT_PATH, contents: externalEvidence };
    produced.push(file);
    owner.set(file, "external-evidence");
  }
  const outputsStartedAt = performance.now();
  /** Renders happen inside an output that asks for a page; that time belongs to rendering, not to the output. */
  const rendersBeforeOutputs = renderMs;
  try {
    for (const output of await loadOutputs(outputsDir, diagnostics)) {
      if (site.config.outputs[output.name] === false) continue;
      for (const file of await output.run(site, ctx)) {
        produced.push(file);
        owner.set(file, output.name);
      }
    }
  } finally {
    await pool?.close();
  }

  // Every page's render is in the output files now; the per-page copies are not needed to write them.
  renderedHtml.clear();
  cachedRenders.clear();

  let hookedOutputs: Awaited<ReturnType<typeof runOutputsHooks>> | undefined = await runOutputsHooks(
    code.plugins,
    produced,
    site,
  );
  for (const d of hookedOutputs.diagnostics) diagnostics.report(d);

  const claimed = new Map<string, string>();
  const pending: OutputFile[] = [];
  for (const file of hookedOutputs.value) {
    const from = owner.get(file);
    const who = from === undefined ? "The outputs hook" : `Output "${from}"`;
    if (!isInside(file.path)) {
      diagnostics.error("output.bad-path", `${who} writes "${file.path}", which is not inside the output folder.`, {
        help: "Use a relative path with `/` separators and no `..`.",
      });
      continue;
    }
    if (claimed.has(file.path)) {
      const first = claimed.get(file.path);
      const name = (output: string | undefined): string => (output === undefined ? "the outputs hook" : `outputs "${output}"`);
      diagnostics.error("output.duplicate-path", `Two files write "${file.path}": ${name(first)} and ${name(from)}.`, {
        help: "Turn one of them off in `outputs`, or rename its file.",
      });
      continue;
    }
    claimed.set(file.path, from ?? "");
    pending.push(file);
  }
  // Only `pending` keeps the files from here on, and it lets go of each as it is written.
  hookedOutputs = undefined;
  owner.clear();
  produced.length = 0;
  const outputsMs = performance.now() - outputsStartedAt - (renderMs - rendersBeforeOutputs);

  const writeStartedAt = performance.now();
  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(out)}-build-`));
  try {
    const assets = await copyAssets({
      source: sourceDir,
      out: staging,
      files,
      themeRoot,
      themeFiles: [...new Set([...(options.themeFiles ?? []), ...bundler.assets()])],
    });
    const assetPaths = new Set(assets.files.map((f) => f.path));
    const written = assets.files.map((f) => f.path);

    // Only the islands a page loaded are written, with the files they import.
    const clients = [...Object.values(registry.chrome), ...Object.values(registry.components)].flatMap((unit) =>
      unit.client !== undefined && usedIslands.has(islandUrl(site.config.base, unit.client)) ? [unit.client] : [],
    );
    for (const [path, js] of await buildIslandModules(themeRoot, clients)) {
      const abs = join(staging, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, js);
      assetPaths.add(path);
      written.push(path);
    }

    for (const bundle of bundles.values()) {
      const abs = join(staging, bundle.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bundle.css);
      assetPaths.add(bundle.path);
      written.push(bundle.path);
    }

    const waiting: (OutputFile | undefined)[] = pending;
    for (let i = 0; i < waiting.length; i++) {
      const file = waiting[i] as OutputFile;
      waiting[i] = undefined;
      // A site's own file wins over a generated one at the same path, silently: a site `llms.txt` replaces the output's.
      if (assetPaths.has(file.path)) continue;
      const abs = join(staging, file.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.contents);
      written.push(file.path);
    }

    // The build's one hash goes into the manifest last, so every other file is in place (#1252). The manifest that
    // records the hash is left out of it, and a site file that replaced the generated manifest is left alone.
    const recordsHash = claimed.get(MANIFEST_PATH) === "manifest" && !assetPaths.has(MANIFEST_PATH);
    if (baseline !== undefined && !recordsHash) {
      diagnostics.warn("preview.baseline-unrecorded", "The preview has no manifest, so it cannot be compared with the public baseline.", {
        help: "Turn the manifest output on, and remove any site file at .mizzen/manifest.json.",
      });
    }
    const findings = sortDiagnostics(diagnostics.all);
    if (preview !== undefined) {
      const abs = join(staging, PREVIEW_REPORT_PATH);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, previewReport(site, preview, findings, recordsHash ? baseline?.hash : undefined));
      written.push(PREVIEW_REPORT_PATH);
    }
    const usesAsOf = site.pages.some((page) => page.dates === true);
    if (recordsHash) {
      await recordBuildHash(staging, usesAsOf ? site.config.asOf : undefined);
      // The report names the build it compared, so it is written after the hash and left out of it (#843): the
      // preview's diff then names the build its own manifest records.
      if (baseline !== undefined) {
        const head = await readBuild(staging, staging);
        const diff = await diffReadBuilds(baseline, atPublicBase(head, site.config.base));
        const abs = join(staging, PREVIEW_DIFF_PATH);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, previewDiffReport(baseline, diff));
        written.push(PREVIEW_DIFF_PATH);
      }
    }

    const fileList = [...written].sort(byCodePoint);
    if (cacheRoot !== undefined && key !== undefined) await writeCache(cacheRoot, key, staging, fileList, findings);

    await commit(staging, out);
    // The lock is a promise about what this build published, so only a clean build writes it.
    if (options.updateUrls === true && !findings.some((finding) => finding.severity === "error")) {
      await writeUrlsLock(root, model.urls.next);
    }
    if (options.updateBlocks === true && !findings.some((finding) => finding.severity === "error")) {
      await writeBlocksLock(root, model.blocksLock);
    }
    if (settingsDir !== undefined) await writeRenderInputs(settingsDir, includeInputs);
    if (renderRoot !== undefined && settingsKey !== undefined) await pruneRenderCache(renderRoot, settingsKey);
    // An entry no page of this build asked for belongs to a record that changed or went away.
    if (settingsDir !== undefined) {
      await pruneRenderEntries(
        settingsDir,
        new Set(site.pages.filter((page) => page.kind === "doc").map((page) => pageKeyOf(page))),
      );
    }
    const report =
      options.report === true && invalidation !== undefined ? formatInvalidationReport(invalidation) : "";
    return {
      out,
      files: fileList,
      diagnostics: findings,
      renderedPages,
      cachedPages,
      timings: { dataMs, renderMs, outputsMs, writeMs: performance.now() - writeStartedAt },
      ...(invalidation === undefined ? {} : { invalidation }),
      ...(report === "" ? {} : { report }),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** One shipped font file a page would preload: the face's family and the woff2 it names. */
export interface OptionalFontFace {
  /** The `font-family` of the `@font-face`, without its quotes. */
  readonly family: string;
  /** The first woff2 URL in the face. */
  readonly url: string;
}

/**
 * The font files a stylesheet declares with `font-display: optional`, with the family that declares
 * each. A font like that is used only when it is there at the first paint, so a page preloads them:
 * otherwise a slow connection never shows the font, and a late one lays the text out twice. A face
 * without a family or a woff2 URL is left out; one file declared twice is one entry.
 */
export function optionalFontFaces(css: string): OptionalFontFace[] {
  const found: OptionalFontFace[] = [];
  const seen = new Set<string>();
  for (const face of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    if (!/font-display:\s*optional/.test(face)) continue;
    const url = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/.exec(face)?.[1];
    const family = /font-family:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/.exec(face);
    const name = (family?.[1] ?? family?.[2] ?? family?.[3] ?? "").trim();
    if (url === undefined || name === "" || seen.has(url)) continue;
    seen.add(url);
    found.push({ family: name, url });
  }
  return found;
}

/** The woff2 files a stylesheet declares with `font-display: optional`, once each. */
export function optionalFonts(css: string): string[] {
  return optionalFontFaces(css).map((face) => face.url);
}
