import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { formatBehaviorJson } from "../behavior/format.ts";
import { behaviorMatrixHtml } from "../behavior/matrix.ts";
import { behaviorReportOf } from "../behavior/report.ts";

/** The JSON report file written into the output folder. */
export const BEHAVIOR_FILE = "behavior.json";

/** The public matrix page, relative to the output folder. */
export const BEHAVIOR_MATRIX_FILE = "behavior/index.html";

/**
 * Writes the public behavior matrix when any page declares a behavior: `behavior.json` for machines and
 * `behavior/index.html` for readers. Every structural finding is reported as a diagnostic, so `mizzen check` fails on a
 * duplicate id or an invalid replacement exactly as the report names it.
 *
 * A site with no `behavior` front matter writes nothing, so a build that does not use the feature keeps its bytes.
 * Private behaviors and private evidence values are already gone from the report the matrix receives.
 */
export const behavior: Output = {
  name: "behavior",
  async run(site: Site, ctx): Promise<readonly OutputFile[]> {
    if (!site.pages.some((page) => (page.behaviors?.length ?? 0) > 0)) return [];
    const root = ctx.build?.root;
    const { report, diagnostics } = await behaviorReportOf({ site, ...(root === undefined ? {} : { root }) });
    for (const diagnostic of diagnostics) ctx.report(diagnostic);
    return [
      { path: BEHAVIOR_FILE, contents: formatBehaviorJson(report) },
      {
        path: BEHAVIOR_MATRIX_FILE,
        contents: behaviorMatrixHtml(report, { base: site.config.base }),
      },
    ];
  },
};
