import { readFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import type { Heading as MdHeading, Root } from "mdast";
import { loadConfig } from "../config/load.ts";
import { blocksOf } from "../blocks/parse.ts";
import { blocksLockOf, readBlocksLock, type BlocksLock } from "../blocks/lock.ts";
import { matchBlockIds } from "../blocks/match.ts";
import { loadData } from "../content/data.ts";
import { checkSeo } from "../data/checks/seo.ts";
import { loadCollections } from "../data/collections.ts";
import { loadChangeCollections } from "../data/changes/collection.ts";
import { buildChangelogPages } from "../data/changes/preset.ts";
import { applyDataDirectives } from "../data/directives.ts";
import { buildRecordPages, aliasUrlsOf } from "../data/pages.ts";
import { buildListPages, keyPositionOf } from "../data/lists.ts";
import { localizeFields, prefixOfLang } from "../data/record-context.ts";
import { planUrls, readUrlsLock, urlKey, type PublishedUrl, type UrlsPlan } from "../data/urls-lock.ts";
import { loadTemplates } from "../data/template.ts";
import { discover, type DiscoveredFile } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { sourceSpanOf, type IncludeSpan } from "../content/include-spans.ts";
import { expandIncludes } from "../content/includes.ts";
import { pageLang } from "../content/lang.ts";
import { permalink } from "../content/permalink.ts";
import { resolveTitle } from "../content/title.ts";
import type { Diagnostic, FrontMatter, Heading, NavTree, Page, Plugin, Site, SourcePos } from "../contracts/index.ts";
import { markdownToHtml } from "../markdown/to-html.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { applyRecordLinks } from "../markdown/plugins/links.ts";
import { navFromFolders, type FolderPage } from "../nav/from-folders.ts";
import { loadNavigation } from "../nav/from-yaml.ts";
import { createDiagnostics, sortDiagnostics } from "../pipeline/diagnostics.ts";
import { pageCache, parseMarkdownWithCache, type PageCache } from "../pipeline/page-cache.ts";
import { runContentHooks } from "../plugins/hooks.ts";
import { runMarkdownHooks, runValidateHooks } from "../plugins/content-extension.ts";
import { applyProjectLinks } from "../links/project-link.ts";
import { loadLockedNetwork, type LoadedNetwork } from "../network/load.ts";
import { applyFacts } from "./facts.ts";

/** What {@link buildModel} returns: the site and every finding made while assembling it. */
export interface ModelResult {
  /** The site model; always complete, even when `diagnostics` holds errors. */
  readonly site: Site;
  /** Findings from the config, discovery, front matter, Markdown, navigation, data, facts, and duplicate URLs, sorted. */
  readonly diagnostics: readonly Diagnostic[];
  /** Markdown pages parsed on this run; pages read from the page cache are not counted. */
  readonly parsedPages: number;
  /** What the URL lock check made of this build; the model is what writes `urls.lock.json` with `--update-urls`. */
  readonly urls: UrlsPlan;
  /** Every page block's id, as `blocks.lock.json` holds it; the build writes it with `--update-blocks`. */
  readonly blocksLock: BlocksLock;
}

/** Options of {@link buildModel}. */
export interface BuildModelOptions {
  /**
   * Folder of the per-page Markdown cache. When set, each page's parsed tree is read from and written to it, so an
   * unchanged page is not parsed again. Front matter, includes, and every later stage still run every build.
   */
  readonly pageCacheDir?: string;
  /** The site's plugins: the `markdown`, `content`, and `validate` hooks run on every page, and `model` on the assembled site. */
  readonly plugins?: readonly Plugin[];
  /** Accept every current record URL, moving a changed one into `urls.lock.json`'s `previous`; `mizzen build --update-urls` sets this. */
  readonly updateUrls?: boolean;
  /** Give every page its block ids and write `blocks.lock.json`; `mizzen build --update-blocks` sets this. */
  readonly updateBlocks?: boolean;
  /** The as-of date from `--as-of`, `YYYY-MM-DD`; it wins over the config's `asOf`. */
  readonly asOf?: string;
  /** The clock the stale-lock warning reads; a test sets it. Default: `Date.now`. */
  readonly now?: () => number;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Applies `defaults` to a page's front matter: later entries win over earlier ones, and the page always wins. */
function withDefaults(
  data: Readonly<Record<string, unknown>>,
  path: string,
  defaults: readonly { readonly path: string; readonly values: Readonly<Record<string, unknown>> }[],
): FrontMatter {
  let merged: Record<string, unknown> = {};
  for (const entry of defaults) {
    const folder = entry.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (folder === "" || path === folder || path.startsWith(`${folder}/`)) merged = { ...merged, ...entry.values };
  }
  return { ...merged, ...data } as FrontMatter;
}

/** The site root's folder inside the repository, `/`-separated with no leading `./` or trailing `/`; `""` at the repository root. */
function repositoryFolder(dir: string | undefined): string {
  const folder = (dir ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return folder === "." ? "" : folder;
}

/** The file position, relative to the repository root, a path under `source` has. */
function posOf(file: string, line: number, endLine = line): SourcePos {
  return { file, line, column: 1, endLine, endColumn: 1 };
}

/** Headings with their positions, from the top-level `h` nodes and the expanded body's source spans. */
function headingsOf(
  tree: { readonly children: readonly { readonly type: string }[] },
  collected: readonly { readonly depth: number; readonly text: string; readonly id: string }[],
  file: string,
  spans: readonly IncludeSpan[] = [],
): Heading[] {
  const nodes = tree.children.filter((n): n is MdHeading => n.type === "heading");
  return collected.map((h, i) => {
    const position = nodes[i]?.position;
    const start = position?.start;
    const end = position?.end;
    const line = start?.line ?? 1;
    const column = start?.column ?? 1;
    const endLine = end?.line ?? line;
    const endColumn =
      endLine === line ? Math.max(column, (end?.column ?? column) - 1) : Math.max(1, (end?.column ?? 1) - 1);
    const mapped = position === undefined || spans.length === 0 ? undefined : sourceSpanOf(spans, position.start, position.end);
    return {
      depth: h.depth as Heading["depth"],
      id: h.id,
      text: h.text,
      pos: mapped ?? { file, line, column, endLine, endColumn },
    };
  });
}

/** The page URL a folder of app files shares: `dashboard/index.html` is `/dashboard/`. */
function appUrl(folder: string, base: string): string {
  return permalink(`${folder}/index.html`, { base });
}

/**
 * Assembles the site model for the site at `root`: loads the config, discovers the files, and takes each page through
 * front matter, Markdown, title, permalink, and language, then through the plugins' `content` hook. Pages are sorted by
 * URL; two pages with one URL are an error that names both sources. Navigation comes from the navigation file, or from
 * the folders when the file is missing.
 *
 * With `options.pageCacheDir`, the Markdown parse of each page is cached by its expanded body, so a page whose body and
 * plugins are unchanged is not parsed again. Every other stage runs in full, so the model is the same either way.
 */
export async function buildModel(root: string, options: BuildModelOptions = {}): Promise<ModelResult> {
  const siteRoot = resolve(root);
  const diagnostics = createDiagnostics();
  const cache: PageCache | undefined =
    options.pageCacheDir === undefined ? undefined : pageCache(options.pageCacheDir);
  let parsedPages = 0;
  const plugins = options.plugins ?? [];

  /** Runs the `content` hook on a page that is complete, then the `validate` hooks on the final page. */
  const hookPage = async (page: Page): Promise<Page> => {
    const result = await runContentHooks(plugins, page);
    for (const d of result.diagnostics) diagnostics.report(d);
    const validated = await runValidateHooks(plugins, result.value);
    for (const d of validated.diagnostics) diagnostics.report(d);
    return validated.value;
  };

  const loaded = loadConfig(siteRoot);
  for (const d of loaded.diagnostics) diagnostics.report(d);
  let config = options.asOf === undefined ? loaded.config : { ...loaded.config, asOf: options.asOf };
  // A site in a network builds from the locked copy only. Its base is its project's path, so the pages, assets,
  // redirects, sitemap, and search index of every project agree on one place without the author repeating it.
  let network: LoadedNetwork | undefined;
  if (config.network !== undefined) {
    network = await loadLockedNetwork(siteRoot, config.network, options.now);
    for (const d of network.diagnostics) diagnostics.report(d);
    if (network.project !== undefined) {
      const base = `/${network.project.path}`;
      if (config.base !== "" && config.base.replace(/\/+$/, "") !== base) {
        diagnostics.error(
          "network.base-mismatch",
          `The config's base "${config.base}" differs from the base "${base}" that the network gives project "${network.project.id}".`,
          { help: `Remove \`base\` from the config, or set it to "${base}".` },
        );
      }
      config = { ...config, base };
    }
  }
  const sourceDir = resolve(siteRoot, config.source);
  // Positions are relative to the repository root, so a site in `docs/` names `docs/…` paths. Without a repository
  // folder they stay relative to the site root, which is always stable wherever the site is checked out.
  const sourcePrefix = [repositoryFolder(config.repository?.dir), relative(siteRoot, sourceDir).split("\\").join("/")]
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  const fileOf = (path: string): string => (sourcePrefix === "" ? path : posix.join(sourcePrefix, path));

  const files: DiscoveredFile[] = await discover(sourceDir, { include: config.include, exclude: config.exclude });

  const data = await loadData(sourceDir, files);
  for (const d of data.diagnostics) diagnostics.report(d);
  const collected = await loadCollections({ root: siteRoot, config });
  for (const d of collected.diagnostics) diagnostics.report(d);
  const history = await loadChangeCollections({ root: siteRoot, config });
  for (const d of history.diagnostics) diagnostics.report(d);
  const allCollections = Object.keys(history.collections).length === 0
    ? collected.collections
    : { ...collected.collections, ...history.collections };
  const loadedTemplates = await loadTemplates({ root: siteRoot, config });
  for (const d of loadedTemplates.diagnostics) diagnostics.report(d);

  // Block ids are on only once the site has a lock or has just asked for one, so every other site keeps its model.
  const blocksLock = await readBlocksLock(siteRoot);
  for (const d of blocksLock.diagnostics) diagnostics.report(d);
  const useBlocks = blocksLock.found || options.updateBlocks === true;

  const pages: Page[] = [];
  const folderPages: FolderPage[] = [];
  const seen = new Map<string, SourcePos>();
  /** Every block id the model holds, and where it first appeared; ids are unique site-wide. */
  const blockIds = new Map<string, SourcePos>();
  const appRoots = new Set<string>();
  /** Pages built from the source files, waiting for the site-wide block match before they join the model. */
  const staged: {
    readonly page: Page;
    readonly path: string;
    readonly order: unknown;
    readonly list?: { readonly text: string; readonly file: string };
  }[] = [];
  /** Pages whose front matter declares a list, and the source text the `list` key sits in; built once records exist. */
  const listDeclarations: { readonly page: Page; readonly text: string; readonly file: string }[] = [];

  const add = (page: Page, path: string, order: unknown): void => {
    const first = seen.get(page.url);
    if (first !== undefined) {
      diagnostics.error(
        "page.duplicate-url",
        `Two pages have the URL ${page.url}: ${first.file} and ${page.source.file}.`,
        { pos: page.source, help: `Change the \`permalink\` or rename one of them. The other page is ${first.file}.` },
      );
      return;
    }
    seen.set(page.url, page.source);
    for (const block of page.blocks ?? []) {
      const earlier = blockIds.get(block.id);
      if (earlier !== undefined) {
        diagnostics.error(
          "blocks.duplicate-id",
          `The block id ${JSON.stringify(block.id)} is used twice: ${earlier.file}:${earlier.line} and ${block.pos.file}:${block.pos.line}.`,
          { pos: block.pos, help: "Give one of the two blocks a different id." },
        );
        continue;
      }
      blockIds.set(block.id, block.pos);
    }
    pages.push(page);
    if (page.kind === "doc" && page.record === undefined) {
      folderPages.push({
        path,
        url: page.url,
        title: page.title,
        ...(typeof order === "number" ? { order } : {}),
      });
    }
  };

  for (const file of files) {
    if (file.kind === "app") {
      const folder = file.path.split("/")[0]!;
      const isRootFile = !file.path.includes("/");
      if (isRootFile || appRoots.has(folder)) continue;
      appRoots.add(folder);
      const indexFile = fileOf(`${folder}/index.html`);
      const lang = pageLang(`${folder}/index.html`, { config });
      staged.push({
        page: await hookPage({
          url: appUrl(folder, config.base),
          source: posOf(indexFile, 1),
          frontMatter: {},
          title: folder,
          lang: lang.lang,
          dir: lang.dir,
          headings: [],
          html: "",
          markdown: "",
          kind: "app",
        }),
        path: `${folder}/index.html`,
        order: undefined,
      });
      continue;
    }
    if (file.kind !== "doc") continue;

    const text = await readFile(join(sourceDir, file.path), "utf8");
    const rel = fileOf(file.path);
    const fm = parseFrontMatter(text, rel);
    for (const d of fm.diagnostics) diagnostics.report(d);

    const frontMatter = withDefaults(fm.data, file.path, config.defaults);
    if (frontMatter.published === false) continue;

    const isMarkdown = /\.(md|markdown)$/i.test(file.path);
    // Includes expand before the Markdown stage: only here is the site root known, so a Markdown plugin cannot read
    // the included file. The expanded body is the page's Markdown from then on, so twins, search, and links see it.
    let body = fm.body;
    let spans: readonly IncludeSpan[] = [];
    if (isMarkdown) {
      const included = await expandIncludes({
        body: fm.body,
        bodyLine: fm.bodyLine,
        file: file.path,
        sourceDir,
        displayFile: rel,
      });
      for (const d of included.diagnostics) diagnostics.report(d);
      body = included.body;
      spans = included.spans;
      const transformed = await runMarkdownHooks(plugins, { path: file.path, markdown: body }, posOf(rel, fm.bodyLine));
      for (const d of transformed.diagnostics) diagnostics.report(d);
      body = transformed.value.markdown;
    }
    let tree: Root;
    if (!isMarkdown) {
      tree = { type: "root", children: [] };
    } else if (cache !== undefined) {
      const result = await parseMarkdownWithCache(body, fm.bodyLine, cache);
      if (result.parsed) parsedPages += 1;
      tree = result.tree;
    } else {
      tree = await parseMarkdown(body, fm.bodyLine);
      parsedPages += 1;
    }
    const pageBlocks = isMarkdown && useBlocks
      ? blocksOf({ file: rel, tree, markdown: body, bodyLine: fm.bodyLine })
      : undefined;
    for (const d of pageBlocks?.diagnostics ?? []) diagnostics.report(d);
    const directives = isMarkdown
      ? applyDataDirectives(tree, body, { data: data.data, collections: allCollections, file: rel })
      : { markdown: body, diagnostics: [] };
    for (const d of directives.diagnostics) diagnostics.report(d);
    const lang = pageLang(file.path, { config, frontMatter });
    if (isMarkdown && network?.lock !== undefined && config.network !== undefined) {
      applyProjectLinks(tree, { lock: network.lock, current: config.network.project, file: rel, report: (d) => diagnostics.report(d) });
    }
    if (isMarkdown) {
      applyRecordLinks(tree, {
        collections: allCollections,
        config: config.collections,
        base: config.base,
        prefix: prefixOfLang(config, lang.lang),
        lang: lang.lang,
        defaultLang: config.lang,
        file: rel,
      });
    }

    const { title } = resolveTitle({ frontMatter, tree, file: file.path });
    const url = permalink(file.path, {
      base: config.base,
      ...(typeof frontMatter.permalink === "string" ? { permalink: frontMatter.permalink } : {}),
    });

    let html = body;
    let headings: Heading[] = [];
    if (isMarkdown) {
      const out = await markdownToHtml(tree, rel, spans);
      html = out.html;
      headings = headingsOf(tree, out.headings, rel, spans);
    }

    const draft: Page = {
      url,
      source: posOf(rel, fm.bodyLine),
      frontMatter,
      title,
      lang: lang.lang,
      dir: lang.dir,
      headings,
      ...(pageBlocks === undefined ? {} : { blocks: pageBlocks.blocks }),
      html,
      markdown: directives.markdown,
      kind: "doc",
    };
    // A page that declares a list is hooked once its list pages exist, so each generated page, including page one, gets
    // exactly one `content` hook and the declaring page is never hooked twice.
    const declaresList = draft.frontMatter.list !== undefined;
    const page = declaresList ? draft : await hookPage(draft);
    staged.push({
      page,
      path: file.path,
      order: page.frontMatter.order,
      ...(declaresList ? { list: { text, file: rel } } : {}),
    });
  }

  // A block can move to another page, so ids are matched across every staged page before any of them joins the model;
  // duplicate detection and the output then see the ids the build carries.
  const matchedBlocks = blocksLock.found
    ? matchBlockIds(
      blocksLock.lock,
      staged.map((entry) => ({ file: entry.page.source.file, blocks: entry.page.blocks ?? [] })),
    )
    : undefined;
  for (const entry of staged) {
    const blocks = matchedBlocks?.get(entry.page.source.file);
    const page = blocks === undefined ? entry.page : { ...entry.page, blocks };
    add(page, entry.path, entry.order);
    // A page a duplicate URL kept out of the model declares no list either.
    if (entry.list !== undefined && pages.at(-1) === page) {
      listDeclarations.push({ page, text: entry.list.text, file: entry.list.file });
    }
  }

  const records = await buildRecordPages({
    root: siteRoot,
    config,
    collections: allCollections,
    templates: loadedTemplates.templates,
    views: loadedTemplates.views,
    filePrefix: repositoryFolder(config.repository?.dir),
  });
  for (const d of records.diagnostics) diagnostics.report(d);
  for (const record of records.pages) {
    const page = await hookPage(record);
    add(page, page.record?.template ?? page.source.file, page.frontMatter.order);
  }

  // List pages are built once every record page has a URL: the props a layout receives name each record's page. The
  // page that declared the list keeps its own URL; its later and expanded pages are added under their own.
  const listPages: { readonly original: Page; readonly pages: readonly Page[] }[] = [];
  for (const declaration of listDeclarations) {
    const position = keyPositionOf(declaration.text, declaration.file, "list");
    const built = buildListPages({
      page: declaration.page,
      ...(position === undefined ? {} : { position }),
      config,
      collections: allCollections,
      data: data.data,
    });
    for (const d of built.diagnostics) diagnostics.report(d);
    listPages.push({ original: declaration.page, pages: built.pages });
  }
  for (const { original, pages: built } of listPages) {
    const [first, ...rest] = built;
    if (first !== undefined) {
      const hooked = await hookPage(first);
      const index = pages.indexOf(original);
      if (index >= 0) {
        pages[index] = hooked;
        // The folder navigation reads the title the page ended with, exactly as a hook on an ordinary page would leave it.
        const folder = folderPages.findIndex((entry) => entry.url === original.url);
        if (folder >= 0) folderPages[folder] = { ...folderPages[folder]!, title: hooked.title };
      }
    }
    for (const extra of rest) {
      const known = seen.get(extra.url);
      if (known !== undefined) {
        diagnostics.error(
          "page.duplicate-url",
          `Two pages have the URL ${extra.url}: ${known.file} and ${extra.source.file}.`,
          { pos: extra.source, help: `Change the \`permalink\` or rename one of them. The other page is ${known.file}.` },
        );
        continue;
      }
      const hooked = await hookPage(extra);
      seen.set(hooked.url, hooked.source);
      pages.push(hooked);
    }
  }

  // The changelog pages come last: they list the events of every collection whose `changelog.pages` is on, and the
  // feed reads the record pages' URLs. A collection with no history builds nothing.
  const changelog = buildChangelogPages({ config, collections: allCollections, data: data.data });
  for (const d of changelog.diagnostics) diagnostics.report(d);
  for (const generated of changelog.pages) {
    const known = seen.get(generated.url);
    if (known !== undefined) {
      diagnostics.error(
        "page.duplicate-url",
        `Two pages have the URL ${generated.url}: ${known.file} and ${generated.source.file}.`,
        { pos: generated.source, help: `Change the \`permalink\` of the other page, or turn off \`changelog.pages\`.` },
      );
      continue;
    }
    const hooked = await hookPage(generated);
    seen.set(hooked.url, hooked.source);
    pages.push(hooked);
  }

  pages.sort((a, b) => byCodePoint(a.url, b.url));

  // The URL lock: check every record page against the URLs it published, and hand the redirects output the earlier
  // ones. One page per record is the record's address in the lock: the default language's page.
  const locked = await readUrlsLock(siteRoot);
  for (const d of locked.diagnostics) diagnostics.report(d);
  const preferred = new Map<string, Page>();
  for (const page of pages) {
    if (page.record === undefined || page.record.view !== undefined) continue;
    const key = urlKey(page.record.collection, page.record.id);
    const current = preferred.get(key);
    if (current === undefined || (page.lang === config.lang && current.lang !== config.lang)) {
      preferred.set(key, page);
    }
  }
  const published: PublishedUrl[] = [];
  const aliases = new Map<string, readonly string[]>();
  const aliasDiagnostics: Diagnostic[] = [];
  for (const [key, page] of preferred) {
    const record = page.record!;
    const source = allCollections[record.collection]?.records.find((candidate) => candidate.id === record.id);
    const entry = config.collections[record.collection];
    if (source === undefined || entry === undefined) continue;
    published.push({ collection: record.collection, id: record.id, url: page.url, position: source.position });
    const localized = localizeFields(source.fields, page.lang, config.lang).fields;
    const fields = localized["id"] === undefined ? { ...localized, id: record.id } : localized;
    const earlier = aliasUrlsOf(
      record.collection,
      record.id,
      fields,
      entry,
      {
        base: config.base,
        prefix: prefixOfLang(config, page.lang),
        position: source.position,
        url: page.url,
      },
      aliasDiagnostics,
    );
    if (earlier.length > 0) aliases.set(key, earlier);
  }
  for (const d of aliasDiagnostics) diagnostics.report(d);
  const urls = planUrls({
    lock: locked.lock,
    locked: locked.found,
    published,
    config: config.collections,
    update: options.updateUrls === true,
  });
  // A lock that could not be read is one error; its empty contents are not also a pile of new records.
  const lockUnreadable = locked.diagnostics.some((finding) => finding.severity === "error");
  for (const d of urls.diagnostics) {
    if (lockUnreadable && d.id === "urls.new-records") continue;
    diagnostics.report(d);
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (page.record === undefined || page.record.view !== undefined) continue;
    const key = urlKey(page.record.collection, page.record.id);
    if (preferred.get(key) !== page) continue;
    const earlier = [...(urls.previous[key] ?? []), ...(aliases.get(key) ?? [])];
    if (earlier.length === 0) continue;
    pages[i] = { ...page, record: { ...page.record, previousUrls: earlier } };
  }

  for (const d of checkSeo(pages, config.collections)) diagnostics.report(d);

  const navFile = resolve(siteRoot, config.navigation);
  const navRel = relative(siteRoot, navFile).split("\\").join("/");
  const collections: Record<string, Record<string, { title: string; url: string; fields: Readonly<Record<string, unknown>> }[]>> = {};
  for (const page of pages) {
    // A view is another rendering of a record, not another entry in a collection's navigation list.
    if (page.record === undefined || page.record.view !== undefined) continue;
    const record = allCollections[page.record.collection]?.records.find(
      (candidate) => candidate.id === page.record?.id,
    );
    const byCollection = collections[page.lang] ?? {};
    const list = byCollection[page.record.collection] ?? [];
    list.push({
      title: page.title,
      url: page.url,
      fields: record === undefined ? {} : localizeFields(record.fields, page.lang, config.lang).fields,
    });
    byCollection[page.record.collection] = list;
    collections[page.lang] = byCollection;
  }
  const navResult = loadNavigation(navFile, navRel, {
    pages: new Set(pages.map((p) => p.url)),
    base: config.base,
    collections,
    defaultLang: config.lang,
  });
  for (const d of navResult.diagnostics) diagnostics.report(d);
  const nav: NavTree =
    Object.keys(navResult.nav).length > 0 ? navResult.nav : { docs: navFromFolders(folderPages) };

  // Derived facts run last, once the pages and `_data` are final, and land at `data[fact.name]`; `_data` wins.
  const gone = urls.removed
    .filter((entry) => entry.policy !== "error")
    .map((entry) => ({
      collection: entry.collection,
      id: entry.id,
      urls: entry.urls,
      ...(entry.target === undefined ? {} : { target: entry.target }),
    }));
  const applied = await applyFacts({
    site: {
      config,
      pages,
      nav,
      data: data.data,
      collections: allCollections,
      ...(gone.length === 0 ? {} : { removed: gone }),
    },
    root: siteRoot,
    sourceDir,
  });
  for (const d of applied.diagnostics) diagnostics.report(d);

  const site = network?.site === undefined ? applied.site : { ...applied.site, network: network.site };
  return {
    site,
    diagnostics: sortDiagnostics(diagnostics.all),
    parsedPages,
    urls,
    blocksLock: blocksLockOf(pages),
  };
}
