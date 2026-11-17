/**
 * The two addresses a report archive publishes: one latest page whose URL never moves, and one archived page per run
 * whose URL is filled from the run id. A later run can replace the latest page and add its own archive, but it cannot
 * move an archive already published: the id is the run's address, and nothing here reads the build clock.
 */
import { fillPermalink, urlOfPattern } from "../permalink.ts";
import type { ArchivedRun } from "./run.ts";

/** The view patterns a report archive configures. */
export interface ReportViewPatterns {
  /** Pattern of the latest report, such as `/reports/latest/`; it fills no field. */
  readonly latest: string;
  /** Pattern of one archived report, such as `/reports/{id}/`; `{id}` is the run id. */
  readonly archive: string;
}

/** Options of {@link reportViews}. */
export interface ReportViewOptions extends ReportViewPatterns {
  /** The site `base`, as every page URL uses. */
  readonly base: string;
  /** The language prefix, as every page URL uses. */
  readonly prefix?: string;
}

/** The archived URL of one run. */
export interface ArchivedView {
  /** The run id the URL was built from. */
  readonly id: string;
  /** The stable URL of the run's archived report. */
  readonly url: string;
}

/** What {@link reportViews} built. */
export interface ReportViews {
  /** The URL of the latest report; the same URL after every run. */
  readonly latest: string;
  /** One archived URL per run, in run order. */
  readonly archived: readonly ArchivedView[];
}

/**
 * Builds the latest report URL and each run's archived URL. The archive pattern fills `{id}` from the run id, so a
 * run keeps its URL when a newer run is published; `{date}` and `{commit}` are also available from the run.
 */
export function reportViews(runs: readonly ArchivedRun[], options: ReportViewOptions): ReportViews {
  const archived = runs.map((run) => {
    const filled = fillPermalink(options.archive, { id: run.id, date: run.date, commit: run.commit });
    return { id: run.id, url: urlOfPattern(filled.value, options.base, options.prefix) };
  });
  return { latest: urlOfPattern(options.latest, options.base, options.prefix), archived };
}
