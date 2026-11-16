import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { siteOrigins, unlistedOrigins } from "../analytics/origins.ts";

/**
 * Reports every outside origin the built pages contact, so `mizzen doctor` lists them. It writes no file: the list
 * goes to the build manifest. It runs only for a site that sets `analytics`, and it warns about an origin outside
 * `analytics.allowedOrigins` without ever stopping the build.
 */
export const originReport: Output = {
  name: "origin-report",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.analytics === undefined) return [];
    const origins = siteOrigins(site);
    if (origins.length > 0) {
      ctx.report({
        id: "origins.list",
        severity: "info",
        message: `The site contacts ${origins.length} outside origin${origins.length === 1 ? "" : "s"}: ${origins.join(", ")}.`,
      });
    }
    for (const origin of unlistedOrigins(site, origins)) {
      ctx.report({
        id: "origins.unlisted",
        severity: "warning",
        message: `The site contacts ${origin}, which is not in \`analytics.allowedOrigins\`.`,
        help: `Add "${origin}" to \`analytics.allowedOrigins\` if it is intended, or remove the reference.`,
      });
    }
    return [];
  },
};
