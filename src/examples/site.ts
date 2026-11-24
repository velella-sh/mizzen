/**
 * Runs a site's opt-in examples during a build (`examples.execute`) and attaches the results to each page (#1328 –
 * #1336).
 *
 * Doing the run before the outputs, rather than inside one output, means every consumer sees the same evidence: the
 * HTML render, `examples.json`, each page's `index.json`, and a proof all read one `page.examples` map. The run is the
 * same orchestrator the recorder uses — sessions, hidden setup and teardown, snippets, runbooks, type-check, output
 * matching, limits, and the cache — so a build and a recorded run cannot drift.
 *
 * The environment lock is checked once, before anything runs. A missing or changed lock is one error and no example
 * runs, so a build never silently runs against an environment the lock does not describe. Nothing here writes a file.
 */
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Page, Site } from "../contracts/content.ts";
import { checkEnvironment, exampleUnlocked, environmentHash } from "./environment.ts";
import { buildHostEnvironment } from "./host-environment.ts";
import { pageExamples } from "./pinned.ts";
import { runPageExamples } from "./run.ts";
import type { ExampleCache } from "../pipeline/examples/cache.ts";
import type { SessionLimits } from "./session.ts";

/** What {@link runSiteExamples} needs. */
export interface SiteExamplesOptions {
  /** Absolute site root: where `node_modules`, snippets, and fixtures live. */
  readonly root: string;
  /** Absolute source folder. */
  readonly sourceDir: string;
  /** The result cache, so an unchanged session replays its stored outcome. */
  readonly cache?: ExampleCache;
  /** Receives every finding. */
  readonly report: (diagnostic: Diagnostic) => void;
}

/** The site with each page's results attached, and whether the run was blocked by the lock. */
export interface SiteExamplesResult {
  readonly site: Site;
  /** True when the environment lock was missing or changed, so no example ran. */
  readonly locked: boolean;
}

/** The locked limits from the config, with the defaults. */
function limitsOf(site: Site): SessionLimits {
  const examples = site.config.examples;
  return {
    timeoutMs: examples?.timeoutMs ?? 10_000,
    memoryMb: examples?.memoryMb ?? 0,
    network: examples?.network ?? "deny",
  };
}

/**
 * Runs the examples of every page and returns the site with `page.examples` set. The lock is checked first unless
 * `examples.lock` is `false`; a missing or changed lock reports one finding and attaches nothing, so `examples.json`
 * and each page's JSON stay honest about what was not run.
 */
export async function runSiteExamples(site: Site, options: SiteExamplesOptions): Promise<SiteExamplesResult> {
  const settings = site.config.examples;
  const limits = limitsOf(site);
  let environment: string | undefined;
  if (settings?.lock ?? true) {
    const host = await buildHostEnvironment({ root: options.root, sourceDir: options.sourceDir, limits: { ...limits, shell: "bash" } });
    const check = await checkEnvironment(options.root, host);
    if (check.state !== "locked") {
      options.report(exampleUnlocked(check));
      return { site, locked: true };
    }
    environment = environmentHash(check.environment!);
  }

  const pages: Page[] = [];
  for (const page of site.pages) {
    if (page.kind !== "doc") {
      pages.push(page);
      continue;
    }
    const blocks = await pageExamples(page, true);
    if (blocks.length === 0) {
      pages.push(page);
      continue;
    }
    const run = await runPageExamples({
      examples: blocks,
      page: page.url,
      file: blocks[0]?.pos.file ?? page.source.file,
      root: options.root,
      sourceDir: options.sourceDir,
      limits,
      allowlist: settings?.allowlist ?? [],
      ...(environment === undefined ? {} : { environment }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      failOnFailure: settings?.failOnFailure === true,
    });
    for (const diagnostic of run.diagnostics) options.report(diagnostic);
    pages.push({ ...page, examples: Object.fromEntries(run.results) });
  }
  return { site: { ...site, pages }, locked: false };
}
