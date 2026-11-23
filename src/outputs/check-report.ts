import type { Output } from "../contracts/output.ts";
import { underBase } from "./manifest.ts";

/** Publishes the same validated public report the theme renders. */
export const checkReport: Output = {
  name: "check-report",
  async run(site) {
    const report = site.checkReport;
    if (report === undefined) return [];
    const path = underBase(report.jsonUrl, site.config.base).slice(1);
    return [{ path, contents: `${JSON.stringify(report, null, 2)}\n` }];
  },
};
