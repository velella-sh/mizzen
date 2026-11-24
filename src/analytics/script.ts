import type { Page, Site } from "../contracts/content.ts";
import type { ScriptTag } from "../contracts/render.ts";
import { resolveAnalytics, type LockedNetwork } from "./network.ts";
import { providerScript } from "./providers.ts";
import { skipsAnalytics, type SkipContext } from "./skip.ts";

/** What a caller adds when the site belongs to a locked network. */
export interface AnalyticsContext extends SkipContext {
  readonly network?: LockedNetwork;
  /** The project's `path` in the network, sent as the label. */
  readonly project?: string;
}

/**
 * The scripts one page's head carries: one deferred tag for the chosen provider, the same on every page of a build,
 * or none when the site has no analytics or the page is skipped. Nothing here reads the clock or the page's content.
 */
export function analyticsScripts(site: Site, page: Page, context: AnalyticsContext = networkContext(site)): ScriptTag[] {
  if (skipsAnalytics(page, context)) return [];
  const resolved = resolveAnalytics(site.config.analytics, context.network, context.project);
  if (resolved === undefined) return [];
  const tag = providerScript(resolved.config, resolved.label);
  return tag === undefined ? [] : [tag];
}

/**
 * The context a build passes: the locked network's analytics setting, this project's `path` as the label, and whether
 * the project is public. A site with no network gets an empty context, so its output does not change.
 */
export function networkContext(site: Site): AnalyticsContext {
  const network = site.network;
  if (network === undefined) return {};
  const project = network.projects.find((candidate) => candidate.id === network.current);
  return {
    ...(network.analytics === undefined ? {} : { network: { analytics: network.analytics } }),
    ...(project === undefined ? { projectPublic: false } : { project: project.path }),
  };
}
