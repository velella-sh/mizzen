import type { AnalyticsConfig } from "../contracts/config.ts";

/**
 * What the locked network file says about analytics: the shared setting, and nothing else. The caller reads the lock
 * from disk; this unit never reads the network, so the build stays offline and repeatable.
 */
export interface LockedNetwork {
  readonly analytics?: AnalyticsConfig;
}

/** The analytics setting a page's project builds with, and the label that keeps its numbers apart. */
export interface ResolvedAnalytics {
  readonly config: AnalyticsConfig;
  /** The project's `path`, sent with every hit; `undefined` for a site that is not part of a network. */
  readonly label?: string;
}

/**
 * Chooses the analytics setting: the site's own key wins over the network's. The project's `path` is the label, so
 * two projects on one provider site have separate numbers. A site with neither key gets `undefined`.
 */
export function resolveAnalytics(
  own: AnalyticsConfig | undefined,
  network: LockedNetwork | undefined,
  projectPath: string | undefined,
): ResolvedAnalytics | undefined {
  const config = own ?? network?.analytics;
  if (config === undefined) return undefined;
  return projectPath === undefined ? { config } : { config, label: projectPath };
}
