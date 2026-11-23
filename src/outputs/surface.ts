import type { Output, OutputFile } from "../contracts/output.ts";
import type { Site } from "../contracts/content.ts";

/** The report file written into the output folder. */
export const SURFACE_FILE = "surface.json";

/**
 * Writes `surface.json` when the site config declares a `surface` key: the versioned report of the public surface, its
 * documentation state, the gaps, and the counts by area. It also reports every adapter finding as a diagnostic, so
 * `mizzen check` shows them, and enforces the configured `minCoverage` gate as an error.
 *
 * The report module is imported only when the key is present, so a build that does not declare `surface` never loads
 * the adapters or the CLI parser. A site without the key writes no file and reports nothing.
 */
export const surface: Output = {
  name: "surface",
  async run(site: Site, ctx): Promise<readonly OutputFile[]> {
    if (site.config.surface === undefined) return [];
    const root = ctx.build?.root;
    if (root === undefined) return [];
    const { surfaceReportOf } = await import("../surface/report.ts");
    const { report, diagnostics } = await surfaceReportOf({ root, site });
    for (const diagnostic of diagnostics) ctx.report(diagnostic);

    const minimum = site.config.surface.minCoverage;
    if (minimum !== undefined && report.coverage.documentedPercent !== null && report.coverage.documentedPercent < minimum) {
      ctx.report({
        id: "surface.coverage-below-minimum",
        severity: "error",
        message: `Surface documentation is ${report.coverage.documentedPercent.toFixed(2)}%, below the configured minimum of ${minimum}%.`,
        help: "Document the gaps in `surface.json`, or lower `surface.minCoverage`.",
      });
    }

    return [{ path: SURFACE_FILE, contents: `${JSON.stringify(report, null, 2)}\n` }];
  },
};
