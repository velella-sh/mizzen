import type { AnalyticsConfig } from "./config.ts";

/** One project of the shared network, as a theme sees it. */
export interface NetworkProject {
  /** The project's id in the network file. */
  readonly id: string;
  /** The one URL segment the project is published under; its base is `/` plus this. */
  readonly path: string;
  /** The label shown for the project. */
  readonly title: string;
  /** True for the project this site is. */
  readonly current: boolean;
  /** Folder of the project's search index below its path; absent for the default `pagefind`. */
  readonly search?: string;
}

/** The shared network a site belongs to, read from the locked file. Projects that are not public are left out. */
export interface SiteNetwork {
  /** The id of this site's project. */
  readonly current: string;
  /** SHA-256 of `network.lock.json`'s bytes: what this build was made against. */
  readonly lock: string;
  /** This project's analytics setting in the locked network; a site's own `analytics` wins over it. */
  readonly analytics?: AnalyticsConfig;
  /** The public projects, in the network file's order. */
  readonly projects: readonly NetworkProject[];
}
